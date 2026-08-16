/**
 * The adversarial pass over U6 — the surface a stranger can reach.
 *
 * Every case here is written as the attack rather than as the behaviour, because
 * the failures this file exists to catch are all *silent*: a fence that admits,
 * a refusal that answers a question it was not asked, a cascade that reaches
 * further than the read that authorised it. None of them look wrong from inside
 * a green suite that only ever drives the happy grant.
 *
 * Four questions, and each has its own section:
 *
 *   1. **Can one credential learn about another tenant?** Not read its rows —
 *      the database boundary is structural — but learn that it *exists*. A
 *      distinct error message is a disclosure channel with no content in it,
 *      which is exactly the shape a content-free surface stops noticing.
 *   2. **Can one origin's content cross the fence sideways?** Not through the
 *      row that carries it, which every read tool fences, but through a *join*
 *      that fenced the parent and then aggregated the children.
 *   3. **Can a read refusal be turned into a write?** `forget`'s cascade is
 *      authorised by the fence on the row named in the call; every row it then
 *      reaches has an origin union of its own.
 *   4. **Is the edge actually in front of the thing it protects, and can it
 *      run where it is deployed?** A limiter that throws in production is a
 *      limiter that was never tested where it lives.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { handleFleetRequest } from '../../src/mcp/edge.ts';
import { createEdgeLimiter } from '../../src/mcp/rate-limit.ts';
import {
  deriveSigningKey,
  mintAccessToken,
  mintTenantBearer,
  type GrantClaims,
} from '../../src/mcp/oauth.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { agentOriginFor, classOf } from '../../src/mcp/grant-scope.ts';
import { AGENT_ORIGIN, createMcpFixture, seedEntity, seedFact, seedPage, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const PERSONAL = 'personal:mail';
const WORK = 'work:mail';

const SECRET_LINE = 'The personal severance figure is four hundred thousand dollars.';
const SECRET_SUBJECT = 'Re: the personal severance offer, confidential';

let fixture: McpFixture;
let workPageId = '';
let smuggledChunkId = '';
let orphanChunkId = '';
let crossOriginFactId = '';
let workOnlyFactId = '';

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_adversarial');
  const { sql } = fixture;

  const workChunks = await seedPage(sql, {
    id: 'work-brief',
    title: 'Platform team brief',
    sourceType: 'email',
    origin: WORK,
    createdAt: '2026-06-02',
    paragraphs: ['The platform team shipped the ingest queue this week.'],
  });

  const personalChunks = await seedPage(sql, {
    id: 'personal-terms',
    title: 'Personal terms',
    sourceType: 'email',
    origin: PERSONAL,
    createdAt: '2026-06-01',
    paragraphs: ['The personal renewal price is nine hundred dollars.'],
  });

  const pages = (await sql`
    SELECT page_id::text AS page_id FROM page WHERE title = 'Platform team brief'
  `) as Array<{ page_id: string }>;
  workPageId = pages[0]?.page_id ?? '';

  // A chunk carrying a personal origin, hanging off a work page. Nothing in the
  // schema forbids it — `chunk.origin_context` is its own credential-derived
  // column, which is why `indexState` counts chunks separately from pages — so
  // a read that fences the page and then aggregates its chunks is reading
  // across the fence.
  const smuggled = (await sql`
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    VALUES (${PERSONAL}, ${SECRET_LINE}, ${workPageId}::bigint, 1)
    RETURNING chunk_id::text AS chunk_id
  `) as Array<{ chunk_id: string }>;
  smuggledChunkId = smuggled[0]?.chunk_id ?? '';

  // The mirror image: a work passage hanging off a personal page, whose title
  // is a sentence its sender chose.
  const carrier = (await sql`
    INSERT INTO page (origin_context, source_type, title, created_at,
                      embedding_model, embedding_dimensions, chunker_version,
                      normalizer_version, content_sha256)
    VALUES (${PERSONAL}, 'email', ${SECRET_SUBJECT}, '2026-06-04'::timestamptz,
            'fixture-model', 1536, 1, 1, ${'0'.repeat(64)})
    RETURNING page_id::text AS page_id
  `) as Array<{ page_id: string }>;
  const orphan = (await sql`
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    VALUES (${WORK}, 'A work passage filed under someone else''s document.',
            ${carrier[0]?.page_id ?? ''}::bigint, 0)
    RETURNING chunk_id::text AS chunk_id
  `) as Array<{ chunk_id: string }>;
  orphanChunkId = orphan[0]?.chunk_id ?? '';

  // Two entities with one name, in two origins, personal inserted first so the
  // unordered lookup below meets it first.
  await seedEntity(sql, {
    slug: 'ada-example-personal',
    name: 'Ada Example',
    type: 'person',
    origins: [PERSONAL],
  });
  await seedEntity(sql, {
    slug: 'ada-example-work',
    name: 'Ada Example',
    type: 'person',
    origins: [WORK],
  });

  // A fact synthesised across both origins. The subset rule refuses it to a
  // work-only grant — so nothing a work-only grant does may retract it either.
  crossOriginFactId = await seedFact(sql, {
    statement: 'Ada Example negotiated both the personal renewal and the platform contract.',
    origins: [PERSONAL, WORK],
    chunkIds: [personalChunks[0] ?? '', workChunks[0] ?? ''],
    createdAt: '2026-06-05',
  });

  workOnlyFactId = await seedFact(sql, {
    statement: 'The platform team owns the ingest queue.',
    origins: [WORK],
    chunkIds: [workChunks[0] ?? ''],
    createdAt: '2026-06-06',
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

/**
 * A signed grant narrower than the tenant bearer carries.
 *
 * **U18 makes the write origin part of the grant rather than a constant.** A
 * narrowed grant whose `writeOrigin` sits outside its own origins is refused at
 * the credential now (`grant-scope.ts`), because it plants rows it can never
 * read back. So the helper derives the write origin from the origins it was
 * given and adds the matching agent origin to the grant — which is what a real
 * work-connector grant looks like, and what this helper was quietly not
 * expressing when it hardcoded `personal:agent` beside `['work:mail']`.
 */
function tokenFor(origins: readonly string[]): string {
  const agent = agentOriginFor(classOf(origins[0] ?? AGENT_ORIGIN) ?? 'personal');
  const claims: GrantClaims = {
    grantId: `g-${origins.join('-')}`,
    tenantId: fixture.tenantId,
    scope: 'narrowed',
    origins: [...origins, agent],
    writeOrigin: agent,
    endpoint: 'mcp',
    clientId: 'client-adversarial',
    issuedAt: fixture.now(),
    expiresAt: fixture.now() + 3_600_000,
  };
  return mintAccessToken(claims, deriveSigningKey(fixture.bearer));
}

// ---------------------------------------------------------------------------
// 1. The cross-tenant existence oracle.
// ---------------------------------------------------------------------------

describe('a refusal answers only the question it was asked', () => {
  test(
    'a credential naming a tenant that exists is refused exactly as one naming a tenant that does not',
    async () => {
      // Same shape, same alphabet, same length. The only difference is whether
      // the fleet has ever provisioned that tenant.
      const forAKnownTenant = mintTenantBearer(fixture.tenantId);
      const forAnUnknownTenant = mintTenantBearer('t-no-such-tenant');

      const known = await fixture.call('brain', {}, { authorization: `Bearer ${forAKnownTenant}` });
      const unknown = await fixture.call('brain', {}, { authorization: `Bearer ${forAnUnknownTenant}` });

      expect(known.ok).toBe(false);
      expect(unknown.ok).toBe(false);
      expect(known.error?.code).toBe('unauthorized');
      expect(unknown.error?.code).toBe('unauthorized');

      // The disclosure: a distinct message tells an unauthenticated caller which
      // tenant ids this fleet serves. It carries no row content, which is
      // precisely why a content-free surface stops looking at it.
      expect(unknown.error?.message).toBe(known.error?.message);
    },
    TEST_TIMEOUT_MS,
  );

  test('every unauthorized refusal on the surface speaks with one voice', async () => {
    const messages = new Set<string>();
    for (const authorization of [
      null,
      'Bearer not-a-token-at-all',
      `Bearer ${mintTenantBearer('t-no-such-tenant')}`,
      `Bearer ${mintTenantBearer(fixture.tenantId)}`,
    ]) {
      const result = await fixture.call('brain', {}, { authorization });
      expect(result.error?.code).toBe('unauthorized');
      messages.add(result.error?.message ?? '');
    }
    expect(messages.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Sideways across the fence, through a join.
// ---------------------------------------------------------------------------

describe('the fence survives a join', () => {
  test(
    'a page read does not carry the body of a passage from an origin the grant does not hold',
    async () => {
      const result = await fixture.call(
        'fetch',
        { id: `doc:${workPageId}` },
        { authorization: `Bearer ${tokenFor([WORK])}` },
      );

      expect(result.ok).toBe(true);
      const content = result.content as { text: string };
      expect(content.text).toContain('ingest queue');
      expect(content.text).not.toContain(SECRET_LINE);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a briefing does not carry the body of a passage from an origin the grant does not hold',
    async () => {
      const result = await fixture.call(
        'briefing',
        { since: '2026-05-01', until: '2026-07-01' },
        { authorization: `Bearer ${tokenFor([WORK])}` },
      );

      expect(result.ok).toBe(true);
      // Every lane of the bundle, not just the delta: U12 added meetings,
      // commitments, participant cards and the stale list, and a fence that
      // held on one of five lanes would be a fence that leaks through four.
      expect(JSON.stringify(result.content)).not.toContain(SECRET_LINE);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a passage read does not carry the title of a document from an origin the grant does not hold',
    async () => {
      const result = await fixture.call(
        'fetch',
        { id: `chunk:${orphanChunkId}` },
        { authorization: `Bearer ${tokenFor([WORK])}` },
      );

      expect(result.ok).toBe(true);
      const content = result.content as { title: string | null; text: string };
      expect(content.text).toContain('work passage');
      // A subject line is chosen by whoever sent the mail, and on the `/openai`
      // shape it is the whole of what a model sees. It is row content, and the
      // fence applies to it.
      expect(JSON.stringify(content)).not.toContain(SECRET_SUBJECT);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the out-of-grant passage is still refused when addressed directly, which is what makes the leak a leak',
    async () => {
      const direct = await fixture.call(
        'fetch',
        { id: `chunk:${smuggledChunkId}` },
        { authorization: `Bearer ${tokenFor([WORK])}` },
      );
      expect(direct.ok).toBe(false);
      expect(direct.error?.code).toBe('scope_denied');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('name resolution resolves inside the grant first', () => {
  test(
    'an entity the grant holds is returned even when another origin holds one by the same name',
    async () => {
      const result = await fixture.call(
        'entity',
        { name: 'Ada Example' },
        { authorization: `Bearer ${tokenFor([WORK])}` },
      );

      // The failure this pins: the lookup takes an arbitrary row from an
      // unordered, unfenced match and then fences it, so a grant's access to its
      // own entity depends on whether a neighbouring origin happens to hold a
      // row with the same name — and on which one the planner returns first.
      expect(result.ok).toBe(true);
      const content = result.content as { found: boolean; card: { origins?: string[] } };
      expect(content.found).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. A read refusal turned into a write.
// ---------------------------------------------------------------------------

describe('forget reaches no further than the fence that authorised it', () => {
  test(
    'retracting a document does not tombstone a fact the same grant may not read',
    async () => {
      const authorization = `Bearer ${tokenFor([WORK])}`;

      // The premise: this grant cannot read the cross-origin fact at all.
      const readBack = await fixture.call('fetch', { id: `fact:${crossOriginFactId}` }, { authorization });
      expect(readBack.error?.code).toBe('scope_denied');
      const directRetraction = await fixture.call('forget', { id: `fact:${crossOriginFactId}` }, { authorization });
      expect(directRetraction.error?.code).toBe('scope_denied');

      // The attack: retract the work page it is partly sourced from instead.
      const cascade = await fixture.call('forget', { id: `doc:${workPageId}` }, { authorization });
      expect(cascade.ok).toBe(true);

      const rows = (await fixture.sql`
        SELECT fact_id::text AS fact_id, deleted_at
          FROM fact
         WHERE fact_id IN (${crossOriginFactId}::bigint, ${workOnlyFactId}::bigint)
      `) as Array<{ fact_id: string; deleted_at: string | null }>;

      const crossOrigin = rows.find((row) => row.fact_id === crossOriginFactId);
      const workOnly = rows.find((row) => row.fact_id === workOnlyFactId);

      // The work-only fact is exactly what the cascade is for.
      expect(workOnly?.deleted_at).not.toBeNull();
      // The cross-origin synthesis is not: a credential that cannot read a row
      // must not be able to retract it by naming one of its sources.
      expect(crossOrigin?.deleted_at).toBeNull();

      // The same rule one row lower down. A passage carries its own scalar
      // origin, so a page cascade that took every child by `page_id` would
      // retract a passage this grant cannot read either.
      const passages = (await fixture.sql`
        SELECT deleted_at FROM chunk WHERE chunk_id = ${smuggledChunkId}::bigint
      `) as Array<{ deleted_at: string | null }>;
      expect(passages[0]?.deleted_at).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The edge, where it is deployed.
// ---------------------------------------------------------------------------

describe('the edge runs where it is deployed', () => {
  test('the Worker module graph uses no Bun-only global', () => {
    // `wrangler.toml` names `src/mcp/router.ts` as the Worker entry, and the
    // Worker runs in workerd, where `Bun` does not exist. A reference here is
    // not a slow path or a portability wart: it is a ReferenceError thrown out
    // of the admission call on the very first production request — outside the
    // limiter's own try/catch, so it does not even become a refusal.
    for (const path of [
      'src/mcp/edge.ts',
      'src/mcp/rate-limit.ts',
      'src/mcp/oauth.ts',
      'src/control/secrets.ts',
    ]) {
      const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect({ path, hit: /\bBun\s*\./.test(withoutComments) }).toEqual({ path, hit: false });
      expect({ path, hit: /from\s+['"]bun['"]/.test(withoutComments) }).toEqual({ path, hit: false });
    }
  });

  test('the discovery documents a connector reads first are reachable without a credential', async () => {
    const reached: string[] = [];
    const fleet = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: (): Promise<Response> => {
          reached.push(id.name);
          return Promise.resolve(Response.json({ ok: true }));
        },
      }),
    };
    const limiter = createEdgeLimiter({ now: () => Date.now() });

    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/register',
      '/token',
    ]) {
      const response = await handleFleetRequest(
        new Request(`https://mcp.brainz.test${path}`, {
          method: 'POST',
          headers: { 'cf-connecting-ip': '198.51.100.9' },
          body: '{}',
        }),
        { fleet, limiter },
      );
      // A 401 here is a connector that can never begin: the flow's first three
      // hops carry no bearer by construction.
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    expect(reached.length).toBe(4);
  });

  test('every hop of one authorization flow lands on the same instance', async () => {
    const addressed: string[] = [];
    const fleet = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => {
        addressed.push(id.name);
        return { fetch: (): Promise<Response> => Promise.resolve(Response.json({ ok: true })) };
      },
    };
    const limiter = createEdgeLimiter({ now: () => Date.now() });
    const bearer = mintTenantBearer('t-flow');

    for (const [path, credential] of [
      ['/register', null],
      ['/authorize', bearer],
      ['/token', null],
    ] as const) {
      const headers: Record<string, string> = { 'cf-connecting-ip': '198.51.100.10' };
      if (credential !== null) headers.authorization = `Bearer ${credential}`;
      await handleFleetRequest(
        new Request(`https://mcp.brainz.test${path}`, { method: 'POST', headers, body: '{}' }),
        { fleet, limiter },
      );
    }

    // The registration, the code and the refresh record all live in one
    // in-memory store. Three hops addressed to three instances is a flow that
    // cannot complete, and it fails as `invalid_grant` — which reads as a client
    // bug rather than as routing.
    //
    // Both halves matter: all three hops must be *addressed* (a 401 at the edge
    // addresses nothing and would satisfy a set-size assertion vacuously), and
    // the three must be one name.
    expect(addressed.length).toBe(3);
    expect(new Set(addressed).size).toBe(1);
  });

  test('a revocation lands on the instance whose store every tool call consults', async () => {
    const addressed: string[] = [];
    const fleet = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => {
        addressed.push(id.name);
        return { fetch: (): Promise<Response> => Promise.resolve(Response.json({ ok: true })) };
      },
    };
    const limiter = createEdgeLimiter({ now: () => Date.now() });

    await handleFleetRequest(
      new Request('https://mcp.brainz.test/revoke', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '198.51.100.11',
          authorization: `Bearer ${mintTenantBearer('t-revoker')}`,
        },
        body: 'grant_id=g-anything',
      }),
      { fleet, limiter },
    );

    // The revocation list is the one piece of flow state `dispatch` reads, and
    // it reads it on the tenant's own instance. A revocation recorded on the
    // shared flow instance answers 200 and changes nothing.
    expect(addressed).toEqual(['t-revoker']);
  });
});

describe('revocation is not an open endpoint', () => {
  test('an unauthenticated caller cannot retire a grant', async () => {
    const server = createMcpServer({
      ...fixture.deps,
      issuer: 'https://mcp.brainz.test',
      registrationAllowlist: { redirectUris: ['https://claude.ai/cb'], maxRegistrationsPerHour: 10 },
    });

    const response = await server.fetch(
      new Request('https://mcp.brainz.test/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_id=g-victim',
      }),
    );

    expect(response.status).toBe(401);
    expect(fixture.store.isRevoked('g-victim')).toBe(false);
  });

  test('the tenant holding the bearer can still revoke', async () => {
    const server = createMcpServer({
      ...fixture.deps,
      issuer: 'https://mcp.brainz.test',
      registrationAllowlist: { redirectUris: ['https://claude.ai/cb'], maxRegistrationsPerHour: 10 },
    });

    const response = await server.fetch(
      new Request('https://mcp.brainz.test/revoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Bearer ${fixture.bearer}`,
        },
        body: 'grant_id=g-mine',
      }),
    );

    expect(response.status).toBe(200);
    expect(fixture.store.isRevoked('g-mine')).toBe(true);
  });
});
