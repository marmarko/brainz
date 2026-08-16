/**
 * A correspondent asks to be erased, and the running system can answer them.
 *
 * **What this is defending.** `src/core/lifecycle/subject-erasure.ts` is
 * complete — it resolves a correspondent through the entity graph and through
 * the identifier as text, names every row it will take, sweeps the residue
 * classes the 72h purge cannot reach, and writes the re-ingestion tombstone —
 * and `eraseSubject` and `previewSubjectErasure` were imported by their own test
 * and by nothing else in `src/`. `src/web/app.ts` declares a
 * `SubjectErasurePort` and routes `/api/subject-erasure` and its preview through
 * it; `src/web/serve.ts` supplied a `severance` port and no `subjectErasure`, so
 * both routes answered `501 unavailable` in every deployment. R12's third
 * property is that erasure is **invocable by the controlling user, out of
 * band** — and there was no out of band. A data subject could ask, and the only
 * way to answer them was to run a test harness against somebody's brain.
 *
 * **It is driven against the spawned entrypoint, not `createWebApp`.**
 * `test/web/subject-erasure-route.test.ts` composes the app in memory and hands
 * it a fake port: that proves the handler calls a port, checks the echo before
 * reaching it, and refuses a stranger. It cannot prove a deployed process has
 * one wired, which is the whole of this defect. So the effects here are read out
 * of the **tenant's own database** afterwards — `page.deleted_at`, the deleted
 * fact, the hard-deleted proposal, the `erased_subject` row — and what passes is
 * what the process did.
 *
 * **The brain holds somebody else's mail too**, for the reason
 * `test/fleet/severance.test.ts` opens with: an erasure over a brain that
 * contains nothing but the subject satisfies every assertion below while proving
 * none of them. The surviving page is what separates "erased the correspondent"
 * from "emptied the brain".
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { poolNamespace } from '../../src/control/secrets.ts';
import { PITR_WINDOW_DAYS } from '../../src/core/lifecycle/erasure.ts';
import { subjectDigest } from '../../src/core/lifecycle/subject-erasure.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
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
import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';

/** The column a seeded vector goes in — the active seat's, so a fixture
 * cannot outlive the column production writes. */
const SEAT_COLUMN = ACTIVE_EMBEDDING_SEAT.column;

const SETUP_TIMEOUT_MS = 180_000;
const WEB_ORIGIN = 'https://app.brainz.test';
const POOL_ID = 'pool-0000000000000003';

const ORIGIN_CONTEXT = 'personal:mail';
/** A correspondent, not the account holder. That axis is the point of R12's second half. */
const SUBJECT = 'charlie-example@example.com';

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

const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

beforeAll(async () => {
  control = await createControlPlane('erasureflow');
  identity = await createIdentityStore('erasureflow');
  poolProject = await createEmptyDatabase('erasurepool');
  controlSql = new SQL(control.dsn, { max: 2 });
  identitySql = new SQL(identity.dsn, { max: 2 });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-subject-erasure-'));
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
  // one. The only path that provisions without a vendor credential.
  await controlSql`
    INSERT INTO control.pool_project (
      pool_id, state, neon_project_id, neon_branch_id, neon_database, neon_role,
      connection_secret_ref, created_at, ready_at
    ) VALUES (
      ${POOL_ID}, 'ready', 'proj-erasure-1', 'br-erasure-1', 'brainz', 'brainz_owner',
      ${poolNamespace(POOL_ID)}, now(), now()
    )`;
  await writeSecretsFile(secretsFile, {
    secrets: { [poolNamespace(POOL_ID)]: { connectionString: poolProject.dsn, bearerGrant: '' } },
  });

  const signup = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({
      email: 'controller@example.com',
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  });
  if (signup.status !== 201) {
    throw new Error(`the signup this suite is built on failed: ${signup.status} ${await signup.text()}`);
  }
  cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

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
 * Her mail, and somebody else's.
 *
 * The page that names her does so **in its body only**, which is the ordinary
 * shape: a subject line rarely spells an address. So page discovery has to reach
 * through the chunk, and a seam that matched titles would find nothing. The
 * proposal in `review_queue` is the residue class with no foreign key — nothing
 * else in the system will ever sweep it — and the second page is what makes
 * "erased the correspondent" distinguishable from "emptied the brain".
 */
async function seedBrain(): Promise<void> {
  await tenantSql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                      embedding_dimensions, chunker_version, normalizer_version, content_sha256)
    VALUES ('${ORIGIN_CONTEXT}', 'email', 'the lease renewal', 'gmail:c1',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${ORIGIN_CONTEXT}', 'email', 'the flight home', 'gmail:p1',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));

    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${ORIGIN_CONTEXT}', '${SUBJECT} asked whether the lease renews in March',
           page_id, 0
      FROM page WHERE external_ref = 'gmail:c1';
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${ORIGIN_CONTEXT}', 'the flight home is on the fourteenth', page_id, 0
      FROM page WHERE external_ref = 'gmail:p1';

    INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
    SELECT '${SUBJECT} wants the lease renewed', ${EMBEDDING}, ARRAY['${ORIGIN_CONTEXT}'], page_id
      FROM page WHERE external_ref = 'gmail:c1';

    -- Somebody else's. Survives, or this was not an erasure of a correspondent.
    INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
    SELECT 'the flight home lands on the fourteenth', ${EMBEDDING}, ARRAY['${ORIGIN_CONTEXT}'], page_id
      FROM page WHERE external_ref = 'gmail:p1';

    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('Charlie Example', 'person', ARRAY['${ORIGIN_CONTEXT}']);

    INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
    SELECT entity_id, '${SUBJECT}', 'user', ARRAY['${ORIGIN_CONTEXT}']
      FROM entity WHERE canonical_name = 'Charlie Example';

    -- The class with no foreign key: an unreviewed proposal quoting her, which
    -- outlives everything it refers to and which nothing else sweeps.
    INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts)
    SELECT 'entity_merge', 'entity:' || entity_id::text,
           'merge ${SUBJECT} with the lease contact', 0.4, ARRAY['${ORIGIN_CONTEXT}']
      FROM entity WHERE canonical_name = 'Charlie Example';
  `);
}

interface Census {
  readonly live_subject_pages: number;
  readonly live_other_pages: number;
  readonly live_subject_facts: number;
  readonly live_other_facts: number;
  readonly live_entities: number;
  readonly proposals: number;
  readonly tombstones: number;
}

async function census(): Promise<Census> {
  const rows = (await tenantSql`
    SELECT
      (SELECT count(*)::int FROM page
        WHERE external_ref = 'gmail:c1' AND deleted_at IS NULL) AS live_subject_pages,
      (SELECT count(*)::int FROM page
        WHERE external_ref = 'gmail:p1' AND deleted_at IS NULL) AS live_other_pages,
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL AND statement LIKE ${`%${SUBJECT}%`}) AS live_subject_facts,
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL AND statement NOT LIKE ${`%${SUBJECT}%`}) AS live_other_facts,
      (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL) AS live_entities,
      (SELECT count(*)::int FROM review_queue) AS proposals,
      (SELECT count(*)::int FROM erased_subject) AS tombstones
  `) as Array<Census>;
  return rows[0] as Census;
}

// ---------------------------------------------------------------------------
// 0. The fixture. An erasure test over a brain holding only the subject proves
//    nothing about what it left alone.
// ---------------------------------------------------------------------------

describe('the brain this suite erases from', () => {
  test(
    'holds her mail AND somebody else’s, plus the proposal nothing else sweeps',
    async () => {
      expect(await census()).toEqual({
        live_subject_pages: 1,
        live_other_pages: 1,
        live_subject_facts: 1,
        live_other_facts: 1,
        live_entities: 1,
        proposals: 1,
        tombstones: 0,
      });
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 1. The preview. The module's stated mitigation is this flow, so it has to
//    reach a real brain and name real rows.
// ---------------------------------------------------------------------------

describe('the preview route reaches the tenant database', () => {
  test(
    'it names every surface form and every row, not `unavailable`',
    async () => {
      const response = await fetch(
        `${web.url}/api/subject-erasure/preview?identifier=${encodeURIComponent(SUBJECT)}`,
        { headers: { cookie } },
      );
      const body = (await response.json()) as {
        ok: boolean;
        subject_digest: string;
        entity_ids: readonly string[];
        surface_forms: readonly string[];
        pages: readonly { pageId: string; handle: string }[];
        rows: readonly { kind: string; excerpt: string; handle: string }[];
        removed: Record<string, number>;
        recompute_required: boolean;
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      // Resolved through the entity graph, not merely through the string.
      expect(body.entity_ids).toHaveLength(1);
      // Every spelling the sweep will match on — the identifier, the entity's
      // canonical name, and its aliases — so the widest thing it can reach is
      // visible before it reaches it.
      expect([...body.surface_forms].sort()).toEqual([SUBJECT, 'Charlie Example'].sort());
      // Discovered through the chunk: her page's title does not name her.
      expect(body.pages).toEqual([{ pageId: expect.any(String), handle: 'text' }]);
      // Named rows rather than a count nobody can inspect — the module's own
      // mitigation for a sweep that matches inferred aliases.
      expect([...body.rows].map((row) => row.kind).sort()).toEqual(['fact', 'review_queue']);
      expect(body.rows.some((row) => row.excerpt.includes(SUBJECT))).toBe(true);
      expect(body.removed['pages']).toBe(1);
      expect(body.removed['entities']).toBe(1);
      expect(body.removed['reviewQueue']).toBe(1);
      // The digest is computed by the module, over the normalised identifier.
      expect(body.subject_digest).toBe(subjectDigest(SUBJECT));
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'and it is a preview: nothing moved',
    async () => {
      const after = await census();
      expect(after.live_subject_pages).toBe(1);
      expect(after.live_subject_facts).toBe(1);
      expect(after.proposals).toBe(1);
      expect(after.tombstones).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The execution.
// ---------------------------------------------------------------------------

describe('the execute route erases the correspondent', () => {
  test(
    'a confirmation that is not an exact echo of the identifier erases nothing',
    async () => {
      for (const confirm of ['yes', '', SUBJECT.toUpperCase()]) {
        const response = await fetch(`${web.url}/api/subject-erasure`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
          body: JSON.stringify({ identifier: SUBJECT, confirm }),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as { code: string }).code).toBe('not_confirmed');
      }
      // The load-bearing assertion, read from the brain rather than from a spy:
      // a route or a port that checked the echo after acting would satisfy every
      // status assertion above and would already have erased her.
      const after = await census();
      expect(after.live_subject_pages).toBe(1);
      expect(after.tombstones).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'her rows go, the other correspondent’s stay, and the receipt names the tombstone',
    async () => {
      const response = await fetch(`${web.url}/api/subject-erasure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ identifier: SUBJECT, confirm: SUBJECT }),
      });
      const raw = await response.text();
      const body = JSON.parse(raw) as {
        ok: boolean;
        subject_digest: string;
        removed: Record<string, number>;
        reingestion_tombstoned: boolean;
        raw_objects_removed: number;
        raw_objects_unreachable: number;
        attachment_objects_unreachable: number;
        unrecoverable_after_days: number;
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      // The digest, never the address: a receipt for an erasure must not be the
      // one place the identifier survives.
      expect(body.subject_digest).toBe(subjectDigest(SUBJECT));
      expect(raw).not.toContain(SUBJECT);
      // The property U15's determination flags as most likely to be missed, and
      // the bound a data-subject answer has to quote.
      expect(body.reingestion_tombstoned).toBe(true);
      expect(body.unrecoverable_after_days).toBe(PITR_WINDOW_DAYS);
      // This deployment has no object store and no raw-key deriver, so the
      // objects are reported UNREACHABLE rather than rounded down to zero. An
      // erasure answer that silently omitted them would be the false half of a
      // true receipt.
      expect(body.raw_objects_removed).toBe(0);
      expect(body.raw_objects_unreachable).toBe(1);
      expect(body.attachment_objects_unreachable).toBe(0);

      const after = await census();
      expect(after.live_subject_pages).toBe(0);
      expect(after.live_subject_facts).toBe(0);
      expect(after.live_entities).toBe(0);
      // Hard-deleted, not tombstoned: `review_queue` has no foreign key and the
      // 72h purge cannot reach it, so a soft delete there sits verbatim forever.
      expect(after.proposals).toBe(0);
      // Somebody else's mail, untouched. This is not a purge of the brain.
      expect(after.live_other_pages).toBe(1);
      expect(after.live_other_facts).toBe(1);

      // The suppression row, in the tenant's own database — the half that stops
      // the next connector poll undoing the erasure on a cadence.
      const tombstone = (await tenantSql`
        SELECT subject_digest, erased_by, pages_removed FROM erased_subject
      `) as Array<{ subject_digest: string; erased_by: string; pages_removed: number }>;
      expect(tombstone).toHaveLength(1);
      expect(tombstone[0]?.subject_digest).toBe(subjectDigest(SUBJECT));
      // The authorising channel, recorded. `agent_mcp` is not a value this
      // column admits, and this route is why refusing that tool stays honest.
      expect(tombstone[0]?.erased_by).toBe('app');
      expect(tombstone[0]?.pages_removed).toBe(1);
    },
    SETUP_TIMEOUT_MS,
  );
});
