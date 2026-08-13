/**
 * U2 approach step 3 — the 100-provision create-to-first-query benchmark,
 * against real Neon.
 *
 * **This never runs in the blocking tier.** It gates on `BRAINZ_REAL_SUBSTRATE`,
 * which only `.github/workflows/real-substrate.yml` sets, and that workflow sets
 * it alongside `NEON_API_KEY` in the same step. A fork PR runs `bun test` and
 * sees this reported as skipped, by name, which is the honest signal: nothing was
 * verified against a live project. Nothing at module scope reads a credential,
 * opens a socket or constructs a client, so importing this file in the blocking
 * suite costs a closure.
 *
 * **What it measures, exactly.** Project create → role and database create →
 * FTS language applied → first query answered through the tenant's own
 * connection string. That is the number that sizes U15's warm pool, and the
 * honest scope note is that it does **not** include U3's tenant schema, which
 * does not exist yet: U3 depends on U2, so the benchmark the plan puts in U2 is
 * necessarily the substrate half. Read the result as a floor on
 * create-to-first-query, not a ceiling on create-to-ready.
 *
 * **What it costs.** Every run creates a billable Neon project. The default is
 * deliberately small; `BRAINZ_BENCH_PROVISIONS=100` asks for the plan's full
 * sample and should be run knowingly, on an account that can take it. Every
 * project is deleted in the harness's teardown, and the run sweeps by name both
 * before and after — because `scripts/probes/r2-boundary/RESULT.md` learned the
 * expensive way that a probe's cleanup only runs if the probe finishes, and that
 * a killed run reports nothing at all. Verify against the vendor, not against the
 * run's own claim of success.
 *
 * The name space `brainz-bench-*` is reserved for this benchmark and is swept
 * without mercy. A real tenant would have to be called `bench-…` to collide.
 */

import { describe, expect, test } from 'bun:test';

import {
  formatBenchmarkReceipt,
  runProvisioningBenchmark,
  type ProvisionAttempt,
} from '../../src/control/benchmark.ts';
import { createNeonProjectApi } from '../../src/control/neon-api.ts';
import {
  createRandomBearerGrantMinter,
  FTS_LANGUAGE_PATTERN,
  neonProjectName,
  provisionTenant,
  TENANT_DATABASE_NAME,
  type ControlPlaneStore,
  type FirstQueryResult,
  type InsertOutcome,
  type NeonProjectApi,
  type TenantPatch,
  type TenantRecord,
  type TenantSchemaApplier,
} from '../../src/control/provision.ts';
import {
  createInMemorySecretBackend,
  createTenantSecretStore,
} from '../../src/control/secrets.ts';
import {
  createInMemoryCredentialMinter,
  createTenantStorage,
} from '../../src/control/storage.ts';

const live = (process.env['BRAINZ_REAL_SUBSTRATE'] ?? '') !== '';

// Say so. Bun counts a skipped test but does not always name it, and a suite
// that quietly reports one more green tick for a benchmark it did not run is the
// failure shape `.github/workflows/real-substrate.yml` exists to prevent.
if (!live) {
  console.info(
    '[real-substrate] skipped: U2 create-to-first-query benchmark. BRAINZ_REAL_SUBSTRATE is not set, so nothing in this run was measured against a live Neon project.',
  );
}

/** Reserved, and swept. Derived so the two can never drift apart. */
const BENCH_PROJECT_PREFIX = neonProjectName('bench-');

const DEFAULT_RUNS = 5;
const MAX_RUNS = 200;

/** The language is deliberately not English — KTD9's fallback must not pass. */
const BENCH_LANGUAGE = 'spanish';

/** How long a freshly created endpoint is given to answer. Part of the number. */
const FIRST_QUERY_TIMEOUT_MS = 120_000;
const FIRST_QUERY_RETRY_MS = 2_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required to run the real-substrate benchmark. This test is gated on BRAINZ_REAL_SUBSTRATE, which the scheduled workflow sets alongside the credential.`,
    );
  }
  return value;
}

function readRuns(): number {
  const raw = process.env['BRAINZ_BENCH_PROVISIONS'];
  if (raw === undefined || raw === '') return DEFAULT_RUNS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RUNS;
  return Math.min(parsed, MAX_RUNS);
}

/** Minimal, un-checked control-plane store: the row is bookkeeping here, not the
 * thing under measurement. `test/control/provision.test.ts` owns the constraint
 * behaviour, against a fake that enforces the schema's own CHECKs. */
function createMemoryStore(): ControlPlaneStore & { readonly rows: Map<string, TenantRecord> } {
  const rows = new Map<string, TenantRecord>();
  return {
    rows,
    get: (tenantId: string) => Promise.resolve(rows.get(tenantId)),
    insert: (record: TenantRecord): Promise<InsertOutcome> => {
      const existing = rows.get(record.tenantId);
      if (existing !== undefined) return Promise.resolve({ inserted: false, record: existing });
      rows.set(record.tenantId, record);
      return Promise.resolve({ inserted: true, record });
    },
    update: (tenantId: string, patch: TenantPatch) => {
      const existing = rows.get(tenantId);
      if (existing === undefined) throw new Error(`no row for ${tenantId}`);
      const next: TenantRecord = { ...existing, ...patch };
      rows.set(tenantId, next);
      return Promise.resolve(next);
    },
  };
}

/**
 * The benchmark's stand-in for U3's schema runner. It does the one thing the
 * measurement needs to be honest about — applies the tenant's FTS language
 * durably, then makes a *fresh session* report what the database actually has,
 * so a silent English fallback would fail here exactly as it fails in the unit
 * tests. U3 replaces this with the real tenant schema.
 */
function createBenchSchemaApplier(): TenantSchemaApplier {
  return {
    async apply({ connectionString, ftsLanguage }) {
      if (!FTS_LANGUAGE_PATTERN.test(ftsLanguage)) {
        throw new Error('bench applier: language is not a Postgres config name');
      }
      const sql = new Bun.SQL(connectionString);
      try {
        // Both interpolated values are module constants validated above, never
        // caller input. `ALTER DATABASE` is used rather than a session `SET`
        // precisely because the verification below opens a new connection.
        await sql.unsafe(
          `ALTER DATABASE "${TENANT_DATABASE_NAME}" SET default_text_search_config = '${ftsLanguage}'`,
        );
      } finally {
        await sql.close();
      }
      return { schemaVersion: 1 };
    },

    async verifyFirstQuery({ connectionString }): Promise<FirstQueryResult> {
      // A brand-new endpoint takes a moment to accept connections, and that wait
      // is part of create-to-first-query rather than an error.
      const deadline = Date.now() + FIRST_QUERY_TIMEOUT_MS;

      for (;;) {
        const sql = new Bun.SQL(connectionString);
        try {
          await sql.unsafe('SELECT 1');
          const rows = await sql.unsafe<{ default_text_search_config: string }[]>(
            'SHOW default_text_search_config',
          );
          const configured = rows[0]?.default_text_search_config ?? '';
          return { ok: true, ftsLanguage: configured.replace(/^pg_catalog\./, '') };
        } catch (error) {
          if (Date.now() >= deadline) {
            console.error('first query never answered:', String(error).slice(0, 200));
            return { ok: false };
          }
          await Bun.sleep(FIRST_QUERY_RETRY_MS);
        } finally {
          await sql.close().catch(() => undefined);
        }
      }
    },
  };
}

/** Deletes every project whose name starts with the reserved bench prefix. */
async function sweepBenchProjects(neon: NeonProjectApi): Promise<number> {
  const candidates = await neon.searchProjectsByName(BENCH_PROJECT_PREFIX);
  let deleted = 0;
  for (const candidate of candidates) {
    // `search` is a substring match; only a genuine prefix is ours to delete.
    if (!candidate.name.startsWith(BENCH_PROJECT_PREFIX)) continue;
    await neon.deleteProject(candidate.projectId);
    deleted += 1;
  }
  return deleted;
}

describe('U2 step 3 — create-to-first-query, against a live Neon account', () => {
  const runs = readRuns();

  test.skipIf(!live)(
    'measures create-to-first-query p50/p99 and leaves nothing behind',
    async () => {
      const apiKey = requireEnv('NEON_API_KEY');
      const regionId = process.env['NEON_REGION_ID'];
      const orgId = process.env['NEON_ORG_ID'];

      const neon = createNeonProjectApi({
        apiKey,
        ...(regionId === undefined || regionId === '' ? {} : { regionId }),
        ...(orgId === undefined || orgId === '' ? {} : { orgId }),
      });

      // Before anything: clear projects a killed run left behind. It reported
      // nothing, because it never got to report.
      const swept = await sweepBenchProjects(neon);
      if (swept > 0) console.warn(`swept ${swept} project(s) left by an earlier run`);

      const runId = Math.random().toString(36).slice(2, 8);
      const store = createMemoryStore();
      const secrets = createTenantSecretStore({ backend: createInMemorySecretBackend() });
      const storage = createTenantStorage({
        minter: createInMemoryCredentialMinter({
          parentAccessKeyId: 'bench-parent-key-id',
          parentSecretAccessKey: 'bench-parent-secret',
        }),
      });
      const deps = {
        neon,
        schema: createBenchSchemaApplier(),
        store,
        secrets,
        storage,
        bearer: createRandomBearerGrantMinter(),
      };

      const tenantIdFor = (index: number): string => `bench-${runId}-${index}`;

      const report = await runProvisioningBenchmark({
        runs,
        provision: async (index): Promise<ProvisionAttempt> => {
          const result = await provisionTenant(deps, {
            tenantId: tenantIdFor(index),
            ftsLanguage: BENCH_LANGUAGE,
          });
          return result.ok ? { ok: true } : { ok: false, failure: result.reason };
        },
        teardown: async (index) => {
          const projectId = store.rows.get(tenantIdFor(index))?.neonProjectId;
          if (projectId !== null && projectId !== undefined) {
            await neon.deleteProject(projectId);
            return;
          }
          // The id never got banked — the deterministic name is the only handle.
          const wanted = neonProjectName(tenantIdFor(index));
          for (const candidate of await neon.searchProjectsByName(wanted)) {
            if (candidate.name === wanted) await neon.deleteProject(candidate.projectId);
          }
        },
        onSample: (sample) => {
          console.log(
            `run ${sample.index}: ${sample.ok ? 'ok' : (sample.failure ?? 'failed')} in ${Math.round(sample.elapsedMs)} ms`,
          );
        },
      });

      const receipt = formatBenchmarkReceipt(report);
      console.log(receipt);

      const receiptPath = process.env['BRAINZ_BENCH_RECEIPT'];
      if (receiptPath !== undefined && receiptPath !== '') await Bun.write(receiptPath, receipt);

      // Verify against the vendor rather than against the harness's own claim.
      const leftovers = (await neon.searchProjectsByName(BENCH_PROJECT_PREFIX)).filter((project) =>
        project.name.startsWith(`${BENCH_PROJECT_PREFIX}${runId}-`),
      );
      if (leftovers.length > 0) await sweepBenchProjects(neon);

      expect(report.succeeded).toBeGreaterThan(0);
      expect(report.teardownFailures).toBe(0);
      expect(leftovers).toEqual([]);
    },
    runs * 240_000 + 120_000,
  );
});
