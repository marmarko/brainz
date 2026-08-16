/**
 * U18 §1 — the cross-surface equivalence suite.
 *
 * ============================================================================
 * WHY THIS IS THE DELIVERABLE AND THE ENDPOINT IS NOT
 * ============================================================================
 *
 * `/openai` shipped at U6. What did not ship is the thing that keeps it from
 * drifting: **two surfaces that answer differently are worse than one surface**,
 * because the difference is invisible from either side. A user who reads their
 * brain through ChatGPT and through Claude and gets two answers has no way to
 * tell which is the bug.
 *
 * `search` and `fetch` are written as *projections* of `recall` precisely so the
 * equivalence is structural. This file is what makes that claim checkable rather
 * than aspirational: a future refactor that gives `search` its own query, its
 * own limit, or its own ordering fails here.
 *
 * ============================================================================
 * THE TRAP THIS FILE IS WRITTEN AGAINST
 * ============================================================================
 *
 * > The equivalence suite passes trivially if both surfaces are asked something
 * > neither can answer.
 *
 * Two empty lists are equal. So:
 *
 *   * every comparison is driven from the **blocking tier's own corpus**
 *     (`evals/corpus.ts`) using its committed queries and its committed grants,
 *     rather than from a bespoke fixture written to make this file pass;
 *   * every comparison asserts the result list is **non-empty** before comparing
 *     it, and the suite asserts up front how many queries it is driving;
 *   * the comparison is on **ids in order**, not on length or on set equality —
 *     a projection running its own query with its own limit produces a different
 *     list, and a set comparison hides a reordering that changes what a model
 *     reads first.
 *
 * ============================================================================
 * WHAT EQUIVALENCE CANNOT SEE, AND WHY THE FENCE IS NOT TESTED HERE
 * ============================================================================
 *
 * Equivalence compares two results produced by the **same** grant. A scope check
 * added to `fetch` and not to `recall({id})` is a cross-origin read that this
 * file structurally cannot detect — which is exactly why the fence lives below
 * both handlers in `dispatch.ts` and is proved in `context-grants.test.ts`.
 * Stated here so nobody reads a green run of this file as an isolation result.
 *
 * What this file *does* add to the fence's proof: the twin grants below are
 * **narrowed** and endpoint-bound, so equivalence is established under U18's new
 * `allowedOrigins` scope rather than only under the whole-brain bearer. If the
 * new fence narrowed differently on the two surfaces, this is where it would
 * show.
 *
 * ============================================================================
 * THE WIRE CONTRACT (research, 2026-08-15)
 * ============================================================================
 *
 * `https://developers.openai.com/api/docs/mcp` mandates, for a ChatGPT MCP
 * connector:
 *
 *   * `search` → `{ results: [{ id, title, url }] }`;
 *   * `fetch`  → `{ id, title, text, url, metadata? }`;
 *   * both returned as `structuredContent` **and** as the same value
 *     JSON-encoded in the `content` array;
 *   * *"ChatGPT creates citation metadata only when `url` is a non-empty
 *     string."*
 *
 * The last of those is a silent failure: a result with an empty `url` is
 * rendered without a citation and nothing errors. It is asserted below.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CORPUS, CORPUS_INPUT, corpusTexts, type OriginContext } from '../../evals/corpus.ts';
import { loadEmbeddings } from '../../evals/embeddings.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { seedCorpus } from '../../evals/seed-tenant.ts';
import { agentOriginFor, classOf } from '../../src/mcp/grant-scope.ts';
import { deriveSigningKey, mintAccessToken, type GrantClaims } from '../../src/mcp/oauth.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { advertisedTools, type Endpoint } from '../../src/mcp/tools/index.ts';
import { createMcpFixture, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;

/**
 * How many corpus queries this suite drives.
 *
 * A floor rather than a comment: if the corpus loses its work-grant queries, or
 * a filter below stops matching, the suite would silently compare nothing and
 * pass. This is the assertion that turns that into a failure.
 */
const MIN_QUERIES = 8;

let fixture: McpFixture;

/** The corpus's own two credentials, as U18 scopes them. */
const PERSONAL_CLASS = 'personal';
const WORK_CLASS = 'work';

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_equivalence');
  const embeddings = loadEmbeddings(await Bun.file(MANIFEST_PATH).text(), corpusTexts(CORPUS));
  await seedCorpus(fixture.sql, CORPUS, {
    index: embeddings,
    contradictions: CORPUS_INPUT.contradictions,
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

/**
 * Twin grants: identical scope, one bound to each endpoint.
 *
 * **Endpoint binding is not relaxed to make this test convenient.**
 * `dispatch.ts` refuses a grant whose `endpoint` claim differs from the surface
 * it arrives at — a token minted for the portable surface presenting itself at
 * the ChatGPT surface is a different advertised tool set and a different consent
 * story. So equivalence is established between two *credentials* that are equal
 * in everything except the endpoint they name, which is the real-world shape:
 * one person, two connectors, one brain.
 */
function twinGrants(contextClass: string): Record<Endpoint, string> {
  const agent = agentOriginFor(contextClass);
  const base: Omit<GrantClaims, 'endpoint'> = {
    grantId: `g-equiv-${contextClass}`,
    tenantId: fixture.tenantId,
    scope: 'narrowed',
    origins: [`${contextClass}:*`],
    writeOrigin: agent,
    clientId: 'client-equivalence',
    issuedAt: fixture.now(),
    expiresAt: fixture.now() + 3_600_000,
  };
  const key = deriveSigningKey(fixture.bearer);
  return {
    mcp: mintAccessToken({ ...base, endpoint: 'mcp' }, key),
    openai: mintAccessToken({ ...base, endpoint: 'openai' }, key),
  };
}

function classOfGrant(grant: readonly OriginContext[]): string {
  return classOf(grant[0] ?? 'personal:mail') ?? PERSONAL_CLASS;
}

/** The corpus queries this suite drives, with the class each is asked under. */
const DRIVEN = CORPUS.queries.map((query) => ({
  id: query.id,
  text: query.text,
  contextClass: classOfGrant(query.grant),
}));

describe('the suite is driving a real corpus, not two empty lists', () => {
  test('the blocking tier\'s corpus is seeded and its queries are being asked', () => {
    expect(DRIVEN.length).toBeGreaterThanOrEqual(MIN_QUERIES);
    // Both credentials are exercised. A suite that only ever asked the personal
    // grant would never see a narrowing difference between the surfaces.
    expect(new Set(DRIVEN.map((q) => q.contextClass))).toEqual(
      new Set([PERSONAL_CLASS, WORK_CLASS]),
    );
  });

  test(
    'and at least one query returns results on both surfaces',
    async () => {
      const grants = twinGrants(PERSONAL_CLASS);
      let answered = 0;
      for (const query of DRIVEN.filter((q) => q.contextClass === PERSONAL_CLASS).slice(0, 12)) {
        const viaMcp = await fixture.call(
          'recall',
          { query: query.text },
          { authorization: `Bearer ${grants.mcp}`, endpoint: 'mcp' },
        );
        const results = (viaMcp.content as { results: unknown[] } | null)?.results ?? [];
        if (results.length > 0) answered += 1;
      }
      // Not "some query somewhere": the whole comparison below is worthless if
      // this number is zero, so it is asserted before anything is compared.
      expect(answered).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the same identity gets the same answers through /mcp and /openai', () => {
  test(
    'every corpus query returns the same ids, in the same order, on both surfaces',
    async () => {
      let compared = 0;
      let nonEmpty = 0;

      for (const query of DRIVEN) {
        const grants = twinGrants(query.contextClass);

        const viaRecall = await fixture.call(
          'recall',
          { query: query.text },
          { authorization: `Bearer ${grants.mcp}`, endpoint: 'mcp' },
        );
        const viaSearch = await fixture.call(
          'search',
          { query: query.text },
          { authorization: `Bearer ${grants.openai}`, endpoint: 'openai' },
        );

        expect(viaRecall.ok, `${query.id} failed on /mcp`).toBe(true);
        expect(viaSearch.ok, `${query.id} failed on /openai`).toBe(true);

        const recallIds = (viaRecall.content as { results: { id: string }[] }).results.map((r) => r.id);
        const searchIds = (viaSearch.content as { results: { id: string }[] }).results.map((r) => r.id);

        // Order, not membership. A projection that ran its own query with its
        // own limit produces a different list; a set comparison would hide a
        // reordering that changes what the model reads first.
        expect(searchIds, `${query.id}: /openai and /mcp disagree`).toEqual(recallIds);

        compared += 1;
        if (recallIds.length > 0) nonEmpty += 1;
      }

      expect(compared).toBe(DRIVEN.length);
      // **The trap, closed.** Two empty lists are equal, so a suite that
      // compared only unanswerable queries would be green and meaningless.
      expect(nonEmpty).toBeGreaterThanOrEqual(MIN_QUERIES);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'fetch and recall({id}) return the same record body on their own surfaces',
    async () => {
      // The delimiter is minted per *response*, so two live responses differ in
      // their nonce by design. What is compared is the body between them, with
      // one fixed nonce source so the wrappers line up.
      const { dispatch } = await import('../../src/mcp/dispatch.ts');
      const grants = twinGrants(PERSONAL_CLASS);
      const deps = { ...fixture.deps, nonceSource: () => new Uint8Array(16).fill(0x11) };

      const seedIds = await fixture.sql`
        SELECT chunk_id::text AS chunk_id FROM chunk
         WHERE origin_context LIKE 'personal:%' AND deleted_at IS NULL AND quarantined_at IS NULL
         ORDER BY chunk_id LIMIT 12
      ` as Array<{ chunk_id: string }>;
      expect(seedIds.length).toBeGreaterThan(0);

      let compared = 0;
      for (const row of seedIds) {
        const id = `chunk:${row.chunk_id}`;
        const viaFetch = await dispatch(
          { ...deps, endpoint: 'openai' },
          { authorization: `Bearer ${grants.openai}`, tool: 'fetch', args: { id } },
        );
        const viaRecall = await dispatch(
          { ...deps, endpoint: 'mcp' },
          { authorization: `Bearer ${grants.mcp}`, tool: 'recall', args: { id } },
        );

        expect(viaFetch.ok, id).toBe(true);
        expect(viaRecall.ok, id).toBe(true);

        const fetched = viaFetch.content as { text: string; title: string | null };
        const recalled = (viaRecall.content as { results: { text: string; title: string | null }[] })
          .results[0];
        expect(recalled, id).toBeDefined();
        expect(fetched.text, id).toBe(recalled?.text ?? '');
        expect(fetched.title, id).toBe(recalled?.title ?? null);
        compared += 1;
      }
      expect(compared).toBe(seedIds.length);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a refusal is the same refusal on both surfaces',
    async () => {
      // Equivalence of the *error* surface, which is where two implementations
      // usually diverge first: one returns `not_found` where the other returns
      // `scope_denied`, and the difference is an isolation claim.
      const grants = twinGrants(WORK_CLASS);

      const personalChunk = await fixture.sql`
        SELECT chunk_id::text AS chunk_id FROM chunk
         WHERE origin_context LIKE 'personal:%' AND deleted_at IS NULL
         ORDER BY chunk_id LIMIT 1
      ` as Array<{ chunk_id: string }>;
      const outOfGrant = `chunk:${personalChunk[0]?.chunk_id}`;
      const absent = 'chunk:999999999';

      for (const [id, expected] of [
        [outOfGrant, 'scope_denied'],
        [absent, 'not_found'],
        ['not-an-id', 'invalid_params'],
      ] as const) {
        const viaFetch = await fixture.call(
          'fetch',
          { id },
          { authorization: `Bearer ${grants.openai}`, endpoint: 'openai' },
        );
        const viaRecall = await fixture.call(
          'recall',
          { id },
          { authorization: `Bearer ${grants.mcp}`, endpoint: 'mcp' },
        );
        expect(viaFetch.error?.code, `fetch ${id}`).toBe(expected);
        expect(viaRecall.error?.code, `recall ${id}`).toBe(expected);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'entity and brain answer identically on both surfaces',
    async () => {
      // The tools advertised on BOTH endpoints. Their equivalence is not a
      // projection property — it is the property that the endpoint changes only
      // the advertised list, never the answer.
      const grants = twinGrants(PERSONAL_CLASS);
      const shared = advertisedTools('mcp')
        .map((tool) => tool.name)
        .filter((name) => advertisedTools('openai').some((tool) => tool.name === name));
      expect(shared).toContain('entity');
      expect(shared).toContain('brain');

      // The demarcation delimiter is minted per *response*, so two live calls
      // differ in their nonce by construction. Pinning the source is what makes
      // this a comparison of the two answers rather than of two nonces — the
      // same reason the fetch/recall comparison above pins it.
      const { dispatch } = await import('../../src/mcp/dispatch.ts');
      const pinned = { ...fixture.deps, nonceSource: () => new Uint8Array(16).fill(0x22) };

      const name = [...CORPUS.entities.values()][0]?.canonicalName ?? 'Acme Example';
      const viaMcp = await dispatch(
        { ...pinned, endpoint: 'mcp' },
        { authorization: `Bearer ${grants.mcp}`, tool: 'entity', args: { name } },
      );
      const viaOpenai = await dispatch(
        { ...pinned, endpoint: 'openai' },
        { authorization: `Bearer ${grants.openai}`, tool: 'entity', args: { name } },
      );
      // `latency_ms` and `cold_start` are observations of the call, not answers,
      // so they are dropped before comparison rather than making the test flake.
      const strip = (content: unknown) => {
        const { latency_ms: _l, cold_start: _c, ...rest } = content as Record<string, unknown>;
        return rest;
      };
      // Non-empty first: two identical "not found" cards would compare equal and
      // prove nothing, which is this suite's whole trap one tool over.
      expect((strip(viaMcp.content) as { found?: boolean }).found).toBe(true);
      expect(strip(viaOpenai.content)).toEqual(strip(viaMcp.content));

      const brainMcp = await fixture.call(
        'brain',
        {},
        { authorization: `Bearer ${grants.mcp}`, endpoint: 'mcp' },
      );
      const brainOpenai = await fixture.call(
        'brain',
        {},
        { authorization: `Bearer ${grants.openai}`, endpoint: 'openai' },
      );
      const counts = (result: typeof brainMcp) => (result.content as { counts: unknown }).counts;
      const origins = (result: typeof brainMcp) => (result.content as { origins: unknown }).origins;
      expect(counts(brainOpenai)).toEqual(counts(brainMcp));
      // The grant is the same grant on both surfaces — which is the U18 claim
      // this suite adds to U6's: the new fence narrows identically either side.
      expect(origins(brainOpenai)).toEqual(origins(brainMcp));
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the /openai wire contract, as OpenAI publishes it', () => {
  /** Drive the real HTTP server, so the assertions are about the wire. */
  function server() {
    return createMcpServer({
      ...fixture.deps,
      issuer: 'https://brainz.test',
      registrationAllowlist: { redirectUris: [], maxRegistrationsPerHour: 0 },
    });
  }

  async function rpc(token: string, tool: string, args: Record<string, unknown>) {
    const response = await server().fetch(
      new Request('https://brainz.test/openai', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      }),
    );
    return (await response.json()) as {
      result: { content: { type: string; text: string }[]; structuredContent: Record<string, unknown> };
    };
  }

  test(
    'structuredContent and the text content block are the same value, not a summary of it',
    async () => {
      const grants = twinGrants(PERSONAL_CLASS);
      const body = await rpc(grants.openai, 'search', { query: DRIVEN[0]?.text ?? 'renewal' });

      expect(body.result.content[0]?.type).toBe('text');
      // The mandate is literally "the same value as a JSON-encoded string in the
      // content array". A text block that *summarised* the structured one is how
      // the two lanes come to describe different worlds.
      expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toEqual(body.result.structuredContent);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every search result carries the three mandated fields and a non-empty url',
    async () => {
      const grants = twinGrants(PERSONAL_CLASS);
      let checked = 0;

      for (const query of DRIVEN.filter((q) => q.contextClass === PERSONAL_CLASS).slice(0, 10)) {
        const body = await rpc(grants.openai, 'search', { query: query.text });
        const results = (body.result.structuredContent.results ?? []) as Record<string, unknown>[];
        for (const row of results) {
          expect(Object.keys(row).sort()).toEqual(['id', 'title', 'url']);
          // "ChatGPT creates citation metadata only when `url` is a non-empty
          // string." An empty url is a silently uncited answer, not an error.
          expect(typeof row.url === 'string' && (row.url as string).length > 0).toBe(true);
          // A titleless row falls back to a demarcated excerpt; `undefined`
          // would make the title — which on this shape is the whole of what the
          // model sees — vanish from the payload entirely.
          expect(row.title).toBeDefined();
          expect(typeof row.title).toBe('string');
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'fetch returns the mandated object with a non-empty url and its metadata block',
    async () => {
      const grants = twinGrants(PERSONAL_CLASS);
      const row = (await fixture.sql`
        SELECT chunk_id::text AS chunk_id FROM chunk
         WHERE origin_context LIKE 'personal:%' AND deleted_at IS NULL
         ORDER BY chunk_id LIMIT 1
      `) as Array<{ chunk_id: string }>;

      const body = await rpc(grants.openai, 'fetch', { id: `chunk:${row[0]?.chunk_id}` });
      const fetched = body.result.structuredContent;

      for (const field of ['id', 'title', 'text', 'url', 'metadata']) {
        expect(fetched[field], field).toBeDefined();
      }
      expect(typeof fetched.url === 'string' && (fetched.url as string).length > 0).toBe(true);
      expect(typeof fetched.text).toBe('string');
      expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toEqual(fetched);
    },
    TEST_TIMEOUT_MS,
  );
});
