/**
 * Stage 3 — the three recall arms, against a real tenant database.
 *
 * **The headline guard is the candidate pool, and it is behavioural.** H1's card
 * says `hnsw.ef_search` sizes the HNSW candidate list and silently truncates the
 * pool; `candidatePoolFor` exists as a named function so that an arm passing a
 * bare `limit` is a visible mistake. But "visible" is a claim about reading, and
 * the hazard guards in `test/hazards/` cannot catch it: they call
 * `withVectorScan` directly, so what they pin is the helper's transaction
 * mechanics, not that the *arm* asked for a pool. A one-token mutation —
 * `candidatePool: candidatePoolFor(...)` → `candidatePool: limit` — leaves every
 * one of them green.
 *
 * So this file measures the arm's recall against a constructed distance ladder:
 * the sought row is the 90th nearest of 120, and `limit` is 10. With the pool
 * arithmetic the arm asks for 100 candidates and finds it; with `limit` it asks
 * for 10 and does not. The control arm below runs the **identical SQL** with the
 * wrong pool, so the assertion is a comparison rather than a hope — a fixture
 * that stopped exhibiting the truncation would fail the control and take the
 * guard down with it, instead of quietly passing.
 *
 * **The plan must be an index scan or the guard is theatre.** At fixture scale
 * Postgres prefers a sequential scan, which returns *exact* neighbours and full
 * recall — the mis-sized pool would then pass too. `enable_seqscan = off` is set
 * on the session (so it survives into `withVectorScan`'s own transaction), and
 * the control arm is what proves the force took: if the planner were still
 * seq-scanning, the control would find the row and this file would go red.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  CHANNEL_BY_SOURCE_TYPE,
  ftsArm,
  graphArm,
  hydrate,
  readFtsLanguage,
  runVectorScan,
  senderKeyFor,
  vectorArm,
} from '../../../src/core/search/arms.ts';
import { candidatePoolFor } from '../../../src/schema/vector-query.ts';
import {
  LADDER_QUERY,
  createSearchFixture,
  seedDistanceLadder,
  seedEdge,
  seedEdgeType,
  seedEntity,
  seedFact,
  seedPage,
  type SearchFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const PERSONAL = ['personal:mail', 'personal:files'];
const WORK = ['work:mail', 'work:files'];

/**
 * What the plan says when no relational cue fired and the question is not a bare
 * entity lookup — the graph arm's two ranking inputs at their least opinionated.
 *
 * Spelled out at every call site rather than defaulted inside `graphArm`,
 * because a default is exactly how these two inputs came to exist in the eval
 * adapter and nowhere else: the arm ranked one way for the fleet and another way
 * for the blocking tier, and no type error said so.
 */
const NO_RELATION_PLAN = { relations: [] as readonly string[], seedFirst: false };

/** 120 rows, so a 100-candidate pool is a real subset and 10 is a small one. */
const LADDER_SIZE = 120;
/** 1-based rank of the row the guard looks for: inside a 100 pool, outside a 10. */
const SOUGHT_RANK = 90;

let fixture: SearchFixture;
let sql: SQL;
let ladderIds: string[];
let ftsLanguage: string;

beforeAll(async () => {
  fixture = await createSearchFixture('u5arms');
  sql = fixture.sql;
  // Session-level, so it is still in force inside `withVectorScan`'s
  // transaction. Test-side only: forcing the plan is what lets a fixture-scale
  // corpus exercise the production-scale path, and the control arm below is the
  // licence for doing so.
  await sql.unsafe('SET enable_seqscan = off');
  ladderIds = await seedDistanceLadder(sql, { count: LADDER_SIZE, origin: 'personal:files' });
  ftsLanguage = await readFtsLanguage(sql);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await fixture?.close();
}, { timeout: SETUP_TIMEOUT_MS });

describe('the vector arm asks for a pool, not for a page of results (H1)', () => {
  test('the fixture is large enough for the truncation to be observable', async () => {
    const rows = (await sql`SELECT count(*)::int AS n FROM chunk WHERE embedding IS NOT NULL`) as Array<{
      n: number;
    }>;
    expect(rows[0]?.n).toBe(LADDER_SIZE);
    // Asserted rather than assumed: the whole guard rests on the sought row
    // being outside a limit-sized pool and inside a properly-sized one.
    expect(candidatePoolFor({ limit: 10 })).toBeGreaterThan(SOUGHT_RANK);
    expect(SOUGHT_RANK).toBeGreaterThan(10);
  });

  test(
    'a limit of 10 still recalls the 90th-nearest row',
    async () => {
      const sought = ladderIds[SOUGHT_RANK - 1];
      expect(sought).toBeDefined();

      const armed = await vectorArm(sql, {
        queryVector: LADDER_QUERY,
        grant: PERSONAL,
        limit: 10,
      });

      expect(armed.ranked).toContain(sought!);
      expect(armed.ranked.length).toBe(candidatePoolFor({ limit: 10 }));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the control: the same SQL with the pool set to the limit does not',
    async () => {
      // This is the mutation, run deliberately. If it passed, the assertion
      // above would be measuring nothing — either because the corpus is too
      // small, or because the planner is doing an exact sequential scan.
      const sought = ladderIds[SOUGHT_RANK - 1];
      const truncated = await runVectorScan(
        sql,
        { queryVector: LADDER_QUERY, grant: PERSONAL, limit: 10 },
        10,
      );

      expect(truncated.ranked.length).toBeLessThanOrEqual(10);
      expect(truncated.ranked).not.toContain(sought!);
    },
    TEST_TIMEOUT_MS,
  );

  test('the pool grows with the offset, so page 5 is not page 1 re-ranked', () => {
    expect(candidatePoolFor({ limit: 10, offset: 40 })).toBe(140);
  });
});

describe('the fence is in the statement, not applied afterwards', () => {
  test(
    'the vector arm returns nothing outside the grant',
    async () => {
      const armed = await vectorArm(sql, {
        queryVector: LADDER_QUERY,
        grant: WORK,
        limit: 10,
      });
      expect(armed.ranked).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test('an empty grant reads nothing rather than everything', async () => {
    const armed = await vectorArm(sql, { queryVector: LADDER_QUERY, grant: [], limit: 10 });
    expect(armed.ranked).toEqual([]);
    expect(await hydrate(sql, ladderIds.slice(0, 3), [])).toEqual(new Map());
  });

  test('hydration drops ids outside the grant instead of returning them unfenced', async () => {
    const hydrated = await hydrate(sql, ladderIds.slice(0, 3), WORK);
    expect(hydrated.size).toBe(0);
    const allowed = await hydrate(sql, ladderIds.slice(0, 3), PERSONAL);
    expect(allowed.size).toBe(3);
  });
});

describe('soft-deleted and quarantined rows never surface', () => {
  test(
    'neither arm returns a tombstoned or quarantined page',
    async () => {
      await seedPage(sql, {
        id: 'p-dead',
        title: 'Tombstoned advisory',
        sourceType: 'email',
        origin: 'personal:mail',
        createdAt: '2026-06-01',
        paragraphs: ['tombstoned advisory about widget calibration'],
        deleted: true,
        ladder: [0.0001],
      });
      await seedPage(sql, {
        id: 'p-junk',
        title: 'Quarantined advisory',
        sourceType: 'email',
        origin: 'personal:mail',
        createdAt: '2026-06-01',
        paragraphs: ['quarantined advisory about widget calibration'],
        quarantined: true,
        ladder: [0.0002],
      });
      await sql.unsafe('ANALYZE chunk');

      const grant = [...PERSONAL];
      const vector = await vectorArm(sql, { queryVector: LADDER_QUERY, grant, limit: 10 });
      const fts = await ftsArm(sql, {
        query: 'widget calibration advisory',
        grant,
        limit: 10,
        ftsLanguage,
      });

      for (const result of [...vector.ranked, ...fts.ranked]) {
        const row = (await sql`
          SELECT content FROM chunk WHERE chunk_id = ${result}::bigint
        `) as Array<{ content: string }>;
        expect(row[0]?.content).not.toContain('tombstoned');
        expect(row[0]?.content).not.toContain('quarantined');
      }
      // And the fixture really did put them at the front of the distance order.
      expect(vector.ranked.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the full-text arm', () => {
  test(
    'recalls a page whose title carries the phrase and whose body does not',
    async () => {
      const [chunkId] = await seedPage(sql, {
        id: 'p-titled',
        title: 'Saltmarsh launch retro',
        sourceType: 'document',
        origin: 'personal:files',
        createdAt: '2026-04-14',
        paragraphs: ['The outcome was two days later than the plan of record said.'],
      });

      const fts = await ftsArm(sql, {
        query: 'Saltmarsh launch retro',
        grant: PERSONAL,
        limit: 10,
        ftsLanguage,
      });
      // A boost cannot promote a row no arm returned — that is why the title is
      // admitted to recall even though ranking on it belongs to stage 6.
      expect(fts.ranked).toContain(chunkId!);
    },
    TEST_TIMEOUT_MS,
  );

  test('takes punctuation without raising', async () => {
    const fts = await ftsArm(sql, {
      query: 'what "is" this? & that!',
      grant: PERSONAL,
      limit: 10,
      ftsLanguage,
    });
    expect(Array.isArray(fts.ranked)).toBe(true);
  });

  test('reads the tenant language rather than assuming English (KTD9)', async () => {
    expect(ftsLanguage).toBe('simple');
  });
});

describe('the graph arm', () => {
  test(
    'walks an edge to the chunk that evidences it, and fences on the union',
    async () => {
      const [investorChunk] = await seedPage(sql, {
        id: 'p-memo',
        title: 'Series A memo',
        sourceType: 'document',
        origin: 'personal:files',
        createdAt: '2026-01-22',
        paragraphs: ['Tessellate Capital led the round in Verdant Loom at a 4.2 million euro valuation.'],
      });

      const tessellate = await seedEntity(sql, {
        slug: 'tessellate-capital',
        name: 'Tessellate Capital',
        type: 'organization',
        origins: ['personal:files'],
      });
      const verdant = await seedEntity(sql, {
        slug: 'verdant-loom',
        name: 'Verdant Loom',
        type: 'organization',
        origins: ['personal:files'],
      });
      await seedEdgeType(sql, 'invested_in', 'has_investor');
      await seedEdge(sql, {
        subject: tessellate,
        type: 'invested_in',
        object: verdant,
        origins: ['personal:files'],
      });
      await seedFact(sql, {
        statement: 'Tessellate Capital invested in Verdant Loom.',
        origins: ['personal:files'],
        chunkIds: [investorChunk!],
        createdAt: '2026-01-22',
      });

      const walked = await graphArm(sql, {
        entityIds: [verdant],
        grant: PERSONAL,
        limit: 10,
        ...NO_RELATION_PLAN,
      });
      expect(walked.ranked).toContain(investorChunk!);

      // The same walk under a grant that does not hold the fact's origin.
      const fenced = await graphArm(sql, {
        entityIds: [verdant],
        grant: WORK,
        limit: 10,
        ...NO_RELATION_PLAN,
      });
      expect(fenced.ranked).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test('no seed entities means no fan-out query at all', async () => {
    const walked = await graphArm(sql, {
      entityIds: [],
      grant: PERSONAL,
      limit: 10,
      ...NO_RELATION_PLAN,
    });
    expect(walked.ranked).toEqual([]);
  });
});

describe('attestation classification (R12a input)', () => {
  test('the channel table splits on who can write, not on quality', () => {
    expect(CHANNEL_BY_SOURCE_TYPE.email).toBe('external');
    expect(CHANNEL_BY_SOURCE_TYPE.calendar).toBe('external');
    expect(CHANNEL_BY_SOURCE_TYPE.chat).toBe('external');
    expect(CHANNEL_BY_SOURCE_TYPE.note).toBe('user_curated');
    expect(CHANNEL_BY_SOURCE_TYPE.document).toBe('user_curated');
    // Neither class corroborates. A source type must never be a way to promote
    // a claim into the compiled-truth boost.
    expect(Object.values(CHANNEL_BY_SOURCE_TYPE)).not.toContain('user_out_of_band');
    expect(Object.values(CHANNEL_BY_SOURCE_TYPE)).not.toContain('internal');
  });

  test('a sender recorded by a connector is the collapse key; the fallback is the origin', () => {
    expect(senderKeyFor({ externalRef: 'gmail:123?sender=Acme@Example.com', origin: 'personal:mail' })).toBe(
      'sender:acme@example.com',
    );
    // Fail-closed: with no sender recorded, every external row under one
    // credential collapses to one attestation. It can under-count independent
    // origins; it can never manufacture one.
    expect(senderKeyFor({ externalRef: null, origin: 'personal:mail' })).toBe('origin:personal:mail');
  });

  test(
    'a hydrated candidate carries its channel and its page facts',
    async () => {
      const [chunkId] = await seedPage(sql, {
        id: 'p-attest',
        title: 'Invoice 2026-114',
        sourceType: 'email',
        origin: 'personal:mail',
        createdAt: '2026-05-02',
        externalRef: 'gmail:abc?sender=billing@widget.example',
        paragraphs: ['Invoice 2026-114 is attached.'],
      });
      const hydrated = await hydrate(sql, [chunkId!], PERSONAL);
      const candidate = hydrated.get(chunkId!);
      expect(candidate?.sourceType).toBe('email');
      expect(candidate?.title).toBe('Invoice 2026-114');
      expect(candidate?.attestations[0]?.channel).toBe('external');
      expect(candidate?.attestations[0]?.senderKey).toBe('sender:billing@widget.example');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Guards a mutation run showed were missing.
// ---------------------------------------------------------------------------

describe('the graph arm asks for a pool too, and walks two hops', () => {
  test(
    'a fan-out returns more than the requested limit — it is a pool, not a page',
    async () => {
      // The mutation this kills: `candidatePoolFor({...})` -> `request.limit` in
      // `graphArm`. The vector arm's identical mistake is guarded above; the
      // graph arm's was not, and it had additionally been written out by hand as
      // `max(limit * 5, 100)` — which silently dropped the offset, so page five
      // of a fan-out was page one re-ranked. Every hazard guard stayed green.
      const hub = await seedEntity(sql, {
        slug: 'pool-hub',
        name: 'Poolhub Industries',
        type: 'organization',
        origins: ['personal:files'],
      });

      const chunkIds: string[] = [];
      for (let index = 0; index < 24; index += 1) {
        const [chunkId] = await seedPage(sql, {
          id: `p-pool-${index}`,
          title: `Poolhub note ${index}`,
          sourceType: 'note',
          origin: 'personal:files',
          createdAt: '2026-04-01',
          paragraphs: [`Poolhub Industries note number ${index}.`],
        });
        chunkIds.push(chunkId!);
        await seedFact(sql, {
          statement: `Poolhub Industries recorded item ${index}.`,
          origins: ['personal:files'],
          chunkIds: [chunkId!],
          createdAt: '2026-04-01',
        });
      }

      const walked = await graphArm(sql, {
        entityIds: [hub],
        grant: PERSONAL,
        limit: 4,
        ...NO_RELATION_PLAN,
      });
      // With the pool arithmetic the arm asks for 100 and finds all 24; with a
      // bare limit it asks for 4 and RRF fuses a truncated universe.
      expect(walked.ranked.length).toBe(chunkIds.length);
      expect(candidatePoolFor({ limit: 4 })).toBeGreaterThan(chunkIds.length);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a neighbour’s own fact is reachable, and still ranks below the seed’s',
    async () => {
      // Two properties in one walk, because they fail in opposite directions.
      // Without the second hop the neighbour's chunk is unreachable — "Marc's
      // shop location" is answered by a statement about the shop that never says
      // his name. Without the seed-first ordering the newest thing the
      // neighbourhood ever asserted outranks the seed's own statement, which is
      // how a fan-out answers a question about a person with a stranger's job.
      const founder = await seedEntity(sql, {
        slug: 'hop-founder',
        name: 'Hopfield Marchetti',
        type: 'person',
        origins: ['personal:files'],
      });
      const shop = await seedEntity(sql, {
        slug: 'hop-shop',
        name: 'Hopfield Provisions',
        type: 'organization',
        origins: ['personal:files'],
      });
      // A self-inverse type, because `edge_type_inverse_is_declared` is a
      // foreign key onto the same table and a forward/inverse pair cannot be
      // inserted without one of them dangling. Nothing in this walk depends on
      // which type the edge carries — only that an edge exists.
      await seedEdgeType(sql, 'affiliated_with', 'affiliated_with');
      await seedEdge(sql, {
        subject: founder,
        type: 'affiliated_with',
        object: shop,
        origins: ['personal:files'],
      });

      const [seedChunk] = await seedPage(sql, {
        id: 'p-hop-seed',
        title: 'Hopfield Marchetti',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2024-02-01',
        paragraphs: ['Hopfield Marchetti keeps the ledgers himself.'],
      });
      const [neighbourChunk] = await seedPage(sql, {
        id: 'p-hop-neighbour',
        title: 'Relocation note',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2026-05-19',
        paragraphs: ['Hopfield Provisions is based in Bristol.'],
      });

      // The seed's own statement is the OLDER one, deliberately: with the
      // seed-first key removed the ordering falls through to recency and the
      // neighbour wins, which is exactly the mutation to catch.
      await seedFact(sql, {
        statement: 'Hopfield Marchetti keeps the ledgers.',
        origins: ['personal:files'],
        chunkIds: [seedChunk!],
        createdAt: '2024-02-01',
      });
      await seedFact(sql, {
        statement: 'Hopfield Provisions is based in Bristol.',
        origins: ['personal:files'],
        chunkIds: [neighbourChunk!],
        createdAt: '2026-05-19',
      });

      const walked = await graphArm(sql, {
        entityIds: [founder],
        grant: PERSONAL,
        limit: 10,
        ...NO_RELATION_PLAN,
      });
      // Reachable at all — this is the second hop.
      expect(walked.ranked).toContain(neighbourChunk!);
      // And ordered behind the seed's own statement despite being newer.
      expect(walked.ranked.indexOf(seedChunk!)).toBeLessThan(
        walked.ranked.indexOf(neighbourChunk!),
      );
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The two ranking inputs the eval adapter implemented and the fleet did not.
// ---------------------------------------------------------------------------

/**
 * **The blocking tier was grading a graph arm the fleet does not run.**
 *
 * `intent.ts` argues at length that `plan.relations` is load-bearing — "without
 * this the graph arm ranks the neighbourhood by recency, and the most recently
 * recorded relation wins whatever the question was" — and the same paragraph is
 * true of the seed-first inversion an entity lookup wants. Both were implemented
 * in `test/core/search/corpus-ranker.ts`, and neither reached `GraphArmRequest`,
 * this SQL, or `read.ts`. That is the "stages exist twice" failure the module
 * header of `arms.ts` claims the arms/post-retrieval split prevents, and every
 * floor U7 published was measured against the version that only the eval ran.
 *
 * The two tests below are the arm's own guard for each term. Each one is a
 * *comparison* rather than an assertion about the SQL text: the same walk is run
 * twice, once with the term's input supplied and once without, and what is
 * asserted is that the two orderings differ in the direction the term claims.
 * Delete either `ORDER BY` term and the paired call collapses onto its control.
 *
 * **The relation term is keyed on the edge's endpoints, not on a fact→edge
 * link.** The tenant schema has no such link — `entity_edge` carries no
 * `fact_ids` column and there is no join table — so the eval adapter's original
 * derivation (`edge.factIds`, a fixture-only field) had no SQL counterpart and
 * could never have had one. What both substrates key on now is the property the
 * database can actually answer: a fact that names *both* endpoints of an edge
 * whose type the question asked about is evidence for that relation.
 */
describe('the graph arm ranks on the relation the question asked about', () => {
  test(
    'a fact evidencing the asked-for edge type outranks a newer fact about another edge',
    async () => {
      const person = await seedEntity(sql, {
        slug: 'rel-analyst',
        name: 'Ottoline Fairweather',
        type: 'person',
        origins: ['personal:files'],
      });
      const employer = await seedEntity(sql, {
        slug: 'rel-employer',
        name: 'Cobalt Meridian',
        type: 'organization',
        origins: ['personal:files'],
      });
      const investee = await seedEntity(sql, {
        slug: 'rel-investee',
        name: 'Pennyroyal Works',
        type: 'organization',
        origins: ['personal:files'],
      });
      await seedEdge(sql, {
        subject: person,
        type: 'works_at',
        object: employer,
        origins: ['personal:files'],
      });
      await seedEdge(sql, {
        subject: person,
        type: 'invested_in',
        object: investee,
        origins: ['personal:files'],
      });

      const [employmentChunk] = await seedPage(sql, {
        id: 'p-rel-employment',
        title: 'Team roster',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2024-03-02',
        paragraphs: ['Ottoline Fairweather works at Cobalt Meridian.'],
      });
      const [investmentChunk] = await seedPage(sql, {
        id: 'p-rel-investment',
        title: 'Cap table note',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2026-07-30',
        paragraphs: ['Ottoline Fairweather invested in Pennyroyal Works.'],
      });
      // The employment statement is the OLDER of the two, deliberately: with no
      // relation term the ordering falls through to recency and the investment
      // wins whatever was asked.
      await seedFact(sql, {
        statement: 'Ottoline Fairweather works at Cobalt Meridian.',
        origins: ['personal:files'],
        chunkIds: [employmentChunk!],
        createdAt: '2024-03-02',
      });
      await seedFact(sql, {
        statement: 'Ottoline Fairweather invested in Pennyroyal Works.',
        origins: ['personal:files'],
        chunkIds: [investmentChunk!],
        createdAt: '2026-07-30',
      });

      // The control: no cue named a relation, so recency decides and the newest
      // thing the neighbourhood asserted comes first.
      const unasked = await graphArm(sql, {
        entityIds: [person],
        grant: PERSONAL,
        limit: 10,
        ...NO_RELATION_PLAN,
      });
      expect(unasked.ranked.indexOf(investmentChunk!)).toBeLessThan(
        unasked.ranked.indexOf(employmentChunk!),
      );

      // "where does Ottoline work" — the cue table names `works_at`/`employs`,
      // and the older statement that spans that edge is now the answer.
      const asked = await graphArm(sql, {
        entityIds: [person],
        grant: PERSONAL,
        limit: 10,
        relations: ['works_at', 'employs'],
        seedFirst: false,
      });
      expect(asked.ranked.indexOf(employmentChunk!)).toBeLessThan(
        asked.ranked.indexOf(investmentChunk!),
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'seedFirst inverts the multi-entity ordering an entity lookup does not want',
    async () => {
      // "who is X" wants X's own statements; "who does X work with" wants the
      // statement that spans the edge. Same fan-out, opposite priority — which is
      // the intent plan doing work, and which the fleet could not express.
      const subject = await seedEntity(sql, {
        slug: 'sf-subject',
        name: 'Perpetua Lindqvist',
        type: 'person',
        origins: ['personal:files'],
      });
      const other = await seedEntity(sql, {
        slug: 'sf-other',
        name: 'Halberd Foundry',
        type: 'organization',
        origins: ['personal:files'],
      });
      await seedEdge(sql, {
        subject: subject,
        type: 'works_at',
        object: other,
        origins: ['personal:files'],
      });

      const [aloneChunk] = await seedPage(sql, {
        id: 'p-sf-alone',
        title: 'Profile',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2024-01-04',
        paragraphs: ['Perpetua Lindqvist keeps bees on the roof.'],
      });
      const [spanChunk] = await seedPage(sql, {
        id: 'p-sf-span',
        title: 'Org note',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2026-07-29',
        paragraphs: ['Perpetua Lindqvist works at Halberd Foundry.'],
      });
      // The seed-only statement is the older one, so seed-first has to beat both
      // the multi-entity key and recency for the assertion to mean anything.
      await seedFact(sql, {
        statement: 'Perpetua Lindqvist keeps bees on the roof.',
        origins: ['personal:files'],
        chunkIds: [aloneChunk!],
        createdAt: '2024-01-04',
      });
      await seedFact(sql, {
        statement: 'Perpetua Lindqvist works at Halberd Foundry.',
        origins: ['personal:files'],
        chunkIds: [spanChunk!],
        createdAt: '2026-07-29',
      });

      const relational = await graphArm(sql, {
        entityIds: [subject],
        grant: PERSONAL,
        limit: 10,
        ...NO_RELATION_PLAN,
      });
      expect(relational.ranked.indexOf(spanChunk!)).toBeLessThan(
        relational.ranked.indexOf(aloneChunk!),
      );

      const lookup = await graphArm(sql, {
        entityIds: [subject],
        grant: PERSONAL,
        limit: 10,
        relations: [],
        seedFirst: true,
      });
      expect(lookup.ranked.indexOf(aloneChunk!)).toBeLessThan(
        lookup.ranked.indexOf(spanChunk!),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
