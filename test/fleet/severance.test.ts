/**
 * A user disconnects a work account, through the process, and the rows go.
 *
 * **What this is defending.** `src/core/lifecycle/severance.ts:severOrigin` had
 * exactly one caller in the repository — its own test. `src/web/app.ts` declares
 * a `SeverancePort` and routes `/api/severance` and `/api/severance/preview`
 * through it, and `src/web/serve.ts` never supplied one, so both routes answered
 * `501 unavailable` in every deployment. The executor was correct, tested, and
 * bound to nothing: a user could read a blast-radius preview nowhere and sever
 * nothing.
 *
 * **It is driven against the spawned entrypoint, not `createWebApp`.** A test
 * that composes the app in memory and hands it a fake port proves the handler
 * calls a port; it cannot prove a deployed process has one wired — which is the
 * whole of the defect. So the effects are read from the *tenant's own database*
 * afterwards: `page.deleted_at`, the `severance` audit row, the discarded
 * `control.job`. What passes is what the process did.
 *
 * **The fixture is a brain with a mixed-origin half**, for the reason
 * `test/core/lifecycle/severance.test.ts` opens with: a severance over a brain
 * whose rows all carry one origin satisfies every assertion below while proving
 * none of them. Here the mixed fact is what proves the wired port runs the
 * *executor* rather than a delete somebody wrote at the seam.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { poolNamespace } from '../../src/control/secrets.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import { createJobQueue } from '../../src/worker/queue.ts';
import { createControlPlane, dropControlPlane, type ControlFixture } from '../worker/fixture.ts';
import {
  createIdentityStore,
  dropIdentityStore,
  type IdentityFixture,
} from '../control/identity-fixture.ts';
import { createEmptyDatabase, dropFixtureDatabase, type SchemaFixture } from '../schema/fixture.ts';
import {
  FAKE_CF_ACCOUNT_ID,
  startService,
  writeSecretsFile,
  type RunningService,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const WEB_ORIGIN = 'https://app.brainz.test';
const POOL_ID = 'pool-0000000000000002';

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

let control: ControlFixture;
let identity: IdentityFixture;
let poolProject: SchemaFixture;
let controlSql: SQL;
let identitySql: SQL;
let tenantSql: SQL;
let scratch: string;
let secretsFile: string;
let web: RunningService;

let cookie = '';
let tenantId = '';

const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

beforeAll(async () => {
  control = await createControlPlane('severflow');
  identity = await createIdentityStore('severflow');
  poolProject = await createEmptyDatabase('severpool');
  controlSql = new SQL(control.dsn, { max: 2 });
  identitySql = new SQL(identity.dsn, { max: 2 });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-severance-'));
  secretsFile = join(scratch, 'secrets.json');

  web = await startService({
    entry: 'src/web/serve.ts',
    env: {
      BRAINZ_WEB_ORIGIN: WEB_ORIGIN,
      BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
      BRAINZ_CONTROL_DATABASE_URL: control.dsn,
      BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
      BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
      BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
      BRAINZ_POOL_TARGET: '1',
    },
  });

  // A `ready` pool project and its connection string, the way a filler leaves
  // one. This is the only path that provisions without a vendor credential.
  await controlSql`
    INSERT INTO control.pool_project (
      pool_id, state, neon_project_id, neon_branch_id, neon_database, neon_role,
      connection_secret_ref, created_at, ready_at
    ) VALUES (
      ${POOL_ID}, 'ready', 'proj-sever-1', 'br-sever-1', 'brainz', 'brainz_owner',
      ${poolNamespace(POOL_ID)}, now(), now()
    )`;
  await writeSecretsFile(secretsFile, {
    secrets: { [poolNamespace(POOL_ID)]: { connectionString: poolProject.dsn, bearerGrant: '' } },
  });

  const signup = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({
      email: 'severing@example.com',
      password: 'correct horse battery staple',
      fts_language: 'spanish',
    }),
  });
  if (signup.status !== 201) {
    throw new Error(`the signup this suite is built on failed: ${signup.status} ${await signup.text()}`);
  }
  cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const tenants = (await controlSql`SELECT tenant_id FROM control.tenant`) as Array<{ tenant_id: string }>;
  tenantId = tenants[0]?.tenant_id ?? '';

  tenantSql = new SQL(poolProject.dsn, { max: 2 });
  await seedBrain();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await web?.stop();
  await tenantSql?.close();
  await controlSql?.close();
  await identitySql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (poolProject !== undefined) await dropFixtureDatabase(poolProject);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/**
 * Two credentials' worth of content, and one row derived from both.
 *
 * The mixed fact is the point: R15 says a derived row carries the union of its
 * inputs' origins, so it must SURVIVE a severance of one of them. A seam that
 * deleted by overlap rather than running the executor takes it, and the
 * assertion below is the only thing that can tell.
 */
async function seedBrain(): Promise<void> {
  await tenantSql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                      embedding_dimensions, chunker_version, normalizer_version, content_sha256)
    VALUES ('${WORK}', 'email', 'The platform migration', 'gmail:w1',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${PERSONAL}', 'email', 'The flight home', 'gmail:p1',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));

    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${WORK}', 'the migration lands on the twelfth', page_id, 0
      FROM page WHERE external_ref = 'gmail:w1';
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${PERSONAL}', 'the flight home is on the fourteenth', page_id, 0
      FROM page WHERE external_ref = 'gmail:p1';

    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'the migration owner is the platform team', ${EMBEDDING}, ARRAY['${WORK}'], page_id
      FROM page WHERE external_ref = 'gmail:w1';

    -- Mixed. Survives, and is wrong until something re-derives it.
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'the migration lands the day before the flight home', ${EMBEDDING},
           ARRAY['${WORK}', '${PERSONAL}'], page_id
      FROM page WHERE external_ref = 'gmail:p1';
  `);
}

interface Census {
  readonly live_work_pages: number;
  readonly live_personal_pages: number;
  readonly live_mixed_facts: number;
  readonly live_work_facts: number;
}

async function census(): Promise<Census> {
  const rows = (await tenantSql`
    SELECT
      (SELECT count(*)::int FROM page
        WHERE origin_context = ${WORK} AND deleted_at IS NULL) AS live_work_pages,
      (SELECT count(*)::int FROM page
        WHERE origin_context = ${PERSONAL} AND deleted_at IS NULL) AS live_personal_pages,
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL AND origin_contexts @> ARRAY[${WORK}]::text[]
          AND NOT (origin_contexts <@ ARRAY[${WORK}]::text[])) AS live_mixed_facts,
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL AND origin_contexts <@ ARRAY[${WORK}]::text[]) AS live_work_facts
  `) as Array<Census>;
  return rows[0] as Census;
}

// ---------------------------------------------------------------------------
// 0. The fixture. A severance test over a brain with no mixed rows proves nothing.
// ---------------------------------------------------------------------------

describe('the brain this suite severs from', () => {
  test(
    'holds work rows, personal rows AND a row derived from both',
    async () => {
      const before = await census();
      expect(before.live_work_pages).toBeGreaterThan(0);
      expect(before.live_personal_pages).toBeGreaterThan(0);
      expect(before.live_work_facts).toBeGreaterThan(0);
      // The one that makes every later assertion mean something.
      expect(before.live_mixed_facts).toBeGreaterThan(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 1. The preview. A read, and the two columns U17 built.
// ---------------------------------------------------------------------------

describe('the preview route reaches the tenant database', () => {
  test(
    'it answers both columns for a real origin, not `unavailable`',
    async () => {
      const response = await fetch(
        `${web.url}/api/severance/preview?origin=${encodeURIComponent(WORK)}`,
        { headers: { cookie } },
      );
      const body = (await response.json()) as {
        ok: boolean;
        removed: Record<string, number>;
        recomputed: Record<string, number>;
        recompute_required: boolean;
        surviving_origins: readonly string[];
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      // Column one: what goes.
      expect(body.removed['pages']).toBe(1);
      expect(body.removed['facts']).toBe(1);
      // Column two: what survives and is now wrong. A preview that counted only
      // deletions is the one a user cannot weigh.
      expect(body.recomputed['facts']).toBe(1);
      expect(body.recompute_required).toBe(true);
      expect(body.surviving_origins).toContain(PERSONAL);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'and it is a preview: nothing moved',
    async () => {
      const after = await census();
      expect(after.live_work_pages).toBe(1);
      expect(after.live_work_facts).toBe(1);
      expect(after.live_mixed_facts).toBe(1);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The execution.
// ---------------------------------------------------------------------------

describe('the execute route severs the origin', () => {
  test(
    'a confirmation that is not an echo of the origin is refused before anything runs',
    async () => {
      const response = await fetch(`${web.url}/api/severance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ origin: WORK, confirm: 'yes' }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('not_confirmed');
      expect((await census()).live_work_pages).toBe(1);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the exactly-work rows are tombstoned, the mixed row survives, and an audit row is written',
    async () => {
      // An open connector poll for this tenant. Severance has to stop it, or the
      // next worker re-imports what was just severed, on a cadence.
      const queue = createJobQueue({ sql: controlSql });
      const enqueued = await queue.enqueue({
        tenantId,
        kind: 'ingest_pull',
        target: 'gmail',
        trigger: 'connector_cadence',
        now: new Date(),
      });
      expect(enqueued.enqueued).toBe(true);

      const response = await fetch(`${web.url}/api/severance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ origin: WORK, confirm: WORK }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        severance_id: string;
        already_severed: boolean;
        polling_stopped: number;
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.severance_id.length).toBeGreaterThan(0);
      expect(body.already_severed).toBe(false);

      const after = await census();
      expect(after.live_work_pages).toBe(0);
      expect(after.live_work_facts).toBe(0);
      // R15's whole point: the work account does not own the shared row.
      expect(after.live_mixed_facts).toBe(1);
      expect(after.live_personal_pages).toBe(1);

      // The receipt, in the tenant's own database rather than in the response —
      // rung 10 exists so a severance is discoverable after the request is gone.
      const audit = (await tenantSql`
        SELECT origin_context, removed, recomputed, surviving_origins FROM severance
      `) as Array<{
        origin_context: string;
        removed: Record<string, number>;
        recomputed: Record<string, number>;
        surviving_origins: string[];
      }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.origin_context).toBe(WORK);
      // Read as a field, not as a string: a `JSON.stringify` into a `::jsonb`
      // cast stores a jsonb string scalar, and this is where that would show.
      expect(audit[0]?.removed['pages']).toBe(1);
      expect(audit[0]?.recomputed['facts']).toBe(1);
      expect(audit[0]?.surviving_origins).toContain(PERSONAL);

      // The cadence, stopped.
      expect(body.polling_stopped).toBe(1);
      const jobs = (await controlSql`
        SELECT state::text AS state FROM control.job WHERE tenant_id = ${tenantId}
      `) as Array<{ state: string }>;
      expect(jobs.map((row) => row.state)).toEqual(['discarded']);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'severing it again is a no-op that says so rather than pretending it worked',
    async () => {
      const response = await fetch(`${web.url}/api/severance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ origin: WORK, confirm: WORK }),
      });
      const body = (await response.json()) as { ok: boolean; already_severed: boolean };
      expect(response.status).toBe(200);
      expect(body.already_severed).toBe(true);
      // Still recorded — a second severance is an event, and hiding it would
      // make the audit trail a description of what somebody expected.
      const audit = (await tenantSql`SELECT severance_id FROM severance`) as Array<unknown>;
      expect(audit).toHaveLength(2);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'an origin no credential could have granted is refused, and writes no audit row',
    async () => {
      const response = await fetch(`${web.url}/api/severance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ origin: 'nonsense', confirm: 'nonsense' }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('unknown_origin');
      const audit = (await tenantSql`SELECT severance_id FROM severance`) as Array<unknown>;
      expect(audit).toHaveLength(2);
    },
    SETUP_TIMEOUT_MS,
  );
});
