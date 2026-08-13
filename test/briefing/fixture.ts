/**
 * Shared harness for the U12 briefing suite. Not a `*.test.ts` file.
 *
 * **The one thing this file is built to make impossible.** A cold-layer test
 * whose fixture is *always* cold passes for the wrong reason: the branch under
 * test is the only branch the fixture can reach, and an implementation that
 * returned the degraded shape unconditionally would be green. So there is one
 * seeder here and two verbs — {@link seedBrain} builds the corpus, and
 * {@link warmLayer} materialises U11's output over the *same* rows. Every cold
 * assertion in the suite has a warm twin over the identical brain.
 *
 * Everything below the assembler is real: a tenant database at the head of the
 * ladder, so the origin fence, the two origin-union triggers and the cursor
 * rung's constraints are all enforcing.
 */

import type { SQL } from 'bun';

import { textArrayLiteral } from '../../src/core/write/pg-values.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';

export const MAIL = 'personal:mail';
export const CALENDAR = 'personal:calendar';
export const WORK = 'work:mail';

export interface SeededBrain {
  readonly meetingPageId: string;
  readonly notePageId: string;
  readonly stalePageId: string;
  readonly fencedPageId: string;
  readonly entityId: string;
  readonly factId: string;
}

async function insertPage(
  sql: SQL,
  input: {
    readonly origin: string;
    readonly sourceType: string;
    readonly title: string;
    readonly body: string;
    readonly createdAt: string;
    readonly derivation?: string;
    readonly salience?: number | null;
    readonly staleAt?: string | null;
  },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO page (origin_context, source_type, title, created_at,
                      embedding_model, embedding_dimensions, chunker_version, normalizer_version,
                      content_sha256, derivation, salience, salience_source, stale_at)
    VALUES (${input.origin}, ${input.sourceType}, ${input.title}, ${input.createdAt}::timestamptz,
            'fixture-model', ${EMBEDDING_DIMENSIONS}, 1, 1, ${'0'.repeat(64)},
            ${input.derivation ?? 'ingested'},
            ${input.salience ?? null},
            ${input.salience === undefined || input.salience === null ? null : 'deterministic'},
            ${input.staleAt ?? null}::timestamptz)
    RETURNING page_id::text AS page_id
  `) as Array<{ page_id: string }>;
  const pageId = rows[0]?.page_id;
  if (pageId === undefined) throw new Error(`could not seed page ${input.title}`);

  await sql`
    INSERT INTO chunk (origin_context, content, page_id, ordinal, created_at)
    VALUES (${input.origin}, ${input.body}, ${pageId}::bigint, 0, ${input.createdAt}::timestamptz)
  `;
  return pageId;
}

/**
 * The brain both halves of every test share: a meeting whose body names a
 * person, an ordinary note, a stale-but-salient page, and one page behind a
 * fence the grant does not carry.
 */
export async function seedBrain(sql: SQL, at: string): Promise<SeededBrain> {
  const entity = (await sql`
    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('Priya Raghavan', 'person', ${textArrayLiteral([CALENDAR, MAIL])}::text[])
    RETURNING entity_id::text AS entity_id
  `) as Array<{ entity_id: string }>;
  const entityId = entity[0]?.entity_id;
  if (entityId === undefined) throw new Error('could not seed the entity');
  await sql`
    INSERT INTO entity_alias (entity_id, alias, alias_source)
    VALUES (${entityId}::bigint, 'priya@example.com', 'user')
  `;

  const meetingPageId = await insertPage(sql, {
    origin: CALENDAR,
    sourceType: 'calendar',
    title: 'Roadmap review',
    body: 'Roadmap review\nWhen: 2026-08-13T14:00:00Z\nAttendees: priya@example.com\nOrganizer: you@example.com',
    createdAt: at,
    salience: 0.8,
  });

  const notePageId = await insertPage(sql, {
    origin: MAIL,
    sourceType: 'email',
    title: 'Renewal terms',
    body: 'Priya Raghavan confirmed the renewal lands in October.',
    createdAt: at,
    salience: 0.4,
  });

  const stalePageId = await insertPage(sql, {
    origin: CALENDAR,
    sourceType: 'calendar',
    title: 'Cancelled offsite',
    body: 'Offsite, cancelled by the organiser.',
    createdAt: at,
    salience: 0.9,
    staleAt: at,
  });

  const fencedPageId = await insertPage(sql, {
    origin: WORK,
    sourceType: 'email',
    title: 'Board packet',
    body: 'Priya Raghavan sent the board packet.',
    createdAt: at,
  });

  // A meeting behind the same fence. Separate from the mail above because the
  // meetings lane has its own statement with its own grant predicate, and a
  // fixture whose only out-of-grant row is an email cannot tell whether that
  // predicate is there — dropping it leaks a calendar page and every other
  // assertion stays green.
  await insertPage(sql, {
    origin: WORK,
    sourceType: 'calendar',
    title: 'Board session',
    body: 'Board session\nAttendees: priya@example.com',
    createdAt: at,
  });

  const fact = (await sql`
    INSERT INTO fact (statement, embedding, origin_contexts, created_at, derivation, trust_level)
    VALUES ('Priya Raghavan confirmed the renewal lands in October.',
            ${`[1${',0'.repeat(EMBEDDING_DIMENSIONS - 1)}]`}::vector,
            ${textArrayLiteral([MAIL])}::text[], ${at}::timestamptz, 'ingested', 'rule_extracted')
    RETURNING fact_id::text AS fact_id
  `) as Array<{ fact_id: string }>;
  const factId = fact[0]?.fact_id;
  if (factId === undefined) throw new Error('could not seed the fact');

  return { meetingPageId, notePageId, stalePageId, fencedPageId, entityId, factId };
}

export interface WarmOptions {
  /** A contradiction the free tier could never have produced. Default 0. */
  readonly contradictions?: number;
  /** Mid-confidence proposals waiting on an out-of-band decision. Default 0. */
  readonly pendingReview?: number;
  readonly tier?: 'free' | 'paid';
}

/**
 * U11's output over the brain {@link seedBrain} already wrote: a completed,
 * dreamt run, one entity card, one open commitment.
 *
 * The origins are the unions the two constraint triggers demand — a card that
 * claimed less than the entity it describes would be refused by the database,
 * which is the point of writing through it rather than around it.
 */
export async function warmLayer(
  sql: SQL,
  brain: SeededBrain,
  at: string,
  options: WarmOptions = {},
): Promise<string> {
  const runId = await recordRun(sql, at, { tier: options.tier ?? 'paid', dreamt: true });

  await sql`
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence, model_id, run_id, origin_contexts)
    VALUES (${brain.entityId}::bigint, 'Runs the renewal; joined the roadmap review.',
            'model_inferred', 'model_derived', 0.9, 'fixture-model', ${runId}::bigint,
            ${textArrayLiteral([CALENDAR, MAIL])}::text[])
  `;

  await sql`
    INSERT INTO commitment (fact_id, page_id, statement, owner_name, due_on, state, trust_level,
                            derivation, compiled_truth, confidence, model_id, run_id, origin_contexts)
    VALUES (${brain.factId}::bigint, NULL, 'Send Priya the renewal redline', 'you', ${at}::date,
            'open', 'model_extracted', 'model_derived', true, 0.9, 'fixture-model',
            ${runId}::bigint, ${textArrayLiteral([MAIL])}::text[])
  `;

  for (let i = 0; i < (options.contradictions ?? 0); i += 1) {
    await sql`
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, run_id, origin_contexts)
      VALUES ('contradiction', ${`fact:${brain.factId}`}, ${`conflicting statement ${i}`}, 0.7,
              ${runId}::bigint, ${textArrayLiteral([MAIL])}::text[])
    `;
  }
  for (let i = 0; i < (options.pendingReview ?? 0); i += 1) {
    await sql`
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, run_id, origin_contexts)
      VALUES ('commitment', ${`fact:${brain.factId}`}, ${`proposed commitment ${i}`}, 0.6,
              ${runId}::bigint, ${textArrayLiteral([MAIL])}::text[])
    `;
  }

  return runId;
}

/** A consolidation run record, on its own — the free tier's shape included. */
export async function recordRun(
  sql: SQL,
  at: string,
  options: { readonly tier: 'free' | 'paid'; readonly dreamt: boolean },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO consolidation_run (trigger_reason, tier, dreamt, stop_reason, started_at, finished_at)
    VALUES ('time_ceiling', ${options.tier}, ${options.dreamt},
            ${options.dreamt ? 'complete' : options.tier === 'free' ? 'free_tier' : 'budget_exhausted'},
            ${at}::timestamptz, ${at}::timestamptz)
    RETURNING run_id::text AS run_id
  `) as Array<{ run_id: string }>;
  const runId = rows[0]?.run_id;
  if (runId === undefined) throw new Error('could not record a consolidation run');
  return runId;
}

/** Row counts over every content table a briefing must not touch. */
export async function contentCensus(sql: SQL): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT (SELECT count(*) FROM page)::int         AS pages,
           (SELECT count(*) FROM chunk)::int        AS chunks,
           (SELECT count(*) FROM fact)::int         AS facts,
           (SELECT count(*) FROM entity)::int       AS entities,
           (SELECT count(*) FROM entity_card)::int  AS cards,
           (SELECT count(*) FROM commitment)::int   AS commitments,
           (SELECT count(*) FROM review_queue)::int AS reviews,
           (SELECT count(*) FROM page WHERE updated_at > created_at)::int AS touched
  `) as Array<Record<string, number>>;
  return rows[0] ?? {};
}
