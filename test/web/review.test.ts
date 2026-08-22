/**
 * The first surface in the product that closes a decision, and the first that
 * writes `user_out_of_band`.
 *
 * ============================================================================
 * WHY EVERY ONE OF THESE IS AGAINST A REAL SCHEMA
 * ============================================================================
 *
 * Almost nothing here is arithmetic a fake could stand in for. The properties
 * under test are properties of CONSTRAINTS — a partial unique index that admits
 * one live card per entity, a CHECK that names who may close a row, a deferred
 * trigger that re-evaluates an origin union at COMMIT, a `BEFORE UPDATE OF`
 * trigger that fires only when a column is named in a SET list. A fake would
 * assert the shape of the code that talks to them and nothing about whether the
 * database agrees.
 *
 * Two of these tests fail against a plausible, readable, wrong implementation:
 *
 *   * **Undo clears `deleted_at` before deleting the new card.** The live-card
 *     uniqueness index is a plain partial UNIQUE — not deferrable, checked per
 *     statement — so the obvious order puts two live cards on one entity
 *     mid-transaction and aborts. The order is the design, and only a real index
 *     can hold it.
 *   * **Apply overwrites instead of retiring.** `ON CONFLICT … DO UPDATE SET
 *     summary` is what the consolidate path does and it destroys the prior text
 *     in place. Nothing but reading the retired row back proves it survived.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { textArrayLiteral } from '../../src/core/write/pg-values.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import {
  REVIEWABLE_CHARACTERS,
  decideConflict,
  decideProposal,
  readReview,
  refusalFor,
  undoProposal,
} from '../../src/web/review.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

const WORK = 'work:mail';
const NOW = new Date('2026-08-21T02:00:00.000Z');
const VECTOR = `[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(',')}]`;

let sql: SQL;
let schema: SchemaFixture;

beforeAll(async () => {
  schema = await provisionFixture('reviewroute');
  sql = connectTenant(schema);
}, 180_000);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

afterEach(async () => {
  await sql.unsafe(`
    DELETE FROM contradiction_report;
    DELETE FROM review_queue;
    DELETE FROM entity_card;
    DELETE FROM entity;
    UPDATE fact SET superseded_by = NULL;
    DELETE FROM fact;
    DELETE FROM severance;
    DELETE FROM consolidation_run;
  `);
});

async function insertEntity(name = 'Priya Raman'): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
     VALUES ($1, 'person', $2::text[]) RETURNING entity_id::text AS id`,
    [name, textArrayLiteral([WORK])],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertCard(entityId: string, summary: string, trust = 'model_inferred'): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence, origin_contexts)
     VALUES ($1::bigint, $2, $3, 'model_derived', 0.9, $4::text[])
     RETURNING card_id::text AS id`,
    [entityId, summary, trust, textArrayLiteral([WORK])],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function enqueue(options: {
  readonly kind?: string;
  readonly targetRef?: string;
  readonly proposal?: string;
  readonly origins?: string[];
  readonly createdAt?: string;
} = {}): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts, created_at)
     VALUES ($1, $2, $3, 0.65, $4::text[], $5::timestamptz)
     RETURNING review_id::text AS id`,
    [
      options.kind ?? 'entity_card',
      options.targetRef ?? 'entity:1',
      options.proposal ?? 'Priya leads the renewal desk.',
      textArrayLiteral(options.origins ?? [WORK]),
      options.createdAt ?? NOW.toISOString(),
    ],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertFact(statement: string): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO fact (statement, ${ACTIVE_EMBEDDING_SEAT.column}, origin_contexts)
     VALUES ($1, $2::vector, $3::text[]) RETURNING fact_id::text AS id`,
    [statement, VECTOR, textArrayLiteral([WORK])],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertConflict(left: string, right: string): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
     VALUES ($1::bigint, $2::bigint, 'value_conflict', $3::text[])
     RETURNING report_id::text AS id`,
    [left, right, textArrayLiteral([WORK])],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------
// The refusal ladder, which the query cannot express.
// ---------------------------------------------------------------------------

describe('a proposal is refused for the first reason that applies', () => {
  test('a severed origin outranks everything, including the kind', () => {
    expect(
      refusalFor({ severed: true, kind: 'fact', truncated: true, targetLive: false }),
    ).toBe('origin_severed');
  });

  test('the kind outranks the target, because a fact carries a chunk target', () => {
    // Without this order production's single `fact` row draws "the person or
    // company this was about is no longer in your brain" — nonsense about a chunk.
    expect(
      refusalFor({ severed: false, kind: 'fact', truncated: false, targetLive: false }),
    ).toBe('needs_an_embedding');
    expect(
      refusalFor({ severed: false, kind: 'commitment', truncated: false, targetLive: false }),
    ).toBe('needs_corroboration');
    // `entity_merge` is NOT in that group, and the difference is the point: a
    // fact and a commitment carry `chunk:` refs, so `targetLive` is meaningless
    // for them and the kind has to answer first. A merge carries a parseable
    // entity ref, so a dead target is a real and specific thing to say.
    expect(
      refusalFor({ severed: false, kind: 'entity_merge', truncated: false, targetLive: false }),
    ).toBe('target_gone');
    // The kinds nothing writes keep the old sentence.
    expect(
      refusalFor({ severed: false, kind: 'contradiction', truncated: false, targetLive: true }),
    ).toBe('no_apply_path');
  });

  test('a live, readable merge is offered — the button that used to be a sentence', () => {
    expect(
      refusalFor({ severed: false, kind: 'entity_merge', truncated: false, targetLive: true }),
    ).toBeNull();
    // And severance still outranks it: the two names live inside prose the
    // listing withholds for a severed row.
    expect(
      refusalFor({ severed: true, kind: 'entity_merge', truncated: false, targetLive: true }),
    ).toBe('origin_severed');
  });

  test('an entity_card with a live target and readable text is offered', () => {
    expect(
      refusalFor({ severed: false, kind: 'entity_card', truncated: false, targetLive: true }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The listing.
// ---------------------------------------------------------------------------

describe('the listing renders only what is undecided, and withholds what it must', () => {
  test('a decided proposal is never rendered again', async () => {
    const entity = await insertEntity();
    const open = await enqueue({ targetRef: `entity:${entity}` });
    await enqueue({ targetRef: `entity:${entity}` });
    await sql.unsafe(
      `UPDATE review_queue SET state = 'dismissed', closed_by = 'user_out_of_band',
              closed_at = $1::timestamptz WHERE review_id <> $2::bigint`,
      [NOW.toISOString(), open],
    );
    const view = await readReview(sql);
    expect(view.proposals.length).toBe(1);
    expect(view.proposals[0]?.reviewId).toBe(open);
  });

  test('prose from a severed account is withheld, and the row still renders', async () => {
    const entity = await insertEntity();
    const id = await enqueue({ targetRef: `entity:${entity}` });
    await sql.unsafe(
      `INSERT INTO severance (origin_context, severed_at, removed, recomputed, surviving_origins)
       VALUES ($1, $2::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::text[])`,
      [WORK, new Date(NOW.getTime() + 1000).toISOString()],
    );
    const view = await readReview(sql);
    const row = view.proposals[0];
    expect(row?.reviewId).toBe(id);
    // Rendered, so it can be dismissed — but its text is gone.
    expect(row?.proposal).toBeNull();
    expect(row?.refusal).toBe('origin_severed');
  });

  test('a severance BEFORE the proposal does not withhold it', async () => {
    // `severance` is append-only history: a proposal enqueued after a reconnect
    // quotes live content, and membership alone would hide it forever.
    const entity = await insertEntity();
    await sql.unsafe(
      `INSERT INTO severance (origin_context, severed_at, removed, recomputed, surviving_origins)
       VALUES ($1, $2::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::text[])`,
      [WORK, new Date(NOW.getTime() - 60_000).toISOString()],
    );
    await enqueue({ targetRef: `entity:${entity}` });
    const view = await readReview(sql);
    expect(view.proposals[0]?.proposal).not.toBeNull();
    expect(view.proposals[0]?.refusal).toBeNull();
  });

  test('an over-long proposal keeps its excerpt and loses its Apply', async () => {
    const entity = await insertEntity();
    await enqueue({ targetRef: `entity:${entity}`, proposal: 'x'.repeat(REVIEWABLE_CHARACTERS + 10) });
    const view = await readReview(sql);
    expect(view.proposals[0]?.truncated).toBe(true);
    expect(view.proposals[0]?.proposal?.length).toBe(REVIEWABLE_CHARACTERS);
    expect(view.proposals[0]?.refusal).toBe('too_long_to_read');
  });

  test('a soft-deleted entity reads as target_gone rather than succeeding silently', async () => {
    const entity = await insertEntity();
    await enqueue({ targetRef: `entity:${entity}` });
    await sql.unsafe(`UPDATE entity SET deleted_at = $1::timestamptz`, [NOW.toISOString()]);
    const view = await readReview(sql);
    expect(view.proposals[0]?.refusal).toBe('target_gone');
    expect(view.proposals[0]?.subjectName).toBeNull();
  });

  test('an erased statement is withheld from a contradiction, and the row is not adjudicable', async () => {
    const left = await insertFact('Priya joined in March.');
    const right = await insertFact('Priya joined in April.');
    await insertConflict(left, right);
    await sql.unsafe(`UPDATE fact SET deleted_at = $1::timestamptz WHERE fact_id = $2::bigint`, [
      NOW.toISOString(),
      right,
    ]);
    const view = await readReview(sql);
    const conflict = view.contradictions[0];
    expect(conflict?.left.statement).toBe('Priya joined in March.');
    expect(conflict?.right.statement).toBeNull();
    expect(conflict?.right.state).toBe('withdrawn');
    expect(conflict?.adjudicable).toBe(false);
  });

  test('a superseded statement is shown and marked — retired, not removed', async () => {
    const left = await insertFact('Priya joined in March.');
    const right = await insertFact('Priya joined in April.');
    await insertConflict(left, right);
    await sql.unsafe(`UPDATE fact SET superseded_by = $1::bigint WHERE fact_id = $2::bigint`, [
      left,
      right,
    ]);
    const conflict = (await readReview(sql)).contradictions[0];
    expect(conflict?.right.statement).toBe('Priya joined in April.');
    expect(conflict?.right.state).toBe('superseded');
    expect(conflict?.adjudicable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Apply, and the retirement that makes undo possible.
// ---------------------------------------------------------------------------

describe('applying a proposal writes the owner’s verdict without destroying the old card', () => {
  test('it retires the prior card, writes user_stated, and closes as user_out_of_band', async () => {
    const entity = await insertEntity();
    const prior = await insertCard(entity, 'The old summary.');
    const id = await enqueue({ targetRef: `entity:${entity}`, proposal: 'The new summary.' });

    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: prior,
      seenPair: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true, action: 'applied', hadPrior: true });

    const cards = (await sql.unsafe(
      `SELECT summary, trust_level::text AS trust, deleted_at FROM entity_card ORDER BY card_id`,
    )) as Array<{ summary: string; trust: string; deleted_at: Date | null }>;
    expect(cards.length).toBe(2);
    // The prior card's BYTES survive. `ON CONFLICT DO UPDATE SET summary` would
    // have destroyed them in place, and nothing anywhere keeps a version.
    expect(cards[0]?.summary).toBe('The old summary.');
    expect(cards[0]?.deleted_at).not.toBeNull();
    expect(cards[1]?.summary).toBe('The new summary.');
    expect(cards[1]?.trust).toBe('user_stated');
    expect(cards[1]?.deleted_at).toBeNull();

    const closed = (await sql.unsafe(
      `SELECT state, closed_by, closed_at FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string; closed_by: string; closed_at: Date }>;
    expect(closed[0]?.state).toBe('applied');
    // The value this whole screen exists to produce, and the first write of it
    // anywhere in the product.
    expect(closed[0]?.closed_by).toBe('user_out_of_band');
  });

  test('an entity with no card applies cleanly and reports no prior', async () => {
    const entity = await insertEntity();
    const id = await enqueue({ targetRef: `entity:${entity}` });
    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true, action: 'applied', hadPrior: false });
  });

  test('a card that changed since the page was drawn refuses, and writes nothing', async () => {
    const entity = await insertEntity();
    await insertCard(entity, 'The card that is actually live.');
    const id = await enqueue({ targetRef: `entity:${entity}` });

    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: '999999',
      seenPair: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'card_changed' });

    const cards = (await sql.unsafe(`SELECT count(*)::int AS n FROM entity_card`)) as Array<{ n: number }>;
    expect(cards[0]?.n).toBe(1);
    const state = (await sql.unsafe(
      `SELECT state FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string }>;
    expect(state[0]?.state).toBe('open');
  });

  test('a second press finds the row closed rather than applying twice', async () => {
    const entity = await insertEntity();
    const id = await enqueue({ targetRef: `entity:${entity}` });
    await decideProposal(sql, { reviewId: id, intent: 'apply', seenCardId: null,
      seenPair: null, now: NOW });
    const again = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(again).toEqual({ ok: false, reason: 'already_closed' });
  });

  test('a vanished target closes the row as internal, never as the owner’s judgement', async () => {
    const entity = await insertEntity();
    const id = await enqueue({ targetRef: `entity:${entity}` });
    await sql.unsafe(`UPDATE entity SET deleted_at = $1::timestamptz`, [NOW.toISOString()]);

    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'target_gone' });

    const closed = (await sql.unsafe(
      `SELECT state, closed_by FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string; closed_by: string }>;
    // Closed, because nothing else in src/ ever closes a superseded proposal —
    // but `internal`, because nobody judged the sentence and `user_out_of_band`
    // has to keep meaning that a person did.
    expect(closed[0]?.state).toBe('dismissed');
    expect(closed[0]?.closed_by).toBe('internal');
  });

  test('a kind with no apply path is refused and left open', async () => {
    const id = await enqueue({ kind: 'fact', targetRef: 'chunk:12' });
    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: false, reason: 'needs_an_embedding' });
    const state = (await sql.unsafe(
      `SELECT state FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string }>;
    expect(state[0]?.state).toBe('open');
  });

  test('dismiss closes any kind and writes no card', async () => {
    const id = await enqueue({ kind: 'entity_merge', targetRef: 'entity:404' });
    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'dismiss',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true, action: 'dismissed', hadPrior: false });
    const cards = (await sql.unsafe(`SELECT count(*)::int AS n FROM entity_card`)) as Array<{ n: number }>;
    expect(cards[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Undo. The order of the two card statements is the design.
// ---------------------------------------------------------------------------

describe('applying a merge through the queue', () => {
  const pairProposal = (left: string, right: string): string =>
    `These look like the same thing under two names: ${left} \u2194 ${right}. Merging them is not something your brain will do on its own.`;

  test('it makes the two into one, and closes as the owner', async () => {
    const keeper = await insertEntity('Google Inc');
    const loser = await insertEntity('Google LLC');
    const id = await enqueue({
      kind: 'entity_merge',
      targetRef: `entity:${keeper}`,
      proposal: pairProposal('Google Inc', 'Google LLC'),
    });

    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: [keeper, loser].join(','),
      now: NOW,
    });
    expect(outcome).toEqual({ ok: true, action: 'applied', hadPrior: false });

    const live = (await sql.unsafe(
      `SELECT canonical_name FROM entity WHERE deleted_at IS NULL ORDER BY canonical_name`,
    )) as Array<{ canonical_name: string }>;
    expect(live.map((row) => row.canonical_name)).toEqual(['Google Inc']);

    const closed = (await sql.unsafe(
      `SELECT state, closed_by FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string; closed_by: string }>;
    // R12a: a person judged this, out of band. That attestation is the product.
    expect(closed[0]).toEqual({ state: 'applied', closed_by: 'user_out_of_band' });
  });

  test('a pair that moved since the listing refuses rather than merging strangers', async () => {
    const keeper = await insertEntity('Google Inc');
    const loser = await insertEntity('Google LLC');
    const id = await enqueue({
      kind: 'entity_merge',
      targetRef: `entity:${keeper}`,
      proposal: pairProposal('Google Inc', 'Google LLC'),
    });

    // The merge's `card_changed`: between the listing and the press, a widen
    // minted a new id for one of the rows.
    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: [keeper, '999999'].join(','),
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('pair_changed');

    // Nothing merged, and the row is still OPEN — the answer may differ next
    // time the owner looks.
    const live = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM entity WHERE deleted_at IS NULL`,
    )) as Array<{ n: number }>;
    expect(live[0]?.n).toBe(2);
    const state = (await sql.unsafe(
      `SELECT state FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string }>;
    expect(state[0]?.state).toBe('open');
    void loser;
  });

  test('two approved summaries refuse, and say which refusal it was', async () => {
    const keeper = await insertEntity('Google Inc');
    const loser = await insertEntity('Google LLC');
    for (const entity of [keeper, loser]) {
      await sql.unsafe(
        `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence,
                                  origin_contexts)
         VALUES ($1::bigint, 'The owner approved this.', 'user_stated', 'model_derived', 1, $2::text[])`,
        [entity, textArrayLiteral([WORK])],
      );
    }
    const id = await enqueue({
      kind: 'entity_merge',
      targetRef: `entity:${keeper}`,
      proposal: pairProposal('Google Inc', 'Google LLC'),
    });

    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: [keeper, loser].join(','),
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('two_of_yours');
    // Open, because this one the owner CAN act on: retire one summary first.
    const state = (await sql.unsafe(
      `SELECT state FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string }>;
    expect(state[0]?.state).toBe('open');
  });

  test('a pair that no longer resolves closes the row rather than asking forever', async () => {
    const keeper = await insertEntity('Google Inc');
    const id = await enqueue({
      kind: 'entity_merge',
      targetRef: `entity:${keeper}`,
      proposal: pairProposal('Google Inc', 'Nothing Here'),
    });

    const outcome = await decideProposal(sql, {
      reviewId: id,
      intent: 'apply',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('target_gone');
    // Closed as `internal`: the owner pressed Apply, so it must not stay open —
    // but nothing about the SENTENCE was judged, and `user_out_of_band` has to
    // keep meaning that a person judged it.
    const state = (await sql.unsafe(
      `SELECT state, closed_by FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string; closed_by: string }>;
    expect(state[0]).toEqual({ state: 'dismissed', closed_by: 'internal' });
  });
});

describe('the refusals the server derives rather than trusts', () => {
  test('a severed proposal cannot be applied, even though the listing withheld its prose', async () => {
    // `decideProposal` hardcoded `severed: false`, so the one row whose text the
    // listing deliberately does not print was the one row an apply would act on
    // sight-unseen.
    const entity = await insertEntity('Verdant Systems');
    const reviewId = await enqueue({
      kind: 'entity_card',
      targetRef: `entity:${entity}`,
      proposal: 'A summary the owner was never shown.',
    });
    await sql.unsafe(
      `INSERT INTO severance (origin_context, severed_at, removed, recomputed, surviving_origins)
       VALUES ($1, now(), '{}'::jsonb, '{}'::jsonb, ARRAY[]::text[])`,
      [WORK],
    );

    const outcome = await decideProposal(sql, {
      reviewId,
      intent: 'apply',
      seenCardId: null,
      seenPair: null,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('origin_severed');
    // And nothing was written.
    const cards = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM entity_card WHERE entity_id = $1::bigint`,
      [entity],
    )) as Array<{ n: number }>;
    expect(cards[0]?.n).toBe(0);
  });

  test('undo refuses a kind it does not know how to reverse', async () => {
    // The claim query had no `kind` predicate, and every appliable kind closes
    // into the same `applied` / `user_out_of_band` state it matches on. This
    // function knows exactly one reversal.
    const entity = await insertEntity('Google Inc');
    const reviewId = await enqueue({
      kind: 'entity_merge',
      targetRef: `entity:${entity}`,
      proposal: 'These look like the same thing under two names: A <-> B.',
    });
    await sql.unsafe(
      `UPDATE review_queue SET state = 'applied', closed_by = 'user_out_of_band', closed_at = now()
        WHERE review_id = $1::bigint`,
      [reviewId],
    );

    const outcome = await undoProposal(sql, { reviewId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('nothing_to_undo');
  });
});

describe('undo puts the card back and reopens the decision', () => {
  test('it deletes the approved card, restores the retired one, and reopens the row', async () => {
    const entity = await insertEntity();
    const prior = await insertCard(entity, 'The old summary.');
    const id = await enqueue({ targetRef: `entity:${entity}`, proposal: 'The new summary.' });
    await decideProposal(sql, { reviewId: id, intent: 'apply', seenCardId: prior,
      seenPair: null, now: NOW });

    const outcome = await undoProposal(sql, { reviewId: id });
    expect(outcome).toEqual({ ok: true, restored: true });

    const live = (await sql.unsafe(
      `SELECT summary FROM entity_card WHERE deleted_at IS NULL`,
    )) as Array<{ summary: string }>;
    // Exactly one live card, and it is the original. Clearing `deleted_at`
    // before the delete would have aborted on the partial unique index.
    expect(live.length).toBe(1);
    expect(live[0]?.summary).toBe('The old summary.');

    const state = (await sql.unsafe(
      `SELECT state, closed_by, closed_at FROM review_queue WHERE review_id = $1::bigint`,
      [id],
    )) as Array<{ state: string; closed_by: string | null; closed_at: Date | null }>;
    expect(state[0]?.state).toBe('open');
    expect(state[0]?.closed_by).toBeNull();
    expect(state[0]?.closed_at).toBeNull();
  });

  test('an apply with no prior card undoes to no card, and says so', async () => {
    const entity = await insertEntity();
    const id = await enqueue({ targetRef: `entity:${entity}` });
    await decideProposal(sql, { reviewId: id, intent: 'apply', seenCardId: null,
      seenPair: null, now: NOW });

    expect(await undoProposal(sql, { reviewId: id })).toEqual({ ok: true, restored: false });
    const live = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM entity_card WHERE deleted_at IS NULL`,
    )) as Array<{ n: number }>;
    expect(live[0]?.n).toBe(0);
  });

  test('undoing twice refuses rather than deleting a later apply’s card', async () => {
    const entity = await insertEntity();
    const id = await enqueue({ targetRef: `entity:${entity}` });
    await decideProposal(sql, { reviewId: id, intent: 'apply', seenCardId: null,
      seenPair: null, now: NOW });
    await undoProposal(sql, { reviewId: id });
    expect(await undoProposal(sql, { reviewId: id })).toEqual({ ok: false, reason: 'nothing_to_undo' });
  });

  test('a dismissed row cannot be undone through this door', async () => {
    const id = await enqueue({ targetRef: 'entity:1' });
    await decideProposal(sql, { reviewId: id, intent: 'dismiss', seenCardId: null,
      seenPair: null, now: NOW });
    expect(await undoProposal(sql, { reviewId: id })).toEqual({ ok: false, reason: 'nothing_to_undo' });
  });
});

// ---------------------------------------------------------------------------
// Contradictions. The whole point is what does NOT happen.
// ---------------------------------------------------------------------------

describe('deciding a contradiction records a verdict and touches neither fact', () => {
  test('it writes status, resolution and the actor, and changes no fact at all', async () => {
    const left = await insertFact('Priya joined in March.');
    const right = await insertFact('Priya joined in April.');
    const report = await insertConflict(left, right);

    const outcome = await decideConflict(sql, { reportId: report, verdict: 'left', now: NOW });
    expect(outcome).toEqual({ ok: true, action: 'resolved' });

    const row = (await sql.unsafe(
      `SELECT status, resolution, resolved_by, resolved_at FROM contradiction_report`,
    )) as Array<{ status: string; resolution: string; resolved_by: string; resolved_at: Date }>;
    expect(row[0]?.status).toBe('resolved');
    expect(row[0]?.resolution).toBe('left');
    expect(row[0]?.resolved_by).toBe('user_out_of_band');

    // R12: report-only. Both statements stay live, searchable, and in the
    // briefing. A page that superseded one would be the only unrecoverable act
    // in the product.
    const facts = (await sql.unsafe(
      `SELECT superseded_by, deleted_at, quarantined_at FROM fact ORDER BY fact_id`,
    )) as Array<{ superseded_by: string | null; deleted_at: Date | null; quarantined_at: Date | null }>;
    for (const fact of facts) {
      expect(fact.superseded_by).toBeNull();
      expect(fact.deleted_at).toBeNull();
      expect(fact.quarantined_at).toBeNull();
    }
  });

  test('"neither" is a legal verdict, which is why this column is not a mutation trigger', async () => {
    const report = await insertConflict(
      await insertFact('One claim.'),
      await insertFact('Another claim.'),
    );
    expect(await decideConflict(sql, { reportId: report, verdict: 'neither', now: NOW })).toEqual({
      ok: true,
      action: 'resolved',
    });
  });

  test('a dismiss records the instant and no resolution', async () => {
    const report = await insertConflict(
      await insertFact('One claim.'),
      await insertFact('Another claim.'),
    );
    expect(await decideConflict(sql, { reportId: report, verdict: null, now: NOW })).toEqual({
      ok: true,
      action: 'dismissed',
    });
    const row = (await sql.unsafe(
      `SELECT status, resolution, resolved_at FROM contradiction_report`,
    )) as Array<{ status: string; resolution: string | null; resolved_at: Date | null }>;
    expect(row[0]?.status).toBe('dismissed');
    expect(row[0]?.resolution).toBeNull();
    expect(row[0]?.resolved_at).not.toBeNull();
  });

  test('a verdict about a withdrawn statement is refused; a dismiss is not', async () => {
    const left = await insertFact('Priya joined in March.');
    const right = await insertFact('Priya joined in April.');
    const report = await insertConflict(left, right);
    await sql.unsafe(`UPDATE fact SET deleted_at = $1::timestamptz WHERE fact_id = $2::bigint`, [
      NOW.toISOString(),
      right,
    ]);

    expect(await decideConflict(sql, { reportId: report, verdict: 'left', now: NOW })).toEqual({
      ok: false,
      reason: 'not_adjudicable',
    });
    // A permanent mute is still available: the row must not be stuck forever.
    expect(await decideConflict(sql, { reportId: report, verdict: null, now: NOW })).toEqual({
      ok: true,
      action: 'dismissed',
    });
  });

  test('a second decision finds it closed', async () => {
    const report = await insertConflict(await insertFact('A.'), await insertFact('B.'));
    await decideConflict(sql, { reportId: report, verdict: 'both', now: NOW });
    expect(await decideConflict(sql, { reportId: report, verdict: 'left', now: NOW })).toEqual({
      ok: false,
      reason: 'already_closed',
    });
  });
});
