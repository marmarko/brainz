/**
 * U18 §3 — work/personal dual grants, and the proof a work grant cannot reach a
 * personal row through *any* path.
 *
 * ============================================================================
 * THE TRAP THIS FILE IS WRITTEN AGAINST
 * ============================================================================
 *
 * > The dual-grant test passes trivially unless the fixture contains BOTH work
 * > and personal rows and the assertion is that the personal row is ABSENT under
 * > a work grant. Asserting the work row is present proves nothing.
 *
 * So the first test in this file asserts the *fixture* — that a whole-brain
 * grant really can read every personal row a later test claims is hidden. A
 * suite whose fixture never contained the personal half would pass every
 * absence assertion below it while proving nothing at all, and it would look
 * exactly like this file.
 *
 * The second trap is subtler and is this repo's recurring defect: **a new fence
 * added at one call site while ten others bypass it.** A per-field assertion
 * (`expect(result.content.results).not.toContain(...)`) tests the fields
 * somebody remembered to check. So the personal rows carry a **sentinel**, and
 * the assertion is over the *entire serialised response* — content, envelope,
 * `_meta`, error message — for **every advertised tool on both endpoints**,
 * driven off `TOOL_NAMES` so a tool added later is covered without anyone
 * remembering to add it here.
 *
 * ============================================================================
 * THE THREE HAZARDS
 * ============================================================================
 *
 *   1. **Empty origins means the whole brain.** `dispatch.ts` reads
 *      `claims.origins.length > 0 ? claims.origins : fullBrainGrant(...)`.
 *      `fence.ts`'s stated rule is "an empty grant sees nothing (not
 *      everything)"; this one line inverts it. A narrowed grant that ends up
 *      with no origins — filtered by validation, or re-minted after its only
 *      origin was severed — silently becomes a whole-brain grant, and no fence
 *      reports a violation because no fence was consulted.
 *
 *   2. **`writeOrigin` is independent of the grant.** A work-scoped grant whose
 *      `writeOrigin` is `personal:agent` writes personal rows it cannot then
 *      read back — a cross-context write invisible to any test that stores and
 *      recalls under one credential.
 *
 *   3. **The class wildcard must not be a prefix match.** R9's storage finding
 *      was that a credential scoped to `tenant-a` reads `tenant-abc/` because
 *      the platform matches the string it was given rather than a boundary at
 *      the separator. The same mistake one store over: `work` is a prefix of
 *      `workplace`.
 *
 * ============================================================================
 * WHAT THIS FILE PROVES, AND WHAT A GREEN RUN OF IT DOES NOT MEAN
 * ============================================================================
 *
 * **Every `work:mail` row below is planted by this fixture, in SQL.** No
 * production write path in `src/` produces a `work:` or `personal:` origin for
 * connector content: connectors file at `pipedream:<source>`
 * (`src/ingest/pipedream/pull.ts:originContextFor`), and the only `work:` origin
 * anything can currently write is `work:agent`, from a work-scoped grant's own
 * `remember`. On a real brain a `work:*` grant therefore expands to
 * `['work:agent']` and reads back exactly its own memories.
 *
 * So a green run here means **the fence holds** — the origin grammar, the
 * wildcard's class match, the subset and intersect rules, the write-origin
 * coherence check, and the sweep over every tool on both endpoints. It does not
 * mean a user can connect a work mailbox and have it land in their work context;
 * nothing files there yet. That is a product gap and it is recorded as one in
 * `src/mcp/grant-scope.ts` and in `upstream/concepts.jsonl`.
 *
 * The fixture is the right shape regardless: a fence is worth testing against
 * the rows it will fence, and planting them directly is how the test stays
 * meaningful *before* the producer exists rather than after. What would be
 * wrong is reading the green tick as the capability.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  deriveSigningKey,
  mintAccessToken,
  type GrantClaims,
} from '../../src/mcp/oauth.ts';
import { classOf } from '../../src/mcp/grant-scope.ts';
import { TOOL_NAMES } from '../../src/mcp/tools/index.ts';
import { createMcpFixture, seedEntity, seedFact, seedPage, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const PERSONAL_MAIL = 'personal:mail';
const PERSONAL_AGENT = 'personal:agent';
const WORK_MAIL = 'work:mail';
const WORK_AGENT = 'work:agent';

/**
 * The string that must never cross the fence.
 *
 * One token, planted in every personal body, every personal title and the
 * personal entity's own name, so that a single `expect(...).not.toContain`
 * over the whole serialised response covers every field any handler might
 * render — including fields added after this file was written.
 */
const SENTINEL = 'PERSONAL-CANARY-9d41f0';

/** Planted in the work rows, so "the fence refused everything" is detectable. */
const WORK_MARKER = 'WORK-MARKER-51ab7c';

let fixture: McpFixture;
let personalChunkId = '';
let workChunkId = '';
let personalPageId = '';
let mixedFactId = '';
let personalFactId = '';
let personalEntityId = '';
let sharedEntityId = '';

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_context_grants');
  const { sql } = fixture;

  const personalChunks = await seedPage(sql, {
    id: 'personal-therapy',
    title: `Notes about the ${SENTINEL} appointment`,
    sourceType: 'email',
    origin: PERSONAL_MAIL,
    createdAt: '2026-06-01',
    paragraphs: [`The ${SENTINEL} appointment moved to Thursday and the fee is four hundred dollars.`],
  });
  personalChunkId = personalChunks[0] ?? '';

  const pageRows = (await sql`
    SELECT page_id::text AS page_id FROM chunk WHERE chunk_id = ${personalChunkId}::bigint
  `) as Array<{ page_id: string }>;
  personalPageId = pageRows[0]?.page_id ?? '';

  const workChunks = await seedPage(sql, {
    id: 'work-standup',
    title: `Standup notes ${WORK_MARKER}`,
    sourceType: 'email',
    origin: WORK_MAIL,
    createdAt: '2026-06-02',
    paragraphs: [`${WORK_MARKER}: the platform team shipped the appointment scheduler this week.`],
  });
  workChunkId = workChunks[0] ?? '';

  // Pure-personal derived row: the subset rule must refuse it outright.
  personalFactId = await seedFact(sql, {
    statement: `The ${SENTINEL} appointment is billed at four hundred dollars.`,
    origins: [PERSONAL_MAIL],
    chunkIds: [personalChunkId],
    createdAt: '2026-06-03',
  });

  // MIXED: a synthesis over a work input and a personal one. A work grant
  // *overlaps* it and must still be refused — an intersect rule here hands the
  // work connector the personal half of every joined claim, and no test
  // comparing two same-grant results would ever notice.
  mixedFactId = await seedFact(sql, {
    statement: `The platform team's offsite clashes with the ${SENTINEL} appointment.`,
    origins: [PERSONAL_MAIL, WORK_MAIL],
    chunkIds: [personalChunkId, workChunkId],
    createdAt: '2026-06-04',
  });

  // Personal-only entity: must not resolve under a work grant at all.
  personalEntityId = await seedEntity(sql, {
    slug: 'canary-clinic',
    name: `${SENTINEL} Clinic`,
    type: 'organization',
    origins: [PERSONAL_MAIL],
  });

  // Shared entity: the intersect rule resolves it (that is deliberate — an
  // entity is a name), and the hydration below it must still fence. This is the
  // ledger's "traversal walking a work row to a personal row".
  sharedEntityId = await seedEntity(sql, {
    slug: 'acme-example',
    name: 'Acme Example',
    type: 'organization',
    origins: [PERSONAL_MAIL, WORK_MAIL],
  });
  await sql`
    INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
    VALUES (${sharedEntityId}::bigint, 'acme example', 'user', ARRAY[${WORK_MAIL}]::text[])
  `;
  // **A spelling only the personal half ever used.** `entity_alias` is recall
  // vocabulary written from the text of the page being ingested, so an alias is
  // a string an outside sender chose — content, not structure. The entity itself
  // resolves under a work grant by design (`fence.ts` fences entities on
  // *intersect*, because a subset rule would refuse every name that appears in
  // both halves of a brain), and the licence for that looser rule is that every
  // row the resolution then produces goes back through a fence. This row is the
  // one that did not.
  await sql`
    INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
    VALUES (${sharedEntityId}::bigint, ${`acme ${SENTINEL} holdings`}, 'user', ARRAY[${PERSONAL_MAIL}]::text[])
  `;
  await seedFact(sql, {
    statement: `Acme Example sent the ${SENTINEL} invoice to the home address.`,
    origins: [PERSONAL_MAIL],
    chunkIds: [personalChunkId],
    createdAt: '2026-06-05',
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

function tokenFor(claims: Partial<GrantClaims>): string {
  const full = {
    grantId: 'g-scoped',
    tenantId: fixture.tenantId,
    origins: [] as readonly string[],
    scope: 'whole_brain',
    writeOrigin: PERSONAL_AGENT,
    endpoint: 'mcp',
    clientId: 'client-test',
    issuedAt: fixture.now(),
    expiresAt: fixture.now() + 3_600_000,
    ...claims,
  } as GrantClaims;
  return mintAccessToken(full, deriveSigningKey(fixture.bearer));
}

/** Every argument shape a tool needs, so the sweep can call all of them. */
const ARGS_FOR: Readonly<Record<string, () => Record<string, unknown>>> = {
  recall: () => ({ query: 'appointment fee four hundred dollars' }),
  search: () => ({ query: 'appointment fee four hundred dollars' }),
  fetch: () => ({ id: `chunk:${personalChunkId}` }),
  entity: () => ({ name: 'Acme Example' }),
  briefing: () => ({}),
  remember: () => ({ statement: 'A memory written by the sweep.' }),
  forget: () => ({ id: `chunk:${personalChunkId}` }),
  brain: () => ({}),
  manage: () => ({ action: 'set_spend_cap', value: '1000' }),
  synthesize: () => ({ query: 'anything' }),
};

// ---------------------------------------------------------------------------
// 0. The fixture itself. Without this, every absence below proves nothing.
// ---------------------------------------------------------------------------

describe('the fixture contains both halves', () => {
  test(
    'a whole-brain grant reads the personal rows the later tests claim are hidden',
    async () => {
      const chunk = await fixture.call('fetch', { id: `chunk:${personalChunkId}` });
      expect(chunk.ok).toBe(true);
      expect(JSON.stringify(chunk.content)).toContain(SENTINEL);

      const mixed = await fixture.call('fetch', { id: `fact:${mixedFactId}` });
      expect(mixed.ok).toBe(true);
      expect(JSON.stringify(mixed.content)).toContain(SENTINEL);

      const personalFact = await fixture.call('fetch', { id: `fact:${personalFactId}` });
      expect(personalFact.ok).toBe(true);

      const entity = await fixture.call('entity', { name: `${SENTINEL} Clinic` });
      expect(entity.ok).toBe(true);

      const shared = await fixture.call('entity', { name: 'Acme Example' });
      expect(shared.ok).toBe(true);
      // The shared entity's personal fact is reachable by the whole-brain grant,
      // which is what makes its absence under a work grant meaningful.
      expect(JSON.stringify(shared.content)).toContain(SENTINEL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the work row is genuinely there, so a fence that refuses everything is detectable',
    async () => {
      const work = await fixture.call('fetch', { id: `chunk:${workChunkId}` });
      expect(work.ok).toBe(true);
      expect(JSON.stringify(work.content)).toContain(WORK_MARKER);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 1. Hazard one: a narrowed grant with no origins must not become the brain.
// ---------------------------------------------------------------------------

describe('a narrowed grant can never widen to the whole brain', () => {
  test(
    'a token claiming narrowed scope with an empty origin list is refused, not granted everything',
    async () => {
      const authorization = `Bearer ${tokenFor({ scope: 'narrowed', origins: [] })}`;
      const result = await fixture.call('fetch', { id: `chunk:${personalChunkId}` }, { authorization });

      // The refusal is at the credential, before any handler runs — so it is
      // `unauthorized`, not `scope_denied`. A `scope_denied` here would mean the
      // token was believed and the fence happened to hold, which is a different
      // and much weaker property.
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('unauthorized');
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a wildcard that matches nothing in this brain still reads nothing, not everything',
    async () => {
      // `other:*` matches no origin the fixture holds. The expansion floor is
      // the class's own agent origin, so the grant is `['other:agent']` — which
      // sees nothing — rather than an empty list falling through to the brain.
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['other:*'],
        writeOrigin: 'other:agent',
      })}`;
      const result = await fixture.call('fetch', { id: `chunk:${personalChunkId}` }, { authorization });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('scope_denied');

      const ranked = await fixture.call('recall', { query: 'appointment' }, { authorization });
      expect(JSON.stringify(ranked)).not.toContain(SENTINEL);
      expect(JSON.stringify(ranked)).not.toContain(WORK_MARKER);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Hazard two: the write origin must be inside the grant.
// ---------------------------------------------------------------------------

describe('a grant writes only where it can read', () => {
  test(
    'a work-scoped grant claiming a personal write origin is refused at the credential',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: [`${WORK_MAIL}`, 'work:*'],
        writeOrigin: PERSONAL_AGENT,
      })}`;
      const result = await fixture.call(
        'remember',
        { statement: 'A work memory that must not land in personal.' },
        { authorization },
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('unauthorized');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a work grant that does write, writes at a work origin and reads it back',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const written = await fixture.call(
        'remember',
        { statement: `${WORK_MARKER} the offsite is on the twelfth.` },
        { authorization },
      );
      expect(written.ok).toBe(true);

      const factId = (written.content as { id: string }).id.replace('fact:', '');
      const rows = (await fixture.sql`
        SELECT origin_contexts FROM fact WHERE fact_id = ${factId}::bigint
      `) as Array<{ origin_contexts: string[] }>;
      expect(rows[0]?.origin_contexts).toEqual([WORK_AGENT]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Hazard three: the class wildcard is not a prefix match.
// ---------------------------------------------------------------------------

describe('the class wildcard matches a class, not a prefix', () => {
  test(
    'a `work:*` grant does not reach an origin whose class merely starts with work',
    async () => {
      await fixture.sql`
        INSERT INTO page (origin_context, source_type, title, created_at,
                          embedding_model, embedding_dimensions, chunker_version,
                          normalizer_version, content_sha256)
        VALUES ('workplace:mail', 'email', ${`Sibling class ${SENTINEL}`}, '2026-06-06'::timestamptz,
                'fixture-model', 1536, 1, 1, ${'1'.repeat(64)})
      `;
      const rows = (await fixture.sql`
        SELECT page_id::text AS page_id FROM page WHERE origin_context = 'workplace:mail'
      `) as Array<{ page_id: string }>;
      const siblingPageId = rows[0]?.page_id ?? '';
      await fixture.sql`
        INSERT INTO chunk (origin_context, content, page_id, ordinal)
        VALUES ('workplace:mail', ${`A sibling-class row holding ${SENTINEL}.`},
                ${siblingPageId}::bigint, 0)
      `;
      const siblingChunk = (await fixture.sql`
        SELECT chunk_id::text AS chunk_id FROM chunk WHERE origin_context = 'workplace:mail'
      `) as Array<{ chunk_id: string }>;

      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const result = await fixture.call(
        'fetch',
        { id: `chunk:${siblingChunk[0]?.chunk_id}` },
        { authorization },
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('scope_denied');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3b. The product path: a work grant a user can actually obtain.
// ---------------------------------------------------------------------------

describe('a work-scoped grant can be obtained through the real OAuth flow', () => {
  /**
   * **The gap this closes.** Before U18 every narrowed grant in this repo was
   * minted by a test helper — `handleAuthorize` hardcoded `origins: []`. The
   * fence was real and nothing could ask for it, which is a fence with no
   * product, and a suite built entirely on hand-minted tokens would never have
   * noticed.
   */
  async function flow(scope: string | null): Promise<Response> {
    const { createMcpServer } = await import('../../src/mcp/server.ts');
    const { registerClient } = await import('../../src/mcp/oauth.ts');
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const registered = registerClient(
      fixture.deps.store,
      { clientName: 'test-connector', redirectUris: [redirectUri] },
      { allowlist: { redirectUris: [redirectUri], maxRegistrationsPerHour: 10 }, now: fixture.now() },
    );
    if (!registered.ok) throw new Error(`client did not register: ${registered.error}`);

    const server = createMcpServer({
      ...fixture.deps,
      issuer: 'https://brainz.test',
      registrationAllowlist: { redirectUris: [redirectUri], maxRegistrationsPerHour: 10 },
    });

    const query = new URLSearchParams({
      client_id: registered.client.client_id,
      redirect_uri: redirectUri,
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'opaque-state',
      ...(scope === null ? {} : { scope }),
    });
    return server.fetch(
      new Request(`https://brainz.test/authorize?${query.toString()}`, {
        headers: { authorization: `Bearer ${fixture.bearer}` },
      }),
    );
  }

  test(
    'asking for the work context yields a grant that cannot read a personal row',
    async () => {
      const response = await flow('brainz:context:work');
      expect(response.status).toBe(302);

      const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
      const record = fixture.deps.store.takeCode(code);
      expect(record).toBeDefined();
      expect(record?.scope).toBe('narrowed');
      expect(record?.origins).toEqual(['work:*']);
      // Derived from the class, never accepted from the request — a consent step
      // that took a write origin from a query parameter would let a client aim
      // its writes at a context it cannot read.
      expect(record?.writeOrigin).toBe(WORK_AGENT);

      // And the grant that flow produces actually fences. This is the assertion
      // that connects the consent step to the property: a code carrying the
      // right strings proves nothing if the strings do not narrow anything.
      if (record === undefined) throw new Error('the flow issued no code');
      const authorization = `Bearer ${tokenFor({
        scope: record.scope,
        origins: record.origins,
        writeOrigin: record.writeOrigin,
      })}`;
      const denied = await fixture.call('fetch', { id: `chunk:${personalChunkId}` }, { authorization });
      expect(denied.ok).toBe(false);
      expect(denied.error?.code).toBe('scope_denied');
      expect(JSON.stringify(denied)).not.toContain(SENTINEL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'no scope at all still grants the whole brain — every shipping connector sends none',
    async () => {
      const response = await flow(null);
      expect(response.status).toBe(302);
      const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
      const record = fixture.deps.store.takeCode(code);
      expect(record?.scope).toBe('whole_brain');
      expect(record?.origins).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an unrecognised scope is refused rather than quietly granting everything',
    async () => {
      // The asymmetry that matters: absent is the ordinary case, but a client
      // that ASKED for something and silently received the brain has been
      // over-granted invisibly from both ends.
      for (const scope of [
        'work',
        'brainz:context:Work',
        'brainz:context:work brainz:context:personal',
        // **The case that isolates the prefix check**, and the realistic one: a
        // client that sends a standard scope alongside ours. Skipping the token
        // it did not recognise would hand back a grant the client did not ask
        // for — narrower than the brain here, but chosen by the server rather
        // than by the caller, which is the same class of silent substitution.
        // Refusing is the fail-closed reading and it is what the docstring says.
        'openid brainz:context:work',
      ]) {
        const response = await flow(scope);
        expect(response.status, scope).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBe('invalid_scope');
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The sweep: every tool, both endpoints, one sentinel.
// ---------------------------------------------------------------------------

describe('a work grant cannot reach a personal row through any tool on any endpoint', () => {
  test(
    'the sentinel appears in no response from any tool on either endpoint',
    async () => {
      for (const endpoint of ['mcp', 'openai'] as const) {
        const authorization = `Bearer ${tokenFor({
          scope: 'narrowed',
          origins: ['work:*'],
          writeOrigin: WORK_AGENT,
          endpoint,
        })}`;

        for (const tool of TOOL_NAMES) {
          const result = await fixture.call(tool, ARGS_FOR[tool]?.() ?? {}, {
            authorization,
            endpoint,
            // `manage` needs a nonce it will not get; the point is that its
            // refusal carries no content either.
          });
          const serialised = JSON.stringify(result);
          expect(
            serialised.includes(SENTINEL),
            `${tool} on /${endpoint} leaked the personal sentinel: ${serialised.slice(0, 400)}`,
          ).toBe(false);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the same sweep under a work grant does return the work row — the fence is not refusing everything',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const work = await fixture.call('fetch', { id: `chunk:${workChunkId}` }, { authorization });
      expect(work.ok).toBe(true);
      expect(JSON.stringify(work.content)).toContain(WORK_MARKER);

      const ranked = await fixture.call('recall', { query: 'platform team scheduler' }, { authorization });
      expect(ranked.ok).toBe(true);
      expect(JSON.stringify(ranked.content)).toContain(WORK_MARKER);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the mixed-origin fact is refused on the SUBSET rule, and the personal-only fact outright',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;

      const mixed = await fixture.call('fetch', { id: `fact:${mixedFactId}` }, { authorization });
      expect(mixed.ok).toBe(false);
      expect(mixed.error?.code).toBe('scope_denied');

      const personal = await fixture.call('fetch', { id: `fact:${personalFactId}` }, { authorization });
      expect(personal.ok).toBe(false);
      expect(personal.error?.code).toBe('scope_denied');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the shared entity resolves under a work grant and hydrates none of its personal facts',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const card = await fixture.call('entity', { name: 'Acme Example' }, { authorization });

      // Intersect resolves the name — deliberate, and the reason `fence.ts`
      // treats an entity differently from a row. What must not follow is the
      // personal statement hanging off it.
      expect(card.ok).toBe(true);
      expect(JSON.stringify(card.content)).not.toContain(SENTINEL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the shared entity keeps the spellings the work half wrote and drops the ones it did not',
    async () => {
      // The absence assertion above proves nothing on its own: a card that
      // returned no aliases at all would satisfy it. So this checks both
      // directions on the same row — the work-origin spelling is there, the
      // personal-origin spelling is not — which is what makes it a fence rather
      // than a blanket refusal.
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const card = await fixture.call('entity', { name: 'Acme Example' }, { authorization });
      const aliases = (card.content as { card: { aliases: string[] } }).card.aliases;
      expect(aliases).toEqual(['acme example']);

      // And the whole-brain credential sees both, so the personal spelling is
      // genuinely in the fixture and genuinely reachable by a grant that holds it.
      const whole = await fixture.call('entity', { name: 'Acme Example' });
      const wholeAliases = (whole.content as { card: { aliases: string[] } }).card.aliases;
      expect(wholeAliases).toEqual(['acme example', `acme ${SENTINEL} holdings`]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an alias written before rung 11 is judged by its entity, which is the fail-closed reading',
    async () => {
      // Expand-only means the column arrives nullable and unbackfilled, and a
      // previous fleet release keeps writing unstamped rows for the length of a
      // rolling deploy. NULL says nobody recorded the provenance — not that
      // there is none — so the read coalesces to the entity's own union. On a
      // shared entity that hides the row from every narrowed grant; on a
      // single-origin entity it behaves exactly as it always did.
      await fixture.sql`
        INSERT INTO entity_alias (entity_id, alias, alias_source)
        VALUES (${sharedEntityId}::bigint, ${`legacy ${SENTINEL} spelling`}, 'user')
      `;

      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const card = await fixture.call('entity', { name: 'Acme Example' }, { authorization });
      expect(JSON.stringify(card.content)).not.toContain(SENTINEL);

      const whole = await fixture.call('entity', { name: 'Acme Example' });
      expect(JSON.stringify(whole.content)).toContain(`legacy ${SENTINEL} spelling`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a personal-only entity does not resolve under a work grant',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const card = await fixture.call('entity', { name: `${SENTINEL} Clinic` }, { authorization });
      expect(card.ok).toBe(false);
      expect(card.error?.code).toBe('scope_denied');

      const byId = await fixture.call('fetch', { id: `ent:${personalEntityId}` }, { authorization });
      expect(byId.ok).toBe(false);
      expect(byId.error?.code).toBe('scope_denied');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'forget cannot retract a personal row under a work grant',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const retracted = await fixture.call('forget', { id: `doc:${personalPageId}` }, { authorization });
      expect(retracted.ok).toBe(false);
      expect(retracted.error?.code).toBe('scope_denied');

      const stillThere = (await fixture.sql`
        SELECT deleted_at FROM page WHERE page_id = ${personalPageId}::bigint
      `) as Array<{ deleted_at: string | null }>;
      expect(stillThere[0]?.deleted_at).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'brain reports the grant it holds and counts only what it may read',
    async () => {
      const authorization = `Bearer ${tokenFor({
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: WORK_AGENT,
      })}`;
      const result = await fixture.call('brain', {}, { authorization });
      expect(result.ok).toBe(true);
      const content = result.content as { origins: string[]; counts: { pages: number } };

      // Every origin it names is a work one. A brain tool that echoed the
      // brain's whole origin list would tell a work connector which personal
      // contexts exist.
      for (const origin of content.origins) {
        expect(classOf(origin)).toBe('work');
      }

      // Compared against a census rather than a constant, so the assertion does
      // not decay into "some number" as earlier tests in this file add rows —
      // and so it fails if the count ever includes a `workplace:` page, which a
      // hardcoded expectation would not notice.
      const census = (await fixture.sql`
        SELECT
          (SELECT count(*)::int FROM page WHERE deleted_at IS NULL AND quarantined_at IS NULL
             AND split_part(origin_context, ':', 1) = 'work') AS work_pages,
          (SELECT count(*)::int FROM page WHERE deleted_at IS NULL AND quarantined_at IS NULL) AS all_pages
      `) as Array<{ work_pages: number; all_pages: number }>;

      expect(content.counts.pages).toBe(census[0]?.work_pages ?? -1);
      // …and the brain holds more than that, so "counts only what it may read"
      // is a claim with a gap in it rather than an equality that happens to hold.
      expect(census[0]?.all_pages ?? 0).toBeGreaterThan(census[0]?.work_pages ?? 0);
    },
    TEST_TIMEOUT_MS,
  );
});
