/**
 * The undo, end to end — and the one request it must refuse while cheerfully
 * being able to perform it.
 *
 * ============================================================================
 * WHY THE MOST IMPORTANT TEST HERE IS A REFUSAL
 * ============================================================================
 *
 * Keeping subject-erasure instants out of the *listing* closes the half a user
 * can see. `POST /api/restore` takes a raw instant in a form field, and an
 * erasure instant is an ordinary readable timestamp: it appears in
 * `erased_subject.erased_at`, it is on every row the erasure tombstoned, and a
 * hand-rolled POST carrying one reaches the executor. `restoreForgotten` would
 * then un-delete rows across all seven tombstoned tables and return **nonzero**
 * counts — while `erased_subject`'s suppression row is still live and
 * `page_version`, `review_queue` and `entity_edge` are still hard-deleted. The
 * route would render a receipt for a recovery that did not happen, on behalf of
 * a request a third party made about their own data.
 *
 * That is the class `src/web/serve.ts` condemns in writing — "a destructive
 * operation that cannot be performed is a smaller problem than one that lies" —
 * arriving through the safe direction. So ledger membership gates the executor,
 * and the case below proves the gate by first proving the hazard: it asserts the
 * erasure's tombstones are there and that the raw executor **does** bring them
 * back, then asserts the port refuses the same instant.
 *
 * ============================================================================
 * TWO HALVES, AND WHY BOTH
 * ============================================================================
 *
 * The routing half drives the real handler with a fake port, the way
 * `subject-erasure-route.test.ts` does, because 501/401/403/400 are properties
 * of the router and a test that called the port underneath would assert none of
 * them. The composition half drives the **real** `retractionPort` against a real
 * schema with a `TenantWork` that hands back the fixture connection, because the
 * gate is the arrangement — find, then restore, then bookkeep — and a fake would
 * be a test of the test's own arrangement.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { attachBrain } from '../../src/control/accounts.ts';
import { eraseSubject } from '../../src/core/lifecycle/subject-erasure.ts';
import { severOrigin } from '../../src/core/lifecycle/severance.ts';
import { FORGET_TTL_HOURS, forgetRecord, restoreForgotten } from '../../src/mcp/tombstone.ts';
import {
  SESSION_COOKIE,
  createWebApp,
  readCookie,
  restoreMessage,
  type RetractionPort,
} from '../../src/web/app.ts';
import { retractionPort } from '../../src/web/serve.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import {
  connect as connectIdentity,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from '../control/identity-fixture.ts';

const ORIGIN = 'https://app.brainz.example';
const AT = new Date('2026-08-16T09:00:00.000Z');
const TENANT = 'restore-route-alice';
const WORK = 'work:mail';
const PERSONAL = 'personal:mail';
const HOUR = 3600_000;
/** A correspondent, not the account holder. */
const SUBJECT = 'charlie-example@example.com';

let identity: IdentityFixture;
let control: ControlFixture;
let schema: SchemaFixture;
let sql: SQL;
let controlSql: SQL;
let brainSql: SQL;

/** What the fake port was asked. A refusal that reached it is a failure here. */
let asked: { lists: unknown[]; restores: unknown[] };

const LISTED = {
  deletedAt: AT.toISOString(),
  restorableUntil: new Date(AT.getTime() + FORGET_TTL_HOURS * HOUR).toISOString(),
  kind: 'record' as const,
  origins: [WORK],
  targetKind: 'doc',
  counts: { pages: 1, chunks: 2, facts: 1, entities: 0 },
};

type RestoreResult = Awaited<ReturnType<RetractionPort['restore']>>;

function fakePort(options: { readonly answer?: RestoreResult } = {}): RetractionPort {
  return {
    list(request) {
      asked.lists.push({ ...request });
      return Promise.resolve({ retractions: [LISTED], overflowed: false, ttlHours: FORGET_TTL_HOURS });
    },
    restore(request) {
      asked.restores.push({ ...request });
      return Promise.resolve(
        options.answer ?? {
          ok: true as const,
          restored: { pages: 1, chunks: 2, facts: 1, entities: 0, entityCards: 0, commitments: 0, attachments: 0 },
          unarchived: { aliases: 0 },
          supersededCards: 0,
          supersededAliases: 0,
          wasOrigin: false,
          alreadyRestored: false,
          restorableUntil: LISTED.restorableUntil,
        },
      );
    },
  };
}

function app(options: { readonly wired?: boolean; readonly answer?: RestoreResult } = {}) {
  return createWebApp({
    sql,
    controlSql,
    origin: ORIGIN,
    mcpUrl: 'https://mcp.brainz.example/mcp',
    stripeWebhookSecret: 'whsec_invented_here',
    now: () => AT,
    hash: TEST_HASH_COST,
    provisioner: {
      provision: () => Promise.resolve({ ok: true as const, tenantId: TENANT, via: 'synchronous' as const }),
    },
    byok: { put: () => Promise.resolve({ ok: true }), revoke: () => Promise.resolve({ ok: true }) },
    // Absent when `wired: false`, so the "no port" branch is a state a test can
    // reach rather than a comment.
    ...(options.wired === false
      ? {}
      : { retractions: fakePort(options.answer === undefined ? {} : { answer: options.answer }) }),
  });
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(
  path: string,
  fields: unknown,
  options: { readonly cookie?: string; readonly origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.origin !== null) headers['origin'] = options.origin ?? ORIGIN;
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(fields) });
}

async function signedIn(options: { readonly withBrain?: boolean } = {}): Promise<string> {
  const handle = app();
  const created = await handle(
    post('/api/signup', {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  );
  const header = created.headers.get('set-cookie') ?? '';
  const token = readCookie(header.split(';')[0] ?? '', SESSION_COOKIE) ?? '';
  const body = (await created.json()) as { account_id: string };

  if (options.withBrain === false) {
    await sql`DELETE FROM account.brain WHERE account_id = ${body.account_id}::account.account_id`;
  } else {
    await seedTenant(controlSql, TENANT);
    await attachBrain(sql, { accountId: body.account_id, tenantId: TENANT, ftsLanguage: 'simple', now: AT });
  }
  return `${SESSION_COOKIE}=${token}`;
}

beforeAll(async () => {
  identity = await createIdentityStore('restoreroute');
  control = await createControlPlane('restoreroute');
  schema = await provisionFixture('restoreroute');
  sql = connectIdentity(identity);
  controlSql = connectControl(control);
  brainSql = connectTenant(schema);
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await controlSql?.close();
  await brainSql?.close();
  if (identity !== undefined) await dropIdentityStore(identity);
  if (control !== undefined) await dropControlPlane(control);
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

beforeEach(async () => {
  await sql`DELETE FROM account.account`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  asked = { lists: [], restores: [] };
  await brainSql.unsafe(`
    DELETE FROM retraction;
    DELETE FROM severance;
    DELETE FROM erased_subject;
    DELETE FROM severed_alias;
    DELETE FROM page_version;
    DELETE FROM review_queue;
    DELETE FROM commitment;
    DELETE FROM attachment;
    DELETE FROM entity_card;
    UPDATE fact SET superseded_by = NULL;
    DELETE FROM fact;
    DELETE FROM chunk;
    DELETE FROM page;
    DELETE FROM entity;
  `);
});

// ---------------------------------------------------------------------------
// 1. The surface is reachable. This is the whole point of the change.
// ---------------------------------------------------------------------------

describe('the 72-hour window is reachable', () => {
  test('a signed-in user can read what they may undo', async () => {
    const cookie = await signedIn();
    const response = await app()(get('/api/retractions', cookie));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.ttl_hours).toBe(FORGET_TTL_HOURS);
    expect(body.retractions).toEqual([
      {
        deleted_at: LISTED.deletedAt,
        restorable_until: LISTED.restorableUntil,
        kind: 'record',
        origins: [WORK],
        target_kind: 'doc',
        counts: LISTED.counts,
      },
    ]);
    expect(asked.lists).toEqual([{ tenantId: TENANT }]);
  });

  test('and the page names it, with the instant carried as the echo', async () => {
    const cookie = await signedIn();
    const response = await app()(get('/retractions', cookie));

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('action="/api/restore"');
    // The hidden field is what makes the echo an identity check rather than a
    // retyping exercise: the instant is the one parameter where a typo produces
    // another valid key.
    expect(page).toContain(`name="confirm" value="${LISTED.deletedAt}"`);
    expect(page).toContain('a document');
    // Shape, never substance.
    expect(page).not.toContain('statement');
  });

  test('and can put one back, and is told what came back', async () => {
    const cookie = await signedIn();
    const response = await app()(
      post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt }, { cookie }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.restored).toMatchObject({ pages: 1, chunks: 2, facts: 1 });
    // The two "came back short" numbers travel: a receipt reporting pages while
    // cards stayed deleted would re-open the partial-success lie one layer up.
    expect(body.superseded_cards).toBe(0);
    expect(body.superseded_aliases).toBe(0);
    expect(asked.restores).toEqual([
      { tenantId: TENANT, deletedAt: LISTED.deletedAt, confirm: LISTED.deletedAt },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. The routing refusals, each of which must not reach the port.
// ---------------------------------------------------------------------------

describe('what the route refuses, and how loudly', () => {
  test('an unwired port answers 501 rather than pretending', async () => {
    const cookie = await signedIn();
    const listing = await app({ wired: false })(get('/api/retractions', cookie));
    expect(listing.status).toBe(501);
    const restore = await app({ wired: false })(
      post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt }, { cookie }),
    );
    expect(restore.status).toBe(501);
  });

  test('a mismatched echo is refused before the port is reached', async () => {
    const cookie = await signedIn();
    const response = await app()(
      post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: '2026-08-16T09:00:00.001Z' }, { cookie }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).code).toBe('not_confirmed');
    // The assertion that matters: a route checking the echo *after* calling the
    // port would pass a status-code-only test and have restored first.
    expect(asked.restores).toEqual([]);
  });

  test('no session, no listing and no restore', async () => {
    expect((await app()(get('/api/retractions'))).status).toBe(401);
    expect(
      (await app()(post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt })))
        .status,
    ).toBe(401);
    expect(asked.lists).toEqual([]);
    expect(asked.restores).toEqual([]);
  });

  test('a cross-site POST is refused before anything else', async () => {
    const cookie = await signedIn();
    const response = await app()(
      post(
        '/api/restore',
        { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt },
        { cookie, origin: 'https://elsewhere.example' },
      ),
    );
    expect(response.status).toBe(403);
    expect(asked.restores).toEqual([]);
  });

  test('an account with no brain gets 409 rather than a namespace lookup', async () => {
    const cookie = await signedIn({ withBrain: false });
    expect((await app()(get('/api/retractions', cookie))).status).toBe(409);
    expect(asked.lists).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The three outcomes, rendered.
// ---------------------------------------------------------------------------

describe('the refusals say the true thing', () => {
  test('an instant that is not a retraction of theirs is 404', async () => {
    const cookie = await signedIn();
    const response = await app({ answer: { ok: false, reason: 'not_found' } })(
      post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt }, { cookie }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.message).toBe('No retraction of yours at that instant.');
  });

  test('a closed window is 410, and says only what is true at every point', async () => {
    const cookie = await signedIn();
    const closed = LISTED.restorableUntil;
    const response = await app({ answer: { ok: false, reason: 'ttl_expired', closedAt: closed } })(
      post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt }, { cookie }),
    );

    // 410 rather than 400 or 404: "it was here, it is not, and it will not be
    // back".
    expect(response.status).toBe(410);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.message).toBe(
      `The 72-hour window for this retraction closed at ${closed}. It can no longer be restored.`,
    );
    // The three tempting alternatives, each refused for its own reason: a
    // hedge the user cannot resolve; a back door that does not exist; and a
    // claim that is FALSE for up to a day, because the purge's grace band keeps
    // the rows past the TTL. The band itself is not mentioned either — a number
    // nobody can act on but anybody can appeal to turns a closed window into a
    // support ticket.
    const message = String(body.message);
    expect(message).not.toContain('may have been');
    expect(message).not.toContain('support');
    expect(message).not.toContain('gone');
    expect(message).not.toContain('grace');
  });

  test('a replay is 200 and says nothing changed', async () => {
    const cookie = await signedIn();
    const response = await app({
      answer: {
        ok: true,
        restored: { pages: 0, chunks: 0, facts: 0, entities: 0, entityCards: 0, commitments: 0, attachments: 0 },
        unarchived: { aliases: 0 },
        supersededCards: 0,
        supersededAliases: 0,
        wasOrigin: false,
        alreadyRestored: true,
        restorableUntil: LISTED.restorableUntil,
      },
    })(post('/api/restore', { deleted_at: LISTED.deletedAt, confirm: LISTED.deletedAt }, { cookie }));

    // Not a 404. Ledger membership was already checked, so all-zero is a replay
    // rather than a miss, and 404 would be a lie about a retraction that exists.
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.already_restored).toBe(true);
    expect(body.message).toBe('That retraction has already been restored. Nothing changed.');
  });

  test('restoring a severance says the account is still disconnected', () => {
    // Without this sentence the button lies about its own scope: the rows come
    // back, the connector does not, the discarded polling jobs are not requeued
    // and no vendor token is touched.
    const copy = restoreMessage({ alreadyRestored: false, wasOrigin: true });
    expect(copy).toContain('remains disconnected');
    expect(copy).toContain('Connectors');
  });
});

// ---------------------------------------------------------------------------
// 4. The composition. The real port, against a real brain.
// ---------------------------------------------------------------------------

describe('the port that is actually wired', () => {
  /** One tenant, one connection — the shape `tenantDatabases` produces. */
  const withTenant = <T,>(_tenantId: string, work: (db: SQL) => Promise<T>): Promise<T> =>
    work(brainSql);

  async function insertPage(ref: string, title: string, origin = WORK): Promise<string> {
    const rows = (await brainSql.unsafe(
      `INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                         embedding_dimensions, chunker_version, normalizer_version, content_sha256)
       VALUES ($1, 'email', $2, $3, 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64))
       RETURNING page_id::text AS id`,
      [origin, title, ref],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  }

  async function insertChunk(pageId: string, content: string, origin = WORK): Promise<void> {
    await brainSql.unsafe(
      `INSERT INTO chunk (origin_context, content, page_id, ordinal) VALUES ($1, $2, $3::bigint, 0)`,
      [origin, content, pageId],
    );
  }

  async function tombstonedRows(): Promise<number> {
    const rows = (await brainSql`
      SELECT (SELECT count(*) FROM page WHERE deleted_at IS NOT NULL)
           + (SELECT count(*) FROM chunk WHERE deleted_at IS NOT NULL) AS n
    `) as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0);
  }

  test(
    'a forget inside the window comes back, rows and all',
    async () => {
      const pageId = await insertPage('gmail:live', 'A document', WORK);
      await insertChunk(pageId, 'a passage of the document');
      const forgotten = await forgetRecord(brainSql, {
        id: { kind: 'doc', key: pageId },
        // Real wall clock: the port reads the window from `new Date()`, and a
        // fixture pinned to a fixed date would be permanently expired.
        grant: [WORK],
        now: new Date(),
      });
      expect(forgotten.ok).toBe(true);
      if (!forgotten.ok) return;
      expect(await tombstonedRows()).toBe(2);

      const outcome = await retractionPort(withTenant).restore({
        tenantId: TENANT,
        deletedAt: forgotten.deletedAt,
        confirm: forgotten.deletedAt,
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.restored.pages).toBe(1);
      expect(outcome.restored.chunks).toBe(1);
      expect(outcome.alreadyRestored).toBe(false);
      expect(outcome.wasOrigin).toBe(false);
      // The rows, from the database rather than from the receipt.
      expect(await tombstonedRows()).toBe(0);
      // And the instant stops being offered, so the button cannot be clicked
      // twice for one effect.
      const listing = await retractionPort(withTenant).list({ tenantId: TENANT });
      expect(listing.retractions).toEqual([]);
    },
    120_000,
  );

  test(
    'a subject erasure is refused even though the executor would happily undo it',
    async () => {
      const pageId = await insertPage('gmail:subject', `A note from ${SUBJECT}`, PERSONAL);
      await insertChunk(pageId, `${SUBJECT} asked about the invoice.`, PERSONAL);

      const receipt = await eraseSubject({ sql: brainSql }, { identifier: SUBJECT, erasedBy: 'app' });
      expect(receipt.removed.pages).toBeGreaterThan(0);
      const tombstoned = await tombstonedRows();
      expect(tombstoned).toBeGreaterThan(0);

      // The hazard, demonstrated before the gate is asserted. The instant is
      // readable, the rows are there, and the raw executor brings them back —
      // which is exactly why the surface must not be allowed to call it.
      const raw = await restoreForgotten(brainSql, {
        deletedAt: receipt.erasedAt,
        now: new Date(Date.parse(receipt.erasedAt) + HOUR),
      });
      expect(raw.ok).toBe(true);
      if (!raw.ok) return;
      expect(raw.restored.pages).toBeGreaterThan(0);
      // And the suppression row it could not undo is still standing, which is
      // what makes that `ok: true` a lie if a route had rendered it.
      const suppressed = (await brainSql`SELECT count(*)::int AS n FROM erased_subject`) as Array<{
        n: number;
      }>;
      expect(suppressed[0]?.n).toBe(1);

      // Put it back the way the erasure left it, and ask the port.
      await brainSql.unsafe(
        `UPDATE page SET deleted_at = $1::timestamptz WHERE page_id = $2::bigint`,
        [receipt.erasedAt, pageId],
      );
      await brainSql.unsafe(
        `UPDATE chunk SET deleted_at = $1::timestamptz WHERE page_id = $2::bigint`,
        [receipt.erasedAt, pageId],
      );

      const outcome = await retractionPort(withTenant).restore({
        tenantId: TENANT,
        deletedAt: receipt.erasedAt,
        confirm: receipt.erasedAt,
      });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('not_found');
      // Refused, and nothing moved: the rows are still exactly as the erasure
      // left them.
      expect(await tombstonedRows()).toBe(tombstoned);
    },
    120_000,
  );

  test(
    'an instant this brain never wrote is not found, and neither is a word',
    async () => {
      const port = retractionPort(withTenant);
      const unknown = await port.restore({
        tenantId: TENANT,
        deletedAt: new Date().toISOString(),
        confirm: new Date().toISOString(),
      });
      expect(unknown.ok).toBe(false);

      // Not a timestamp at all. Refused rather than cast in SQL, where it would
      // come back as a 500 on a request anybody can make.
      const nonsense = await port.restore({
        tenantId: TENANT,
        deletedAt: 'yesterday',
        confirm: 'yesterday',
      });
      expect(nonsense.ok).toBe(false);
      if (nonsense.ok) return;
      expect(nonsense.reason).toBe('not_found');
    },
    120_000,
  );

  test(
    'a closed window is refused with the instant it closed at',
    async () => {
      const pageId = await insertPage('gmail:stale', 'An old document', WORK);
      const longAgo = new Date(Date.now() - (FORGET_TTL_HOURS + 2) * HOUR);
      const forgotten = await forgetRecord(brainSql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: longAgo,
      });
      expect(forgotten.ok).toBe(true);
      if (!forgotten.ok) return;

      // Not listed — absence is the honest rendering of an expired retraction.
      const listing = await retractionPort(withTenant).list({ tenantId: TENANT });
      expect(listing.retractions).toEqual([]);

      // But the ledger row is still there (the purge sweeps a day later), so the
      // race — page loaded at 71h59m, click lands at 72h01m — can be answered
      // with *when* rather than with "that never existed".
      const outcome = await retractionPort(withTenant).restore({
        tenantId: TENANT,
        deletedAt: forgotten.deletedAt,
        confirm: forgotten.deletedAt,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('ttl_expired');
      expect(outcome.closedAt).toBe(
        new Date(longAgo.getTime() + FORGET_TTL_HOURS * HOUR).toISOString(),
      );
    },
    120_000,
  );

  test(
    'the echo is refused in the port too, before any connection is opened',
    async () => {
      // `app.ts` checks this as well. Two checks, deliberately: the echo is the
      // control, and a control checked in exactly one place is one edit away
      // from being checked nowhere.
      let reached = false;
      const refusing = retractionPort(<T,>(_id: string, work: (db: SQL) => Promise<T>) => {
        reached = true;
        return work(brainSql);
      });

      const outcome = await refusing.restore({
        tenantId: TENANT,
        deletedAt: AT.toISOString(),
        confirm: 'something else',
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('not_confirmed');
      expect(reached).toBe(false);
    },
    120_000,
  );

  test(
    'restoring a severance reports itself as an origin restore',
    async () => {
      await insertPage('gmail:sever', 'A work message', WORK);
      const at = new Date();
      const severed = await severOrigin(brainSql, { origin: WORK, confirm: WORK, now: at });
      expect(severed.ok).toBe(true);

      const outcome = await retractionPort(withTenant).restore({
        tenantId: TENANT,
        deletedAt: at.toISOString(),
        confirm: at.toISOString(),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.wasOrigin).toBe(true);
      expect(restoreMessage(outcome)).toContain('remains disconnected');

      // The audit row survives its own undo — the recompute worklist is derived
      // from it — and stops being offered.
      const rows = (await brainSql`SELECT count(*)::int AS n FROM severance`) as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(1);
      expect((await retractionPort(withTenant).list({ tenantId: TENANT })).retractions).toEqual([]);
    },
    120_000,
  );

  test(
    'a second click on a restored instant changes nothing and says so',
    async () => {
      const pageId = await insertPage('gmail:twice', 'A document', WORK);
      const forgotten = await forgetRecord(brainSql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: new Date(),
      });
      expect(forgotten.ok).toBe(true);
      if (!forgotten.ok) return;

      const port = retractionPort(withTenant);
      await port.restore({
        tenantId: TENANT,
        deletedAt: forgotten.deletedAt,
        confirm: forgotten.deletedAt,
      });

      // The listing no longer offers it, so this models the crash-in-the-gap
      // case: a ledger row that outlived its own restore. It is reached by
      // writing the row back, which is the only state that can produce it.
      await brainSql.unsafe(
        `INSERT INTO retraction (retracted_at, target_kind, origin_contexts, removed)
         VALUES ($1::timestamptz, 'doc', ARRAY['${WORK}'], '{"pages":1}'::jsonb)`,
        [forgotten.deletedAt],
      );

      const again = await port.restore({
        tenantId: TENANT,
        deletedAt: forgotten.deletedAt,
        confirm: forgotten.deletedAt,
      });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.alreadyRestored).toBe(true);
      expect(restoreMessage(again)).toBe('That retraction has already been restored. Nothing changed.');
    },
    120_000,
  );
});
