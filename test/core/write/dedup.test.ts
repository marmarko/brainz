/**
 * Write-time near-duplicate detection on `remember` — U4 approach step 4, and
 * the frozen contract's `inserted | duplicate | superseded`.
 *
 * The ledger row (`imp.write-time-dedup`) states the cost of deferring this:
 * async dedup means `recall` can return two contradictory versions of one claim,
 * budget-packed, in the window before a consolidation cycle. So the decision is
 * made before the row is written, not after.
 *
 * **Both signals, and each catches what the other misses.** Normalized text
 * equality catches the re-send that differs only in punctuation or spacing, and
 * costs nothing. Embedding similarity bounds the candidate set for the harder
 * question — is this the *same claim* stated differently? — which is then
 * decided structurally, on the frozen contract's own rule: same entity, same
 * kind, different text supersedes. `fact` carries neither an entity column nor a
 * kind column, so both halves of that key are recovered by re-running the
 * deterministic extractor over the stored statement.
 *
 * `id` on a `duplicate` is the **existing** fact's id. That is the contract's
 * wording and it is the whole value of the status: the caller learns what the
 * brain already knows rather than being told its write succeeded.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { DUPLICATE_SIMILARITY } from '../../../src/core/write/dedup.ts';
import { remember } from '../../../src/core/write/write-path.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createGateway,
  createTenantFixture,
  lexicalVector,
  uncappedBudget,
  type TenantFixture,
} from './fixture.ts';

/** Both fixture vectors are unit length, so the dot product is the cosine. */
function cosine(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

let tenant: TenantFixture;

beforeAll(async () => {
  tenant = await createTenantFixture('writededup');
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  if (tenant !== undefined) await tenant.close();
}, { timeout: SETUP_TIMEOUT_MS });

function context(harness = createGateway()) {
  return {
    context: {
      sql: tenant.sql,
      gateway: harness.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    },
    harness,
  };
}

async function reset(): Promise<void> {
  await tenant.sql.unsafe(`
    DELETE FROM entity_edge;
    DELETE FROM contradiction_report;
    DELETE FROM fact_source;
    DELETE FROM fact;
    DELETE FROM entity_alias;
    DELETE FROM entity_slug;
    DELETE FROM entity;
    DELETE FROM chunk;
    DELETE FROM page;
  `);
}

async function say(statement: string, origin = 'personal') {
  const { context: ctx } = context();
  return remember(ctx, { originContext: origin, statement });
}

describe('the three statuses of the frozen contract', () => {
  test('a first statement is inserted', async () => {
    await reset();
    const result = await say('Samantha Okonkwo is the head of platform at Verdant Systems.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('inserted');
    expect(result.id).toMatch(/^\d+$/);
    expect(await countRows(tenant.sql, 'fact')).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('the same statement again is a duplicate carrying the EXISTING id', async () => {
    const first = (await tenant.sql`SELECT fact_id::text AS id FROM fact`) as Array<{ id: string }>;
    const result = await say('Samantha Okonkwo is the head of platform at Verdant Systems.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('duplicate');
    expect(result.id).toBe(first[0]?.id ?? '');
    expect(await countRows(tenant.sql, 'fact')).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('a duplicate writes no page and no chunk either', async () => {
    // Otherwise a client that re-sends on retry fills retrieval with copies of
    // one claim that the token budget then packs against each other.
    expect(await countRows(tenant.sql, 'page')).toBe(1);
    expect(await countRows(tenant.sql, 'chunk')).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('a re-spelling with different punctuation is still a duplicate', async () => {
    const first = (await tenant.sql`SELECT fact_id::text AS id FROM fact`) as Array<{ id: string }>;
    const result = await say('Samantha  Okonkwo is the head of platform at Verdant Systems.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('duplicate');
    expect(result.id).toBe(first[0]?.id ?? '');
  }, TEST_TIMEOUT_MS);

  test('the same claim with a different value supersedes', async () => {
    const before = (await tenant.sql`SELECT fact_id::text AS id FROM fact`) as Array<{ id: string }>;
    const result = await say('Samantha Okonkwo is the head of platform at Northwind Labs.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('superseded');
    // The id is the NEW fact's: the caller wrote something, and it stuck.
    expect(result.id).not.toBe(before[0]?.id ?? '');

    const rows = (await tenant.sql`
      SELECT fact_id::text AS id, superseded_by::text AS superseded_by FROM fact ORDER BY fact_id
    `) as Array<{ id: string; superseded_by: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.superseded_by).toBe(result.id);
    expect(rows[1]?.superseded_by).toBeNull();
  }, TEST_TIMEOUT_MS);

  test('the superseded fact drops out of the live set but is still there', async () => {
    const live = (await tenant.sql`
      SELECT count(*)::int AS n FROM fact
       WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
    `) as Array<{ n: number }>;
    expect(live[0]?.n).toBe(1);
    expect(await countRows(tenant.sql, 'fact')).toBe(2);
  }, TEST_TIMEOUT_MS);

  test('an unrelated claim is inserted, not superseded onto the nearest neighbour', async () => {
    const result = await say('Kettle Works is based in Lisbon.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('inserted');
    expect(await countRows(tenant.sql, 'fact')).toBe(3);
  }, TEST_TIMEOUT_MS);

  test('a different subject with the same shape does not supersede', async () => {
    // Same topic, same predicate, different entity. Superseding here would
    // overwrite one person's job with another's.
    const result = await say('Dana Whitlock is the head of platform at Verdant Systems.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('inserted');
  }, TEST_TIMEOUT_MS);
});

describe('remember stores what it was told, whether or not a rule understands it', () => {
  test('a statement no rule matches is still stored as a fact', async () => {
    await reset();
    const result = await say('The spare key is in the blue tin on the top shelf.');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('inserted');

    const rows = (await tenant.sql`SELECT statement FROM fact`) as Array<{ statement: string }>;
    // Verbatim: the user's own words, not a normalized key.
    expect(rows[0]?.statement).toBe('The spare key is in the blue tin on the top shelf.');
  }, TEST_TIMEOUT_MS);

  test('an unstructured statement can still be recognised as a duplicate', async () => {
    const result = await say('The spare key is in the blue tin on the top shelf.');
    expect(result.ok).toBe(true);
    expect(result.ok === true ? result.status : '').toBe('duplicate');
  }, TEST_TIMEOUT_MS);

  test('it is searchable immediately by full text, before any chunk is embedded', async () => {
    // The half of the sync/async split a user actually notices: the FTS arm
    // works on the generated column the moment the row commits.
    const rows = (await tenant.sql`
      SELECT count(*)::int AS n FROM chunk
       WHERE content_tsv @@ plainto_tsquery('simple', 'spare key blue tin')
    `) as Array<{ n: number }>;
    expect(rows[0]?.n).toBeGreaterThan(0);

    const unembedded = (await tenant.sql`
      SELECT count(*)::int AS n FROM chunk WHERE embedding IS NULL
    `) as Array<{ n: number }>;
    expect(unembedded[0]?.n).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);
});

describe('dedup rides the embedding, so a failed embedding writes nothing', () => {
  test('a provider failure is typed and leaves the brain untouched', async () => {
    await reset();
    const harness = createGateway({ failFromCall: 1 });
    const { context: ctx } = context(harness);
    const result = await remember(ctx, {
      originContext: 'personal',
      statement: 'Marcus Fell founded Kettle Works.',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : '').toBe('embed_failed');
    expect(await countRows(tenant.sql, 'fact')).toBe(0);
    expect(await countRows(tenant.sql, 'page')).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('an empty statement is refused before any provider call', async () => {
    const harness = createGateway();
    const { context: ctx } = context(harness);
    const result = await remember(ctx, { originContext: 'personal', statement: '   ' });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : '').toBe('empty_document');
    expect(harness.transport.calls).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

describe('the same claim from two credentials is two attestations', () => {
  test('a second origin inserts rather than collapsing into the first', async () => {
    await reset();
    const first = await say('Marcus Fell founded Kettle Works.', 'personal');
    const second = await say('Marcus Fell founded Kettle Works.', 'work');

    expect(first.ok === true ? first.status : '').toBe('inserted');
    // Collapsing here would be unrecoverable: R15 makes origin immutable, so
    // the existing row cannot absorb the second credential's attestation, and
    // R12a's corroboration boost is defined on there being two of them.
    expect(second.ok === true ? second.status : '').toBe('inserted');

    const rows = (await tenant.sql`
      SELECT origin_contexts AS origins FROM fact ORDER BY fact_id
    `) as Array<{ origins: string[] }>;
    expect(rows.map((row) => row.origins)).toEqual([['personal'], ['work']]);
  }, TEST_TIMEOUT_MS);

  test('and a third write under the first origin is still a duplicate of it', async () => {
    const again = await say('Marcus Fell founded Kettle Works.', 'personal');
    expect(again.ok === true ? again.status : '').toBe('duplicate');
    expect(await countRows(tenant.sql, 'fact')).toBe(2);
  }, TEST_TIMEOUT_MS);
});

describe('the two signals are not one signal', () => {
  test('the text signal decides on its own when the embedding cannot', async () => {
    // The header claims two signals, each covering what the other cannot. Every
    // duplicate above is one both would catch — extra spaces leave the token
    // set identical, so the vectors agree too, and the normalized-text
    // comparison could be deleted with nothing going red.
    //
    // This is the case only text can decide: a zero-width space pasted into the
    // middle of a word. It is invisible in every diff and every test report, it
    // splits one token into two so the vectors genuinely disagree, and it
    // vanishes under the normalizer. Assert the embedding's helplessness first,
    // so the test cannot quietly become a similarity test again.
    await reset();
    const plain = 'The spare key is in the blue tin on the third shelf.';
    const pasted = 'The spare key is in the bl​ue tin on the third shelf.';
    expect(pasted).not.toBe(plain);
    expect(cosine(lexicalVector(plain), lexicalVector(pasted))).toBeLessThan(
      DUPLICATE_SIMILARITY,
    );

    const first = await say(plain);
    expect(first.ok && first.status).toBe('inserted');
    const second = await say(pasted);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe('duplicate');
    expect(second.id).toBe(first.ok ? first.id : '');
    expect(await countRows(tenant.sql, 'fact')).toBe(1);
  }, TEST_TIMEOUT_MS);
});
