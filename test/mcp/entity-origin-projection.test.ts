/**
 * The origin *union* of a shared entity is not a thing a narrowed grant may be
 * told.
 *
 * ============================================================================
 * WHY THIS IS A LEAK AND NOT A LABEL
 * ============================================================================
 *
 * `fence.ts` fences `entity` on **intersect**, and says exactly why: an entity
 * is a *name*, and a subset rule would refuse to resolve any name appearing in
 * both halves of a brain — which is most of the interesting ones. The licence
 * for that looser rule is the sentence beside it: *"Resolving a name is not
 * reading a row. Every row the fan-out then produces — the edges, the facts, the
 * chunks — goes back through the subset and scalar rules."*
 *
 * `entity.origin_contexts` is a row attribute, not the name. Handing it back
 * whole tells a `work:mail` grant that the person it just resolved also appears
 * in a mailbox it may not read — which is a fact about the personal mailbox,
 * inferred with no page, no chunk and no fact ever crossing. It is the smallest
 * possible disclosure of exactly the thing U18's fence exists to prevent, and a
 * sibling already closed the same shape one column over (`entity_alias`, whose
 * personal-origin spelling was being handed to every work grant that could
 * resolve the entity).
 *
 * ============================================================================
 * WHY THE INTERSECTION, AND NOT NOTHING
 * ============================================================================
 *
 * The intersection is what the caller already holds, so it discloses nothing;
 * and it keeps the field doing its job, which is attribution — "this is the
 * work-mail Acme, as far as you are concerned".
 *
 * `[]` was the other candidate and it is worse for a reason specific to this
 * codebase: **an empty origin array already means something here, and it does
 * not mean "redacted".** `fence.ts:fenceRow` refuses one, `demarcation.ts:
 * isExternalUnion` calls one external, and the DDL forbids `origin_contexts`
 * from being empty at all. Every reader in the system treats an empty union as
 * *a write-path bug, read fail-closed*. Synthesising that value as a privacy
 * measure overloads a sentinel, and the next reader cannot tell "we hid this"
 * from "this row is broken". It is also simply false: the entity does have
 * origins, and the caller holds one of them.
 *
 * ============================================================================
 * THE SIBLINGS, AND WHY TWO OF THEM STAY AS THEY ARE
 * ============================================================================
 *
 * Three places project an entity's union. They are the same *shape* and not the
 * same *role*, and narrowing all three would trade a disclosure for a weaker
 * demarcation:
 *
 *   * `reads.ts:entityCard` → `EntityCard.origins`. **Caller-facing
 *     attribution.** Narrowed. This is the site the verifier observed live.
 *   * `reads.ts:fetchEntity` → `Record_.origins`. **A trust input**, consumed by
 *     `tools/context.ts:project` to decide R2a demarcation and by nothing else.
 *     The union is the correct input there and the intersection is not: an
 *     entity whose canonical name was written by an outside sender in an origin
 *     this grant does not hold is still attacker-authored text, and intersecting
 *     first can flip `isExternalUnion` from true to false — a name that used to
 *     arrive inside the untrusted region arriving outside it.
 *   * `briefing/assemble.ts:readParticipants` → `BriefingParticipant.origins`.
 *     The same trust input, for the participant card, with the same argument.
 *
 * What makes leaving those two safe is structural rather than remembered, and
 * the last two tests below are what check it: `project()` — the one function
 * every content-returning shape goes through — has no `origins` field in its
 * output at all, and a narrowed grant's *entire serialised response*, from every
 * advertised tool, contains no origin string the grant does not hold. A future
 * handler that renders `record.origins` for attribution fails the second one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { visibleOrigins } from '../../src/core/search/fence.ts';
import { entityCard } from '../../src/mcp/reads.ts';
import { deriveSigningKey, mintAccessToken, type GrantClaims } from '../../src/mcp/oauth.ts';
import { project } from '../../src/mcp/tools/context.ts';
import { TOOL_NAMES } from '../../src/mcp/tools/index.ts';
import { createMcpFixture, seedEntity, seedFact, seedPage, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK_MAIL = 'work:mail';
const WORK_AGENT = 'work:agent';
const PERSONAL_MAIL = 'personal:mail';
const PERSONAL_AGENT = 'personal:agent';

/** The name both halves of the brain know. Resolvable under either grant. */
const SHARED_NAME = 'Acme Example';

let fixture: McpFixture;
let sharedEntityId = '';
let workChunkId = '';
let personalChunkId = '';

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_entity_origins');
  const { sql } = fixture;

  const workChunks = await seedPage(sql, {
    id: 'work-acme',
    title: 'Acme renewal',
    sourceType: 'email',
    origin: WORK_MAIL,
    createdAt: '2026-06-02',
    paragraphs: ['Acme Example confirmed the renewal date with the platform team.'],
  });
  workChunkId = workChunks[0] ?? '';

  const personalChunks = await seedPage(sql, {
    id: 'personal-acme',
    title: 'Acme invoice',
    sourceType: 'email',
    origin: PERSONAL_MAIL,
    createdAt: '2026-06-03',
    paragraphs: ['Acme Example sent the invoice to the home address.'],
  });
  personalChunkId = personalChunks[0] ?? '';

  // The shape the whole file is about: one name, two origins. `fence.ts`
  // resolves it under either grant on purpose.
  sharedEntityId = await seedEntity(sql, {
    slug: 'acme-example',
    name: SHARED_NAME,
    type: 'organization',
    origins: [PERSONAL_MAIL, WORK_MAIL],
  });
  await sql`
    INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
    VALUES (${sharedEntityId}::bigint, 'acme example', 'user', ARRAY[${WORK_MAIL}]::text[])
  `;

  await seedFact(sql, {
    statement: 'Acme Example renews in the third quarter.',
    origins: [WORK_MAIL],
    chunkIds: [workChunkId],
    createdAt: '2026-06-04',
  });
  await seedFact(sql, {
    statement: 'Acme Example billed the home address directly.',
    origins: [PERSONAL_MAIL],
    chunkIds: [personalChunkId],
    createdAt: '2026-06-05',
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

function tokenFor(origins: readonly string[], writeOrigin: string): string {
  const claims = {
    grantId: 'g-narrowed',
    tenantId: fixture.tenantId,
    origins,
    scope: 'narrowed',
    writeOrigin,
    endpoint: 'mcp',
    clientId: 'client-test',
    issuedAt: fixture.now(),
    expiresAt: fixture.now() + 3_600_000,
  } as GrantClaims;
  return mintAccessToken(claims, deriveSigningKey(fixture.bearer));
}

/**
 * The one id whose record carries a union wider than a narrowed grant.
 *
 * Chunks and pages are scalar-fenced and facts are subset-fenced, so an
 * id-addressed read of either returns a row whose every origin the caller
 * already holds — a sweep built only from those cannot go red however badly a
 * handler leaks. The shared **entity** is the exception and the whole point:
 * `fenceEntity` admits it on intersect, so `fetchRecord` returns a `Record_`
 * whose `origins` are `[personal:mail, work:mail]` to a work-only credential.
 * It is the id the sweep has to use.
 */
const MIXED_ID = (): string => `ent:${sharedEntityId}`;

/** Every argument shape a tool needs, so the sweep can call all of them. */
const ARGS_FOR: Readonly<Record<string, () => Record<string, unknown>>> = {
  recall: () => ({ query: 'Acme Example renewal invoice' }),
  search: () => ({ query: 'Acme Example renewal invoice' }),
  fetch: () => ({ id: MIXED_ID() }),
  entity: () => ({ name: SHARED_NAME }),
  briefing: () => ({}),
  remember: () => ({ statement: 'A memory written by the sweep.' }),
  forget: () => ({ id: `chunk:${workChunkId}` }),
  brain: () => ({}),
  manage: () => ({ action: 'set_spend_cap', value: '1000' }),
  synthesize: () => ({ query: 'anything' }),
};

// ---------------------------------------------------------------------------
// 0. The fixture. Without this, every absence below proves nothing.
// ---------------------------------------------------------------------------

describe('the entity really does span both halves', () => {
  test(
    'a grant holding both origins is told both',
    async () => {
      const outcome = await entityCard(fixture.sql, [WORK_MAIL, PERSONAL_MAIL], SHARED_NAME);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect([...outcome.card.origins].sort()).toEqual([PERSONAL_MAIL, WORK_MAIL]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 1. The violating case.
// ---------------------------------------------------------------------------

describe('a narrowed grant is told only what it holds', () => {
  test(
    'a work-scoped card does not report that a personal origin exists',
    async () => {
      const outcome = await entityCard(fixture.sql, [WORK_MAIL], SHARED_NAME);
      // The entity resolves — that is `fenceEntity`'s intersect rule and it is
      // deliberate. What must not come back with it is the other half.
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;

      // Stated as the violation first, because `toEqual` on the whole array
      // would also pass for a shape that returned nothing.
      expect(outcome.card.origins).not.toContain(PERSONAL_MAIL);
      expect([...outcome.card.origins]).toEqual([WORK_MAIL]);

      // And the field is not emptied, which is the other wrong answer: an empty
      // union is what `fenceRow` refuses and `isExternalUnion` calls external,
      // so synthesising one here would overload a sentinel that already means
      // "this row is broken".
      expect(outcome.card.origins.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the personal-scoped card is the mirror image, so this is a fence and not a filter',
    async () => {
      const outcome = await entityCard(fixture.sql, [PERSONAL_MAIL], SHARED_NAME);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect([...outcome.card.origins]).toEqual([PERSONAL_MAIL]);
      expect(outcome.card.origins).not.toContain(WORK_MAIL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the facts it carries are still subset-fenced, which is what makes intersect safe',
    async () => {
      const outcome = await entityCard(fixture.sql, [WORK_MAIL], SHARED_NAME);
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      const statements = outcome.card.facts.map((fact) => fact.text).join(' ');
      expect(statements).toContain('renews in the third quarter');
      expect(statements).not.toContain('home address');
      for (const fact of outcome.card.facts) {
        expect(fact.origins).not.toContain(PERSONAL_MAIL);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The siblings, checked structurally rather than by inspection.
// ---------------------------------------------------------------------------

describe('a union that stays a union cannot reach a caller', () => {
  test('the projection itself fails closed, the way every other rule in fence.ts does', () => {
    // An empty grant sees nothing, not everything — `fence.ts`'s standing rule,
    // applied to the disclosure as well as to the admission. Unreachable through
    // `entityCard` (the fence refuses first) and pinned anyway, because the
    // tempting "no grant, no filtering" reading is a whole-brain disclosure.
    expect(visibleOrigins([WORK_MAIL, PERSONAL_MAIL], [])).toEqual([]);
    expect(visibleOrigins([WORK_MAIL, PERSONAL_MAIL], [WORK_MAIL])).toEqual([WORK_MAIL]);
    // A row with no overlap yields nothing rather than the row's own union.
    expect(visibleOrigins([PERSONAL_MAIL], [WORK_MAIL])).toEqual([]);
  });


  test(
    'the one projection every content shape goes through emits no origins at all',
    async () => {
      // This is what licenses `Record_.origins` and `BriefingParticipant.origins`
      // to remain the full union: they are trust inputs to `demarcateIfExternal`,
      // and the function that consumes them does not pass them on. If somebody
      // adds an `origins` field to `ProjectedRecord` for attribution, they have
      // to intersect it, and this test is where they find out.
      const projected = project(
        {
          id: 'chunk:1',
          kind: 'chunk',
          title: 'A title',
          text: 'A body.',
          origins: [WORK_MAIL, PERSONAL_MAIL],
          sourceType: 'email',
          createdAt: '2026-06-01T00:00:00.000Z',
        },
        'nonce',
      );
      expect(Object.keys(projected)).not.toContain('origins');
      // And it did read them: an external union means the body is wrapped, so
      // this assertion is over a function that used the field rather than one
      // that ignores it.
      expect(projected.untrusted).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'no advertised tool puts an out-of-grant origin string anywhere in its response',
    async () => {
      // The per-field assertion tests the fields somebody remembered. This one
      // is over the entire serialised result — content, envelope, `_meta`, error
      // message — for every tool on the advertised list, so a tool added later is
      // covered without anyone editing this file.
      const authorization = `Bearer ${tokenFor([WORK_MAIL, WORK_AGENT], WORK_AGENT)}`;
      const forbidden = [PERSONAL_MAIL, PERSONAL_AGENT];

      // Every advertised tool, plus the id-addressed read of the one record
      // whose union is wider than the grant — see {@link MIXED_ID}. Without that
      // second half the sweep is a green tick over rows that could not have
      // leaked anything in the first place.
      const calls: Array<[string, Record<string, unknown>]> = [
        ...TOOL_NAMES.map((tool): [string, Record<string, unknown>] => {
          const args = ARGS_FOR[tool];
          expect(`${tool} has an argument shape`).toBe(
            args === undefined ? `${tool} is missing from ARGS_FOR` : `${tool} has an argument shape`,
          );
          return [tool, args === undefined ? {} : args()];
        }),
        ['recall', { id: MIXED_ID() }],
      ];

      // The fixture assertion for this sweep: the mixed record really is
      // readable under this grant, so an absence below is a fence holding rather
      // than a call that refused.
      const mixed = await fixture.call('fetch', { id: MIXED_ID() }, { authorization });
      expect(mixed.ok).toBe(true);
      expect(JSON.stringify(mixed.content)).toContain(SHARED_NAME);

      for (const [tool, args] of calls) {
        const result = await fixture.call(tool, args, { authorization });
        const serialised = JSON.stringify(result);
        for (const origin of forbidden) {
          expect(`${tool}: ${serialised.includes(origin) ? 'leaked' : 'clean'} ${origin}`).toBe(
            `${tool}: clean ${origin}`,
          );
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
