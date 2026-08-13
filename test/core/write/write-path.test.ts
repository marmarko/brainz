/**
 * The write path end to end — and the unit's spine: **what must be true before
 * the call returns, versus what may complete later.**
 *
 * The reason the split gets its own assertions rather than a paragraph is that
 * "it will be indexed shortly" is how a brain silently loses writes. A deferred
 * step is only safe if the work it deferred is *discoverable* afterwards by
 * something other than the process that deferred it. So the tests below check
 * both halves of that sentence:
 *
 *  - after `ingestDocument` returns, the page, its chunks, its facts and its
 *    edges are committed, every fact carries a vector, and the transport has
 *    been called exactly once — for the facts;
 *  - the chunks it did **not** embed are in a backlog that is a query over the
 *    rows themselves (`embedding IS NULL`), so a process that dies here resumes
 *    rather than forgets;
 *  - and the phase recorder refuses a run that did async work synchronously or
 *    skipped a synchronous phase, so moving a step across the line fails a test
 *    rather than changing a latency graph.
 *
 * Two more properties are checked here because nowhere else can see them:
 * **KTD8's width is refused end-to-end** (a provider answering 3072-wide leaves
 * no rows behind at all, rather than a corpus of subtly wrong vectors), and
 * **KTD9's provision-time decisions are read rather than assumed** — a tenant on
 * taxonomy version 3 gets 3 stamped on its rows, not the column default.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
} from '../../../src/ai/gateway.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../../src/ai/keys.ts';
import { HOSTED_PROFILE, type NamedProfile } from '../../../src/ai/routing.ts';

import { CHUNKER_VERSION } from '../../../src/core/write/chunker.ts';
import {
  backlogSize,
  embeddingModelFor,
  pendingChunkEmbeddings,
  runChunkEmbedBacklog,
} from '../../../src/core/write/embed.ts';
import { NORMALIZER_VERSION } from '../../../src/core/write/normalize.ts';
import { ASYNC_PHASES, SYNC_PHASES } from '../../../src/core/write/phases.ts';
import { ingestDocument } from '../../../src/core/write/write-path.ts';
import {
  CALLER,
  CANARY,
  TENANT,
  countRows,
  createEmbeddingTransport,
  createGateway,
  createTenantFixture,
  setTaxonomyVersion,
  uncappedBudget,
  type TenantFixture,
} from './fixture.ts';

/**
 * A servable profile whose embedding row has no canonical price: a self-host
 * endpoint, which `routing.ts` accepts precisely because price is a property of
 * who serves the weights. Built here rather than imported, because the shipped
 * profiles are all fully priced — which is the point of them.
 */
function unpricedEmbeddingProfile(): NamedProfile {
  return {
    name: 'self-host',
    routes: {
      ...HOSTED_PROFILE.routes,
      salience: {
        op: 'salience',
        alias: 'self-host/nemotron',
        id: 'self-host/nemotron',
        provider: 'self-host',
        pinnedOn: '2026-08-12',
        maxOutputTokens: 1_024,
      },
      embedding: {
        op: 'embedding',
        alias: 'self-host/embed-1',
        id: 'self-host/embed-1',
        provider: 'self-host',
        pinnedOn: '2026-08-12',
        maxOutputTokens: 0,
      },
    },
  };
}

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

let tenant: TenantFixture;

beforeAll(async () => {
  tenant = await createTenantFixture('writepath');
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  if (tenant !== undefined) await tenant.close();
}, { timeout: SETUP_TIMEOUT_MS });

const DOCUMENT = [
  '# Verdant Systems — platform review',
  '',
  'Samantha Okonkwo is the head of platform at Verdant Systems.',
  'Tessellate Capital invested in Verdant Systems.',
  '',
  '## Notes',
  '',
  `Nothing else of consequence. ${CANARY}`,
].join('\n');

function contextFor(harness: ReturnType<typeof createGateway>) {
  return {
    sql: tenant.sql,
    gateway: harness.gateway,
    tenantId: TENANT,
    caller: CALLER,
    budget: uncappedBudget(),
  };
}

async function reset(): Promise<void> {
  // Order matters: derivation edges first, then the rows they point at.
  await tenant.sql.unsafe(`
    DELETE FROM entity_edge;
    DELETE FROM contradiction_report;
    DELETE FROM fact_source;
    DELETE FROM fact;
    DELETE FROM entity_alias;
    DELETE FROM entity_slug;
    DELETE FROM entity;
    DELETE FROM chunk;
    DELETE FROM attachment;
    DELETE FROM page;
    DELETE FROM ingest_log;
    UPDATE tenant_setting SET taxonomy_version = 1;
  `);
}

describe('the synchronous half is durable before the call returns', () => {
  test('page, chunks, facts and edges are all committed', async () => {
    await reset();
    const harness = createGateway();
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'Verdant Systems — platform review',
      body: DOCUMENT,
    });

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.status).toBe('written');
    expect(await countRows(tenant.sql, 'page')).toBe(1);
    expect(await countRows(tenant.sql, 'chunk')).toBe(receipt.chunkCount);
    expect(receipt.facts.length).toBeGreaterThan(0);

    const embedded = (await tenant.sql`
      SELECT count(*)::int AS n FROM fact WHERE embedding IS NOT NULL
    `) as Array<{ n: number }>;
    expect(embedded[0]?.n).toBe(receipt.facts.length);

    // Link extraction is synchronous per U4 approach step 1: "who did I just
    // say Alice works with" must answer right after being told.
    expect(await countRows(tenant.sql, 'entity_edge')).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  test('exactly one provider call was made, and it was for the facts', async () => {
    await reset();
    const harness = createGateway();
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'Verdant Systems — platform review',
      body: DOCUMENT,
    });

    expect(receipt.ok).toBe(true);
    // The mutation this kills: embedding chunks on the synchronous path. It
    // would look like a latency regression and nothing else.
    expect(harness.transport.calls).toHaveLength(1);
    const texts = harness.transport.texts;
    expect(texts.length).toBe(receipt.ok ? receipt.facts.length : 0);
    for (const text of texts) expect(text).not.toContain('# Verdant Systems');
  }, TEST_TIMEOUT_MS);

  test('chunks are NOT embedded yet, and the backlog says exactly which', async () => {
    const pending = await pendingChunkEmbeddings(tenant.sql, 100);
    const chunks = await countRows(tenant.sql, 'chunk');
    expect(pending).toHaveLength(chunks);
    expect(await backlogSize(tenant.sql)).toBe(chunks);
  }, TEST_TIMEOUT_MS);

  test('the receipt names the split rather than implying it', async () => {
    await reset();
    const harness = createGateway();
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'T',
      body: DOCUMENT,
    });

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.phases).toEqual([...SYNC_PHASES]);
    expect(receipt.deferred.chunkEmbeddings).toBe(receipt.chunkCount);
    // Declared disjoint, so "which side is this on" has one answer.
    for (const phase of ASYNC_PHASES) {
      expect((SYNC_PHASES as readonly string[]).includes(phase)).toBe(false);
    }
  }, TEST_TIMEOUT_MS);
});

describe('the asynchronous half is resumable, not promised', () => {
  test('a backfill drains the backlog and every vector is the pinned width', async () => {
    const harness = createGateway();
    const before = await backlogSize(tenant.sql);
    expect(before).toBeGreaterThan(0);

    const result = await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: harness.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });

    expect(result.embedded).toBe(before);
    expect(result.remaining).toBe(0);

    const widths = (await tenant.sql`
      SELECT DISTINCT vector_dims(embedding) AS dims FROM chunk WHERE embedding IS NOT NULL
    `) as Array<{ dims: number }>;
    expect(widths.map((row) => row.dims)).toEqual([1536]);
  }, TEST_TIMEOUT_MS);

  test('the backfill applies the title wrap to what it encodes', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'A distinctive page title',
      body: 'A paragraph with no extractable structure in it whatsoever.',
    });

    const backfill = createGateway();
    await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: backfill.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });

    expect(backfill.transport.texts.some((text) => text.includes('A distinctive page title'))).toBe(
      true,
    );
    // ...and the stored chunk is still the user's own words.
    const stored = (await tenant.sql`SELECT content FROM chunk`) as Array<{ content: string }>;
    for (const row of stored) expect(row.content).not.toContain('A distinctive page title');
  }, TEST_TIMEOUT_MS);

  test('a failed backfill leaves the work in the backlog', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'note',
      title: null,
      body: 'A paragraph with no extractable structure in it whatsoever.',
    });

    const failing = createGateway({ failFromCall: 1 });
    const result = await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: failing.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });

    expect(result.embedded).toBe(0);
    expect(result.failure).toBe('transport_failed');
    expect(await backlogSize(tenant.sql)).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  test('a quarantined chunk never reaches the provider (R16 junk gate seam)', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'external',
      sourceType: 'email',
      title: 'Newsletter',
      body: 'Unsubscribe. Manage preferences. View in browser.',
      quarantine: 'junk',
    });

    expect(await backlogSize(tenant.sql)).toBe(0);

    const backfill = createGateway();
    const result = await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: backfill.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });

    expect(result.embedded).toBe(0);
    // Junk is embedded, paid for, ranked and consolidated over — unless it is
    // gated before the provider call, which is the structural half U4 owns.
    expect(backfill.transport.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  test('a page quarantined after it was written takes its chunks with it', async () => {
    // The test above quarantines at ingestion, when this module stamps the page
    // **and** every chunk in one transaction — so it passes whether the backlog
    // predicate reads the page or only the chunk. The gate that matters is the
    // other one: U9's classifier runs *after* the write, and R12's `forget` leg
    // soft-deletes pages. Either marks the page row. A backlog that keys on the
    // chunk column alone then hands the provider exactly the content the seam
    // promises it never sees — and being wrong here costs money and leaves junk
    // vectors ranking, with nothing to point at.
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'external',
      sourceType: 'email',
      title: 'Newsletter',
      body: 'A paragraph with no extractable structure in it whatsoever.',
    });
    expect(await backlogSize(tenant.sql)).toBeGreaterThan(0);

    await tenant.sql`UPDATE page SET quarantined_at = now()`;
    expect(await backlogSize(tenant.sql)).toBe(0);
    expect(await pendingChunkEmbeddings(tenant.sql, 100)).toHaveLength(0);

    const backfill = createGateway();
    const result = await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: backfill.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });
    expect(result.embedded).toBe(0);
    expect(backfill.transport.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  test('a page soft-deleted after it was written takes its chunks with it', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'note',
      title: null,
      body: 'A paragraph with no extractable structure in it whatsoever.',
    });
    expect(await backlogSize(tenant.sql)).toBeGreaterThan(0);

    await tenant.sql`UPDATE page SET deleted_at = now()`;
    expect(await backlogSize(tenant.sql)).toBe(0);

    const backfill = createGateway();
    const result = await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: backfill.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });
    expect(result.embedded).toBe(0);
    expect(backfill.transport.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

describe('KTD8 end to end: a wrong-width provider writes nothing', () => {
  test('the write fails typed and leaves no page, chunk or fact behind', async () => {
    await reset();
    const harness = createGateway({ width: 3072 });
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'Verdant Systems',
      body: DOCUMENT,
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false ? receipt.reason : '').toBe('embed_failed');
    expect(await countRows(tenant.sql, 'page')).toBe(0);
    expect(await countRows(tenant.sql, 'chunk')).toBe(0);
    expect(await countRows(tenant.sql, 'fact')).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe('R14: an unpriced model under a live cap stops the write', () => {
  test('the write fails typed rather than embedding at an uncomputable cost', async () => {
    // U4's named scenario. The gateway owns the rule — a model absent from the
    // pricing table hard-fails when a cap is active — and what is checked here
    // is that the write path *surfaces* it instead of continuing without the
    // vectors. An unmetered path does not surface as an error, it surfaces as
    // a bill, and a write that shrugged this off would be one.
    await reset();
    const transport = createEmbeddingTransport();
    const gateway = createModelGateway({
      profile: unpricedEmbeddingProfile(),
      transport,
      meter: createInMemorySpendMeter(),
      keys: {
        store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
        hosted: createHostedKeyPool({
          openai: 'k',
          google: 'k',
          cloudflare: 'k',
          'self-host': 'k',
        }),
      },
    });

    const receipt = await ingestDocument(
      {
        sql: tenant.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: createBudget({ label: 'capped', capMicroUsd: 5_000 }),
      },
      {
        originContext: 'personal',
        sourceType: 'document',
        title: 'Verdant Systems',
        body: DOCUMENT,
      },
    );

    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false ? receipt.reason : '').toBe('embed_failed');
    expect(receipt.ok === false ? receipt.detail : '').toBe('model_not_priced');
    expect(transport.calls).toHaveLength(0);
    expect(await countRows(tenant.sql, 'page')).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe('KTD9: provision-time decisions are read, not assumed', () => {
  test('a tenant on taxonomy version 3 stamps 3 on every row it writes', async () => {
    await reset();
    await setTaxonomyVersion(tenant.sql, 3);
    const harness = createGateway();
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'Verdant Systems',
      body: DOCUMENT,
    });
    expect(receipt.ok).toBe(true);

    for (const table of ['page', 'fact', 'entity']) {
      const rows = (await tenant.sql.unsafe(
        `SELECT DISTINCT taxonomy_version AS v FROM ${table}`,
      )) as Array<{ v: number }>;
      expect(rows.map((row) => row.v)).toEqual([3]);
    }
    await setTaxonomyVersion(tenant.sql, 1);
  }, TEST_TIMEOUT_MS);
});

describe('the provenance signature records what actually encoded the page', () => {
  test('model, dimensions, chunker and normalizer versions are all on the page', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'Verdant Systems',
      body: DOCUMENT,
    });

    const rows = (await tenant.sql`
      SELECT embedding_model, embedding_dimensions, chunker_version, normalizer_version,
             content_sha256, provenance_signature
        FROM page
    `) as Array<{
      embedding_model: string;
      embedding_dimensions: number;
      chunker_version: number;
      normalizer_version: number;
      content_sha256: string;
      provenance_signature: string;
    }>;

    const page = rows[0];
    expect(page).toBeDefined();
    expect(page?.embedding_model).toBe(embeddingModelFor(harness.gateway.profileName));
    expect(page?.embedding_dimensions).toBe(1536);
    expect(page?.chunker_version).toBe(CHUNKER_VERSION);
    expect(page?.normalizer_version).toBe(NORMALIZER_VERSION);
    expect(page?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(page?.provenance_signature).toContain(page?.embedding_model ?? '');
  }, TEST_TIMEOUT_MS);

  test('the model the backfill actually used matches the model the page declares', async () => {
    // KTD8's no-go branch is a fleet re-embed keyed on exactly this signature.
    // A page that declares one model and was encoded by another makes that
    // selection silently wrong, and nothing else would ever notice.
    const harness = createGateway();
    await runChunkEmbedBacklog({
      sql: tenant.sql,
      gateway: harness.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget('backfill'),
    });

    const declared = (await tenant.sql`SELECT DISTINCT embedding_model FROM page`) as Array<{
      embedding_model: string;
    }>;
    const used = new Set(harness.meter.records().map((record) => record.modelId));
    expect([...used]).toEqual([declared[0]?.embedding_model ?? '']);
  }, TEST_TIMEOUT_MS);

  test('the page names the model that produced the vector, not the one a name lookup predicts', async () => {
    // Both assertions above hold trivially under a shipped profile, where the
    // gateway's own route and a lookup by profile *name* agree by construction.
    // The gateway takes a `NamedProfile`, not a name — an operator serving
    // embeddings from their own endpoint hands one in, and the two answers part
    // company. The stamp is what KTD8's re-embed job selects on, so a stamp
    // recovered by re-deriving from a name is a signature that identifies a
    // model that never ran. The gateway already returns the one that did.
    await reset();
    const transport = createEmbeddingTransport();
    const meter = createInMemorySpendMeter();
    const gateway = createModelGateway({
      profile: unpricedEmbeddingProfile(),
      transport,
      meter,
      keys: {
        store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
        hosted: createHostedKeyPool({
          openai: 'k',
          google: 'k',
          cloudflare: 'k',
          'self-host': 'k',
        }),
      },
    });

    const receipt = await ingestDocument(
      {
        sql: tenant.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget('operator'),
      },
      {
        originContext: 'personal',
        sourceType: 'document',
        title: 'Verdant Systems',
        body: DOCUMENT,
      },
    );
    expect(receipt.ok).toBe(true);

    const used = new Set(meter.records().map((record) => record.modelId));
    expect([...used]).toEqual(['self-host/embed-1']);

    const rows = (await tenant.sql`SELECT embedding_model FROM page`) as Array<{
      embedding_model: string;
    }>;
    expect(rows[0]?.embedding_model).toBe('self-host/embed-1');
  }, TEST_TIMEOUT_MS);

  test("an operator's own profile name does not take the write down after the provider was paid", async () => {
    // The same re-derivation, in its louder form. `embeddingModelFor` throws on
    // a name outside the two shipped profiles — and it is called *after* the
    // embedding call has been made and metered, so the write dies with an
    // untyped throw, having already spent the money, and the caller gets an
    // exception where every other failure on this path is a typed result.
    await reset();
    const transport = createEmbeddingTransport();
    const meter = createInMemorySpendMeter();
    const gateway = createModelGateway({
      profile: { ...unpricedEmbeddingProfile(), name: 'operator-a' },
      transport,
      meter,
      keys: {
        store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
        hosted: createHostedKeyPool({
          openai: 'k',
          google: 'k',
          cloudflare: 'k',
          'self-host': 'k',
        }),
      },
    });

    const receipt = await ingestDocument(
      {
        sql: tenant.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget('operator'),
      },
      {
        originContext: 'personal',
        sourceType: 'document',
        title: 'Verdant Systems',
        body: DOCUMENT,
      },
    );

    // The provider ran and was metered before the throw — the money is gone
    // either way, so the only question is whether the write survives it.
    expect(meter.records()).toHaveLength(1);
    expect(receipt.ok).toBe(true);
    expect(await countRows(tenant.sql, 'page')).toBe(1);

    const rows = (await tenant.sql`SELECT embedding_model FROM page`) as Array<{
      embedding_model: string;
    }>;
    expect(rows[0]?.embedding_model).toBe('self-host/embed-1');
  }, TEST_TIMEOUT_MS);

  test('a document that encoded nothing under an unknown profile refuses, typed', async () => {
    // The one case with no record to fall back on: no fact was extracted, so no
    // embedding call was made, so nothing in this process knows what will
    // encode the chunks. Guessing would put a page in the wrong bucket of
    // KTD8's re-embed selection, permanently and invisibly. So it refuses — as
    // a typed result, like every other refusal on this path, not as a throw.
    await reset();
    const gateway = createModelGateway({
      profile: { ...unpricedEmbeddingProfile(), name: 'operator-a' },
      transport: createEmbeddingTransport(),
      meter: createInMemorySpendMeter(),
      keys: {
        store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
        hosted: createHostedKeyPool({
          openai: 'k',
          google: 'k',
          cloudflare: 'k',
          'self-host': 'k',
        }),
      },
    });

    const receipt = await ingestDocument(
      {
        sql: tenant.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget('operator'),
      },
      {
        originContext: 'personal',
        sourceType: 'note',
        title: null,
        body: 'A paragraph with no extractable structure in it whatsoever.',
      },
    );

    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false && receipt.reason).toBe('embedding_model_unknown');
    expect(await countRows(tenant.sql, 'page')).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe('R16: ingestion is idempotent, and an edit reconciles rather than accumulates', () => {
  test('re-ingesting identical content is a no-op with zero provider calls', async () => {
    await reset();
    const first = createGateway();
    const input = {
      originContext: 'external' as const,
      sourceType: 'email' as const,
      title: 'Thread',
      body: 'Marcus Fell founded Kettle Works.',
      externalRef: 'gmail:thread-1',
    };
    const one = await ingestDocument(contextFor(first), input);
    expect(one.ok).toBe(true);

    const second = createGateway();
    const two = await ingestDocument(contextFor(second), input);

    expect(two.ok).toBe(true);
    expect(two.ok === true ? two.status : '').toBe('unchanged');
    expect(second.transport.calls).toHaveLength(0);
    expect(await countRows(tenant.sql, 'page')).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('the same external ref with changed content replaces rather than duplicates', async () => {
    const third = createGateway();
    const changed = await ingestDocument(contextFor(third), {
      originContext: 'external',
      sourceType: 'email',
      title: 'Thread',
      body: 'Marcus Fell founded Kettle Works. Kettle Works is based in Lisbon.',
      externalRef: 'gmail:thread-1',
    });

    expect(changed.ok).toBe(true);
    expect(changed.ok === true ? changed.status : '').toBe('replaced');

    // The superseded page drops out of retrieval: "skip what I have seen"
    // leaves superseded chunks ranking alongside their replacements.
    const live = (await tenant.sql`
      SELECT count(*)::int AS n FROM page WHERE deleted_at IS NULL
    `) as Array<{ n: number }>;
    expect(live[0]?.n).toBe(1);

    const liveChunks = (await tenant.sql`
      SELECT count(*)::int AS n FROM chunk WHERE deleted_at IS NULL
    `) as Array<{ n: number }>;
    const staleChunks = (await tenant.sql`
      SELECT count(*)::int AS n FROM chunk WHERE deleted_at IS NOT NULL
    `) as Array<{ n: number }>;
    expect(liveChunks[0]?.n).toBeGreaterThan(0);
    expect(staleChunks[0]?.n).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  test('an ingest run records what it wrote', async () => {
    await reset();
    const harness = createGateway();
    const rows = (await tenant.sql`
      INSERT INTO ingest_log (origin_context, source_type, external_ref)
      VALUES ('external', 'email', 'run-1')
      RETURNING ingest_id::text AS ingest_id
    `) as Array<{ ingest_id: string }>;
    const ingestId = rows[0]?.ingest_id ?? '';

    await ingestDocument(contextFor(harness), {
      originContext: 'external',
      sourceType: 'email',
      title: 'Thread',
      body: 'Marcus Fell founded Kettle Works.',
      externalRef: 'gmail:thread-2',
      ingestId,
    });

    const linked = (await tenant.sql`
      SELECT count(*)::int AS n FROM page WHERE ingest_id = ${ingestId}::bigint
    `) as Array<{ n: number }>;
    expect(linked[0]?.n).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('an item a poller re-read and did not change is still an item seen', async () => {
    // `items_seen` is the denominator an operator reads a connector's health
    // out of, and the idempotent re-read is a poller's *most common* outcome by
    // a wide margin — every cadence, every unchanged item. A counter that only
    // advances when something was written says a run saw nothing on the day it
    // worked perfectly, and makes "seen" and "written" the same number forever.
    await reset();
    const harness = createGateway();
    const rows = (await tenant.sql`
      INSERT INTO ingest_log (origin_context, source_type, external_ref)
      VALUES ('external', 'email', 'run-2')
      RETURNING ingest_id::text AS ingest_id
    `) as Array<{ ingest_id: string }>;
    const ingestId = rows[0]?.ingest_id ?? '';

    const input = {
      originContext: 'external' as const,
      sourceType: 'email' as const,
      title: 'Thread',
      body: 'Marcus Fell founded Kettle Works.',
      externalRef: 'gmail:thread-3',
      ingestId,
    };
    const first = await ingestDocument(contextFor(harness), input);
    expect(first.ok).toBe(true);
    const second = await ingestDocument(contextFor(harness), input);
    expect(second.ok && second.status).toBe('unchanged');

    const counts = (await tenant.sql`
      SELECT items_seen, items_written, items_quarantined
        FROM ingest_log WHERE ingest_id = ${ingestId}::bigint
    `) as Array<{ items_seen: number; items_written: number; items_quarantined: number }>;
    expect(counts[0]).toEqual({ items_seen: 2, items_written: 1, items_quarantined: 0 });
  }, TEST_TIMEOUT_MS);
});

describe('R15: a derived row is never narrower than what it came from', () => {
  test('a fact carries the origin of the page it was extracted from', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'work',
      sourceType: 'document',
      title: 'Work doc',
      body: 'Marcus Fell founded Kettle Works.',
    });

    const rows = (await tenant.sql`
      SELECT f.origin_contexts AS origins, p.origin_context AS page_origin
        FROM fact f JOIN page p ON p.page_id = f.page_id
    `) as Array<{ origins: string[]; page_origin: string }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.origins).toContain(row.page_origin);
  }, TEST_TIMEOUT_MS);

  test('an edge carries the union of both endpoints origins', async () => {
    const rows = (await tenant.sql`
      SELECT e.origin_contexts AS edge_origins,
             s.origin_contexts AS subject_origins,
             o.origin_contexts AS object_origins
        FROM entity_edge e
        JOIN entity s ON s.entity_id = e.subject_entity_id
        JOIN entity o ON o.entity_id = e.object_entity_id
       WHERE e.deleted_at IS NULL
    `) as Array<{ edge_origins: string[]; subject_origins: string[]; object_origins: string[] }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const origin of [...row.subject_origins, ...row.object_origins]) {
        expect(row.edge_origins).toContain(origin);
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe('the write path holds the user words and the metering record does not', () => {
  test('no chunk text appears in any metering record', async () => {
    await reset();
    const harness = createGateway();
    await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'document',
      title: 'Verdant Systems',
      body: DOCUMENT,
    });

    const serialized = JSON.stringify(harness.meter.records());
    expect(serialized).not.toContain(CANARY);
  }, TEST_TIMEOUT_MS);
});

describe('refusals that cost nothing', () => {
  test('a document with no content is refused before any provider call', async () => {
    await reset();
    const harness = createGateway();
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      sourceType: 'note',
      title: null,
      body: '   \n\n  ',
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false ? receipt.reason : '').toBe('empty_document');
    expect(harness.transport.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  test('a source type the schema does not know is refused before any write', async () => {
    const harness = createGateway();
    const receipt = await ingestDocument(contextFor(harness), {
      originContext: 'personal',
      // Deliberately outside `page_source_type_is_known`.
      sourceType: 'telepathy' as never,
      title: null,
      body: 'Marcus Fell founded Kettle Works.',
    });

    expect(receipt.ok).toBe(false);
    expect(receipt.ok === false ? receipt.reason : '').toBe('unknown_source_type');
    expect(harness.transport.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});
