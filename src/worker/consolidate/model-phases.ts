/**
 * The metered half of the cycle. Five phases, five ops, five budgets.
 *
 * **Every one of them calls `src/ai/gateway.ts` with its op name and its own
 * budget object, and that is the whole of what they know about models.** No
 * phase names a model, resolves a key, or records spend — KTD13's table decides,
 * and `test/ai/boundary.test.ts` scans `src/` for the provider import that would
 * mean otherwise.
 *
 * **Three properties are shared by all five, and each is a way a phase goes
 * quietly wrong.**
 *
 *  1. **A refusal is carried out, never swallowed.** `budget_exhausted` stops
 *     the cycle at a checkpoint and yields "consolidated but not dreamt"; a
 *     transport failure stops it too, with a different reason, so an operator can
 *     tell "we ran out of money" from "the provider was down". A phase that
 *     caught either and returned zero items would look exactly like a brain with
 *     nothing to do.
 *  2. **Malformed output is a failure, not an empty result.** A model that
 *     answers with prose instead of JSON has not said "nothing to report"; it has
 *     said something this code cannot read. Defaulting to `[]` there would make a
 *     broken prompt indistinguishable from a clean corpus, on the op whose errors
 *     the plan calls unrecoverable.
 *  3. **Everything written carries a trust level, a derivation and a run id.**
 *     R12's requirement, and the anti-loop guard's storage: a row without them is
 *     a row the next cycle cannot tell from evidence.
 *
 * **Four of them also record what they have already looked at.** `extract`,
 * `enrich`, `contradiction` and `salience_refine` stamp a consideration version
 * on the row they consumed — chunk, entity, fact, page — for every row the model
 * gave a readable answer about, whatever that answer contained. Before that,
 * their selectors took the top N by salience or by id with no clause about work
 * already done, so the only thing between a second cycle and a second invoice
 * was a checkpoint row belonging to one run; and a per-run row cannot be kept
 * without keeping the run open, which is what stranded every later phase behind
 * one unreadable page. `transcribe` and `synopsis` need no stamp: their
 * durability is in the content. See `consideration.ts`.
 *
 * **A per-item failure is the ITEM's outcome and never the phase's.** The three
 * properties above were written for the phases that call the model once for a
 * whole batch, where "this answer failed" and "this phase failed" are the same
 * sentence. `synopsis` calls it once per *page*, and there the two come apart: a
 * page the model cannot summarise is one page's problem, and returning on it —
 * which is what this file used to do — stopped the cycle, which left the run
 * open, which left `extract`'s checkpoint standing, which skipped extraction on
 * every resume. One unusable page out of 5,608 pinned a brain at 167 facts.
 *
 * So the per-item loop skips the item and **completes**. `stopped: null` even
 * when every page it was given was skipped, because a phase that reported a
 * failure whenever `applied === 0` put the freeze back the moment the unreadable
 * pages were all that was left — which is the state the candidate set converges
 * to, since a skipped page writes nothing and is offered again next cycle.
 *
 * Rung 23 broke the same chain at its third link: a cycle that stops now closes
 * its run anyway, so a stopped phase can no longer strand another phase's
 * checkpoint. Both fixes stay, and neither makes the other redundant. This one
 * is about **the cycle finishing its work** — a brain whose contradiction and
 * salience phases are never reached because page four is unreadable is a brain
 * doing a fraction of what it is for, whatever the run record says. That one is
 * about the cycle **ending**, which is what makes the failure survivable rather
 * than permanent.
 *
 * The unreadable page therefore stays a candidate forever and costs one model
 * call a cycle. That price is small, permanent and bounded by the phase's own
 * candidate limit, and it is the correct side of the trade: the alternative,
 * tried and refused, was retiring the page via `page.quarantined_at` — U9's
 * column, which EVERY read honours, so a page the summariser could not parse
 * would leave search, the briefing and the user's own self-export too. The harm
 * is not "missing from consolidation"; it is a document its owner still has, no
 * longer coming back when they search their own brain.
 *
 * **One case still stops the phase, and it is decided from the answer rather
 * than from a count of items: a failure whose cause is provably not the item.**
 * {@link stopFor} already draws that line — `durable` means the provider read
 * the request and refused THIS request, and everything else means the request
 * never got a verdict at all. Every non-transport refusal the gateway can report
 * is config-shaped (a key that will not resolve, a denied scope, an unpriced
 * model) and arrives not-durable, as does a rate limit, a 5xx and a dead socket.
 * Each of those fails the next page identically, so the first one is the whole
 * of the evidence and no count is needed to reach it. `budget_exhausted` and
 * `out_of_time` stop for the same reason: they are the cycle's limits, not the
 * item's.
 *
 * The one failure deliberately left on the per-item side is an HTTP 200 whose
 * body will not parse. It is a page the model can never read and a badly sampled
 * answer at the same time, and nothing here can tell those apart in one
 * exchange — so it is counted against the page ({@link noteRefusal}) for an
 * operator to read, and never acted on. The honest handling of a signal the code
 * cannot trust is to skip the item, not to stop the brain.
 *
 * **What no phase does is mutate on the model's say-so.** ≥0.8 applies, 0.5–0.8
 * queues for a human, <0.5 is counted and dropped. The contradiction phase does
 * not even have an apply branch: R12 says handling is report-only, so the gate
 * governs *what gets written down*, and what gets written down is a report.
 */

import type { SQL } from 'bun';

import type { Budget, ModelGateway } from '../../ai/gateway.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import type { StoredPayloadReader } from '../../core/media/accept.ts';
import { runTranscribePhase } from '../../core/media/ocr-phase.ts';
import { embeddingSeatFor } from '../../ai/routing.ts';
import { documentEncoding, embedTexts, vectorLiteral } from '../../core/write/embed.ts';
import { nameMatchPattern } from '../../core/search/name-match.ts';
import { textArrayLiteral } from '../../core/write/pg-values.ts';
import { seatColumnSql } from '../../schema/embedding-seat.ts';
import {
  MODEL_DERIVED,
  admitToCompiledTruth,
  attestationsForOrigins,
  buildContradictionPrompt,
  buildEnrichPrompt,
  buildExtractionPrompt,
  buildSaliencePrompt,
  buildSynopsisPrompt,
  enqueueReview,
  gateFor,
  selectExtractionCandidates,
  selectIngestedPages,
  writeCanonicalSummary,
  writeCommitment,
  writeEntityCard,
  type Prompt,
} from './materialize.ts';
import {
  CONSIDERATION_VERSION,
  markConsidered,
  type ConsiderationVersions,
} from './consideration.ts';
import { unboundedAttempt, type AttemptBudget } from './deadline.ts';
import { NO_SPEND } from './estimate.ts';
import type { ModelPhase, PhaseFailure, PhaseStop } from './phases.ts';
import { PHASE_OP, stopFor } from './phases.ts';

/**
 * Why a phase stopped short. `null` means it finished its work.
 *
 * Declared in `phases.ts` and re-exported here, where every caller already looks
 * for it. It moved because rung 20 persists it beside the phase name on the run
 * record, and the CHECK that guards that column has to be written against an
 * array the code can enumerate — which puts the vocabulary next to
 * `CYCLE_PHASES`, the other half of the same fact.
 */
export type { PhaseStop };

export interface PhaseOutcome {
  readonly phase: ModelPhase;
  /** Candidates this phase was given. Zero means the brain had nothing to do. */
  readonly items: number;
  readonly applied: number;
  readonly queued: number;
  readonly logged: number;
  /**
   * Items this phase passed over, a subset of `logged`.
   *
   * Named for the items rather than bare `skipped` because `PhaseRecord.skipped`
   * in `cycle.ts` already means "this phase did not run at all, and here is
   * why", and the two are in scope together throughout the phase loop.
   *
   * Non-zero only on a per-item phase, where an item's failure is the item's
   * outcome rather than the phase's. It is counted separately from `logged`
   * because the phase now COMPLETES through these — nothing in `stopped` will
   * mention them — and a pass that summarised nothing because every page was
   * unreadable would otherwise be indistinguishable on the run record from a
   * brain with nothing left to summarise. This number is the difference, and it
   * is why completing through a failure is not the same as swallowing one.
   */
  readonly skippedItems: number;
  readonly spentMicroUsd: number;
  readonly modelCalls: number;
  readonly stopped: PhaseStop | null;
}

export interface ModelPhaseDeps {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget: Budget;
  readonly runId: string;
  readonly now: Date;
  /** How many candidates one pass considers. Bounded so a cycle is bounded. */
  readonly limit?: number;
  /**
   * The attempt's wall clock, consulted between items by the phases that loop.
   *
   * Absent means unbudgeted, which is what a phase test wants and what every
   * caller had before the cycle could see its own deadline.
   */
  readonly attempt?: AttemptBudget;
  /** Injected in tests so a prompt is byte-comparable. Production mints one. */
  readonly nonce?: string;
  /**
   * The consideration version each phase selects and stamps at.
   *
   * Absent means the shipped numbers, which is what production wants and what
   * every caller had before the marker existed. A caller passes its own only to
   * express a bump — see `consideration.ts`.
   */
  readonly consideration?: ConsiderationVersions;
  /**
   * U21's transcription phase reads the stored payload back through this port.
   * Absent for a fleet with no object store wired: the phase then finds work it
   * cannot do and says so, rather than reporting a brain with nothing to read.
   */
  readonly payloads?: StoredPayloadReader;
}

const DEFAULT_LIMIT = 200;

/**
 * The shortest canonical name `enrich` will gather evidence for.
 *
 * {@link nameMatchPattern}'s docstring requires every caller to bring its own
 * floor, because no pattern can repair a one- or two-character form: it is a
 * substring rather than a name. `src/mcp/reads.ts` and
 * `src/core/briefing/assemble.ts` carry the same 3. An entity below it gets an
 * empty evidence array and the model is asked to write a card from nothing,
 * which is the honest input — it used to be asked to write one from every
 * statement in the brain containing those two letters.
 */
const ENRICH_NAME_FLOOR = 3;

function empty(phase: ModelPhase, stopped: PhaseStop | null = null): PhaseOutcome {
  return {
    phase,
    items: 0,
    applied: 0,
    queued: 0,
    logged: 0,
    skippedItems: 0,
    spentMicroUsd: NO_SPEND,
    modelCalls: 0,
    stopped,
  };
}

/**
 * The stop/skip seam, imported rather than declared.
 *
 * It lived here while `runSynopsisPhase` was the only per-item model loop. It is
 * not any more — `runTranscribePhase` draws the same line on the same fact — and
 * a second copy of "which failures are the item's" is the thing that would drift
 * until the two phases disagreed about whether a 413 is a page's fault. See
 * `phases.ts`, which both loops already import.
 */

/**
 * A completion, or the code that explains its absence — never both, never
 * neither.
 *
 * A union rather than one record with nullable halves, because the per-item
 * loops now *branch* on the code instead of returning it verbatim: a shape where
 * `ok: false` could carry `stop: null` has a path where a call failed and no
 * caller can say why, and the honest handling of that is unwritable. The union
 * deletes the path.
 */
type ChatOutcome =
  | {
      readonly ok: true;
      readonly text: string;
      readonly costMicroUsd: number;
      readonly modelId: string;
    }
  | ({ readonly ok: false } & PhaseFailure);

async function chat(deps: ModelPhaseDeps, phase: ModelPhase, prompt: Prompt): Promise<ChatOutcome> {
  const result = await deps.gateway.call({
    op: PHASE_OP[phase],
    tenantId: deps.tenantId,
    caller: deps.caller,
    budget: deps.budget,
    input: { kind: 'chat', system: prompt.system, user: prompt.user },
  });

  if (!result.ok) return { ok: false, ...stopFor(result) };
  // A chat op that answered with an embedding is KTD13's table pointing at the
  // wrong seat. **Never durable, and that word now decides where the failure
  // lands**: a routing bug is a fact about the configuration, not about the
  // page, and it would meet every remaining item identically — so a per-item
  // loop stops on it at once rather than skipping a whole candidate set past a
  // misrouted seat, one paid call at a time.
  if (result.output.kind !== 'chat') return { ok: false, stop: 'bad_output', durable: false };
  return {
    ok: true,
    text: result.output.text,
    costMicroUsd: result.metering.costMicroUsd ?? 0,
    modelId: result.metering.modelId,
  };
}

/**
 * Read a JSON object out of a completion, or refuse.
 *
 * Tolerant of a fenced code block, because models emit them and rejecting one is
 * a formatting quarrel rather than a safety property. Intolerant of everything
 * else: a `null`, an array, a number and a sentence all mean the model did not
 * answer the question, and the honest name for that is `bad_output`.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  if (body.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function rows(body: Record<string, unknown>, key: string): Record<string, unknown>[] | null {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    out.push(entry as Record<string, unknown>);
  }
  return out;
}

function text(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A row id the model echoed back, as the string the caller keyed its map with.
 *
 * **This exists because {@link text} was doing the job and could not.** Every
 * phase that asks the model about many rows at once hands out ids and matches
 * the answers back by them, and the id is a `bigint` rendered into the prompt as
 * a string. What comes back is JSON, and **whether an id returns as `"1344"` or
 * as `1344` is the seat's choice, not ours** — the same prompt gets both from
 * different models, and neither is wrong.
 *
 * `text` refuses a number, correctly: for `statement`, `summary` or `topic` a
 * number means the model did not answer the question. Applied to an id it meant
 * something else, and the two failures it produced were not the same shape:
 *
 *   * `salience_refine` compares the id against a `known` set and counts a miss
 *     as `logged`, so **every score was silently discarded** while the phase
 *     reported success and `markConsidered` retired the whole batch. Measured on
 *     the live seat, which returns `{"page_id":1344,"salience":0.6}`: 186 pages
 *     marked considered, 25 ever scored. A brain could run this phase for its
 *     whole life and never receive a single model score.
 *   * `extract` and `contradiction` fall back rather than drop — extract to
 *     `candidates[0]`, so a numeric id would attribute every fact in the batch
 *     to the batch's first chunk. Worse than dropping, and invisible.
 *
 * Both are the same defect, and it bit only where it bit because the seats
 * differ: the reasoning seat behind `salience` emits numeric ids, the Gemini
 * seat behind `extract` and `contradiction` quotes them. That is a fact about
 * this quarter's routing table and not a property anything guarantees, which is
 * why the fix is here rather than in a prompt.
 *
 * **Only a safe, non-negative integer is admitted.** A `bigint` past 2^53 has
 * already lost precision by the time `JSON.parse` hands it over, so accepting it
 * would key the lookup with a *different* id — and a float or a negative is not
 * an id at all. A refusal here is still a miss the caller counts; nothing is
 * applied on a guess.
 */
function identifier(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * A confidence the model reported, or `null`.
 *
 * `null` rather than a default, and the default it is refusing is the dangerous
 * one: an omitted confidence read as 1 would apply an unscored claim, which is
 * precisely the mutation R12's gate exists to prevent.
 */
function confidence(row: Record<string, unknown>): number | null {
  const value = row['confidence'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// extract.
// ---------------------------------------------------------------------------

/**
 * Model extraction over the chunks the anti-loop guard admits.
 *
 * Facts it applies are embedded through the *same* phase budget, as the
 * `embedding` op: `fact.embedding` is `NOT NULL` by U3's design, so a fact
 * without a vector is a row the database refuses, and the phase that creates the
 * fact is the one that has to pay for its vector. Charging it to the cycle at
 * large would put an unbudgeted provider call inside a budgeted phase.
 */
export async function runExtractPhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'extract';
  const version = (deps.consideration ?? CONSIDERATION_VERSION).extract;
  const candidates = await selectExtractionCandidates(deps.sql, {
    limit: deps.limit ?? DEFAULT_LIMIT,
    consideredVersion: version,
  });
  if (candidates.length === 0) return empty(phase);

  const byId = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
  const prompt = buildExtractionPrompt({
    chunks: candidates,
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });
  const answer = await chat(deps, phase, prompt);
  if (!answer.ok) return { ...empty(phase, answer.stop), items: candidates.length };

  const body = parseJsonObject(answer.text);
  const facts = body === null ? null : rows(body, 'facts');
  if (facts === null) return { ...empty(phase, 'bad_output'), items: candidates.length, modelCalls: 1 };

  let applied = 0;
  let queued = 0;
  let logged = 0;
  let spent = answer.costMicroUsd;

  for (const row of facts) {
    const statement = text(row, 'statement');
    const chunkId = identifier(row, 'chunk_id');
    const score = confidence(row);
    if (statement === null || score === null) {
      logged += 1;
      continue;
    }
    const source = chunkId === null ? candidates[0] : byId.get(chunkId) ?? candidates[0];
    if (source === undefined) {
      logged += 1;
      continue;
    }

    const verdict = gateFor(score);
    if (verdict === 'log') {
      logged += 1;
      continue;
    }
    if (verdict === 'review') {
      await enqueueReview(deps.sql, {
        kind: row['commitment'] === true ? 'commitment' : 'fact',
        targetRef: `chunk:${source.chunkId}`,
        proposal: statement,
        confidence: score,
        runId: deps.runId,
        origins: source.origins,
      });
      queued += 1;
      continue;
    }

    if (row['commitment'] === true) {
      // R12a is decided here, once, and stored. The claim is recorded either way
      // — refusing to record it would throw away the evidence a user needs to
      // see the attempt — and admission to the compiled-truth surface is what
      // the corroboration verdict governs.
      const admission = admitToCompiledTruth(
        attestationsForOrigins(source.origins, [
          { sourceType: source.sourceType, externalRef: source.externalRef },
        ]),
      );
      await writeCommitment(deps.sql, {
        statement,
        owner: text(row, 'subject'),
        pageId: source.pageId,
        factId: null,
        confidence: score,
        modelId: answer.modelId,
        runId: deps.runId,
        origins: source.origins,
        compiledTruth: admission.admitted,
      });
      applied += 1;
      continue;
    }

    const embedded = await embedTexts({
      gateway: deps.gateway,
      tenantId: deps.tenantId,
      caller: deps.caller,
      budget: deps.budget,
      texts: [documentEncoding({ title: source.title, content: statement })],
    });
    if (!embedded.ok) {
      // The vector is not optional and the budget is not negotiable: a fact the
      // database would refuse is not written, and the phase reports why.
      return {
        phase,
        items: candidates.length,
        applied,
        queued,
        logged,
        // A whole-batch phase skips nothing: the request it sent was a batch, so
        // an answer it cannot read indicts the batch and not any item inside it.
        // "This answer failed" and "this phase failed" are one sentence here,
        // which is why only the per-item loops need the distinction at all.
        skippedItems: 0,
        spentMicroUsd: spent,
        modelCalls: 1,
        stopped: embedded.reason === 'budget_exhausted' ? 'budget_exhausted' : 'model_unavailable',
      };
    }
    const vector = embedded.vectors[0];
    if (vector === undefined) {
      logged += 1;
      continue;
    }

    // The seat of the model that produced THIS vector, resolved from what the
    // gateway reported having called — the same rule the write path follows,
    // for the same reason: a consolidation-derived fact written into a column
    // the read arm does not scan is a claim the brain paid to compute and can
    // never retrieve, and nothing anywhere reports it.
    const seat = embeddingSeatFor(embedded.modelId);
    if (seat === undefined) {
      logged += 1;
      continue;
    }

    const inserted = (await deps.sql.unsafe(
      `INSERT INTO fact (statement, ${seatColumnSql(seat.column)}, origin_contexts, page_id,
                         confidence, derivation, trust_level, run_id)
       VALUES ($1, $2::vector, $3::text[], $4::bigint, $5, $6, 'model_extracted', $7::bigint)
       RETURNING fact_id::text AS fact_id`,
      [
        statement,
        vectorLiteral([...vector], seat),
        textArrayLiteral([...source.origins].sort()),
        source.pageId,
        score,
        MODEL_DERIVED,
        deps.runId,
      ],
    )) as Array<{ fact_id: string }>;
    const factId = inserted[0]?.fact_id;
    if (factId !== undefined) {
      await deps.sql`
        INSERT INTO fact_source (fact_id, chunk_id)
        VALUES (${factId}::bigint, ${source.chunkId}::bigint)
        ON CONFLICT DO NOTHING
      `;
    }
    applied += 1;
  }

  // **Every candidate is now considered, whatever it yielded.** Written here
  // rather than beside each applied fact, because the unit the model answered
  // about is the batch: a chunk that stated no claim got an answer just as much
  // as one that produced three, and a marker that only followed output would
  // offer the silent chunks again next cycle at the top of the salience queue,
  // forever.
  //
  // Not reached from the refusal paths above, and that asymmetry is deliberate.
  // A gateway that refused, an answer this code could not read, or an embedding
  // that failed part way through the loop all mean some of this batch never got
  // a verdict — so nothing is stamped, the batch is offered again next cycle,
  // and the duplicate facts a re-run writes are what `dedup` already collapses.
  // Losing a chunk is the one direction this marker must never be wrong in.
  await markConsidered(deps.sql, phase, [...byId.keys()], version);

  // The embedding calls settle against the same budget, so the phase's spend is
  // what the budget says rather than what the chat call alone cost.
  spent = deps.budget.spentMicroUsd();
  return {
    phase,
    items: candidates.length,
    applied,
    queued,
    logged,
    skippedItems: 0,
    spentMicroUsd: spent,
    modelCalls: 1,
    stopped: null,
  };
}

// ---------------------------------------------------------------------------
// enrich.
// ---------------------------------------------------------------------------

/**
 * Entities per enrich prompt.
 *
 * **Not a fix for today's brain, and the difference matters.** `DEFAULT_LIMIT`'s
 * 200 is a ceiling on a SELECT over a few dozen live entities, and the
 * unevidenced are already dropped before the prompt is built, so the batch does
 * not fill. This is the precondition for anything that adds evidenced entities
 * on a cadence.
 *
 * Both failure branches past the route's output ceiling are silent, in
 * different ways. A truncated answer is **billed** — the gateway settles the
 * spend before it returns the failure — and stamps nothing, so the identical
 * rows come back every cycle forever. An answer the model closes early stamps
 * the whole batch considered with most cards never written. `SALIENCE_REFINE_BATCH`
 * is the shipped precedent and was arrived at the same way.
 */
const ENRICH_BATCH = 25;

export async function runEnrichPhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'enrich';
  // The `Math.min` shape, so no caller can widen the batch past what the route
  // can answer in one reply.
  const limit = Math.min(deps.limit ?? ENRICH_BATCH, ENRICH_BATCH);
  const version = (deps.consideration ?? CONSIDERATION_VERSION).enrich;

  const candidates = (await deps.sql`
    SELECT e.entity_id::text AS entity_id, e.canonical_name, e.entity_type, e.origin_contexts
      FROM entity e
     WHERE e.deleted_at IS NULL
       -- The phase's durability, and the reason a stopped cycle no longer costs
       -- a second invoice. Without it this query returned the same first N
       -- entities by id on every cycle for the life of the brain.
       AND (e.enrich_considered_version IS NULL OR e.enrich_considered_version < ${version})
     ORDER BY e.entity_id
     LIMIT ${limit}
  `) as Array<{
    entity_id: string;
    canonical_name: string;
    entity_type: string;
    origin_contexts: string[];
  }>;

  if (candidates.length === 0) return empty(phase);

  // **The evidence join, word-bounded, in a second statement rather than a
  // correlated `ILIKE '%' || canonical_name || '%'`.**
  //
  // The wildcard this replaces is the bug `src/mcp/reads.ts` documents having
  // fixed on its own side: `%al%` reaches the person called Al through `legal`,
  // `renewal` and `Alberta`. Here it cost money rather than relevance — an
  // entity called `X`, `Here` or `That` pulled hundreds of unrelated statements
  // into a **paid** prompt and then had a summary written out of them, on a
  // brain that had 26 such rows. `nameMatchPattern` is the shared
  // implementation and {@link ENRICH_NAME_FLOOR} is the length floor its
  // docstring requires of every caller.
  //
  // It is a second round trip and deliberately so: the pattern has to be built
  // per name in TypeScript to be *bound* rather than interpolated, and a
  // per-entity query would have been `limit` of them. This is one, whatever
  // `limit` is.
  const matchable = candidates.filter(
    (entity) => entity.canonical_name.trim().length >= ENRICH_NAME_FLOOR,
  );
  const evidenceByEntity = new Map<string, string[]>();
  if (matchable.length > 0) {
    const rows_ = (await deps.sql.unsafe(
      `SELECT u.entity_id, array_agg(f.statement ORDER BY f.fact_id) AS evidence
         FROM unnest($1::text[], $2::text[]) AS u(entity_id, pattern)
         JOIN fact f
           ON f.deleted_at IS NULL AND f.quarantined_at IS NULL AND f.superseded_by IS NULL
          AND f.statement ~* u.pattern
        GROUP BY u.entity_id`,
      [
        textArrayLiteral(matchable.map((entity) => entity.entity_id)),
        textArrayLiteral(matchable.map((entity) => nameMatchPattern(entity.canonical_name))),
      ],
    )) as Array<{ entity_id: string; evidence: string[] }>;
    for (const row of rows_) evidenceByEntity.set(row.entity_id, row.evidence);
  }

  // **An entity the corpus says nothing about is not sent to the model.**
  //
  // Without this the phase asked for a summary of an entity whose evidence
  // array was empty, and the model answered the only way it honestly could:
  // *"Entity listed without additional context in the evidence."* Three such
  // cards existed on the founder's brain, two of them approved through the
  // review queue, all of them written from nothing at the paid tier.
  //
  // The batch is bounded by {@link DEFAULT_LIMIT} rather than by how much the
  // brain actually knows, so this is not a rounding error: every unevidenced
  // row took a slot in the prompt away from one that had something to say. It
  // became sharper the day the evidence join was word-bounded — a name below
  // {@link ENRICH_NAME_FLOOR}, and any name the corpus states only inside
  // longer words, now returns an honestly empty array where the wildcard used
  // to return spurious matches and hide the problem.
  //
  // They are still **marked considered**, on the same argument the whole-batch
  // marker below is written on: the phase has decided about them at this
  // version, and a marker that only followed a model call would offer the same
  // silent entities again every cycle while the ones behind them waited.
  const withEvidence: Array<(typeof candidates)[number] & { evidence: string[] }> = [];
  const unevidenced: string[] = [];
  for (const candidate of candidates) {
    const evidence = evidenceByEntity.get(candidate.entity_id) ?? [];
    if (evidence.length === 0) {
      unevidenced.push(candidate.entity_id);
      continue;
    }
    withEvidence.push({ ...candidate, evidence });
  }
  if (unevidenced.length > 0) await markConsidered(deps.sql, phase, unevidenced, version);
  if (withEvidence.length === 0) return { ...empty(phase), items: unevidenced.length };

  const entities = withEvidence;
  const byName = new Map(entities.map((entity) => [entity.canonical_name, entity]));
  const prompt = buildEnrichPrompt({
    entities: entities.map((entity) => ({
      name: entity.canonical_name,
      type: entity.entity_type,
      evidence: entity.evidence,
      origins: entity.origin_contexts,
    })),
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });

  const answer = await chat(deps, phase, prompt);
  if (!answer.ok) return { ...empty(phase, answer.stop), items: entities.length };

  const body = parseJsonObject(answer.text);
  const cards = body === null ? null : rows(body, 'cards');
  if (cards === null) return { ...empty(phase, 'bad_output'), items: entities.length, modelCalls: 1 };

  let applied = 0;
  let queued = 0;
  let logged = 0;

  for (const row of cards) {
    const name = text(row, 'entity');
    const summary = text(row, 'summary');
    const score = confidence(row);
    const entity = name === null ? undefined : byName.get(name);
    if (summary === null || score === null || entity === undefined) {
      logged += 1;
      continue;
    }

    const verdict = gateFor(score);
    if (verdict === 'log') {
      logged += 1;
      continue;
    }
    if (verdict === 'review') {
      await enqueueReview(deps.sql, {
        kind: 'entity_card',
        targetRef: `entity:${entity.entity_id}`,
        proposal: summary,
        confidence: score,
        runId: deps.runId,
        origins: entity.origin_contexts,
      });
      queued += 1;
      continue;
    }

    const written = await writeEntityCard(deps.sql, {
      entityId: entity.entity_id,
      summary,
      confidence: score,
      modelId: answer.modelId,
      runId: deps.runId,
      evidenceOrigins: entity.origin_contexts,
    });
    // `null` means the entity already carries a card the OWNER approved, and
    // this phase declined to overwrite it. Not applied, and not logged as a
    // refusal either: nothing went wrong and nothing needs looking at. The
    // whole-batch `markConsidered` below still stamps it, so a declined entity
    // is not re-offered every cycle for the life of the brain.
    if (written !== null) applied += 1;
  }

  // The whole batch, card or no card. An entity the model declined to write
  // about, or scored below the gate, has still been asked about at this version
  // — and a marker that followed the card would offer the thin entities again
  // every cycle while the ones behind them waited.
  await markConsidered(deps.sql, phase, entities.map((entity) => entity.entity_id), version);

  return {
    phase,
    items: entities.length + unevidenced.length,
    applied,
    queued,
    logged,
    skippedItems: 0,
    spentMicroUsd: answer.costMicroUsd,
    modelCalls: 1,
    stopped: null,
  };
}

// ---------------------------------------------------------------------------
// synopsis — and the compiled-truth surface.
// ---------------------------------------------------------------------------

/**
 * One canonical summary per page, and R12a's admission decision on each.
 *
 * The summary is where a crafted message would most like to end up: it is short,
 * it reads as the brain's own voice, and U5's compiled-truth boost is aimed at
 * it. So the page is written `model_derived` (no later cycle reads it back as
 * evidence) and its `compiled_truth` flag is the corroboration verdict, taken
 * against the origins of the page it summarises.
 */
export async function runSynopsisPhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'synopsis';
  const attempt = deps.attempt ?? unboundedAttempt();
  // `unsummarised` is the phase's resume mechanism. It calls the model once per
  // page, so it is the one model phase whose cost is a *loop* — 200 sequential
  // provider round trips at the cycle's default limit, which is the single
  // largest term in the wall clock of a paid cycle and is independent of how big
  // the brain is. Whole-phase checkpointing cannot bank a partial loop, so the
  // progress is banked in the content: a page with a summary is not selected.
  const pages = await selectIngestedPages(deps.sql, {
    limit: deps.limit ?? 25,
    unsummarised: true,
  });
  if (pages.length === 0) return empty(phase);

  let applied = 0;
  let logged = 0;
  let calls = 0;
  let skippedItems = 0;

  const outcome = (stopped: PhaseStop | null): PhaseOutcome => ({
    phase,
    items: pages.length,
    applied,
    queued: 0,
    logged,
    skippedItems,
    spentMicroUsd: deps.budget.spentMicroUsd(),
    modelCalls: calls,
    stopped,
  });

  /**
   * Count one refusal against a page. **Telemetry, and nothing reads it back.**
   *
   * Nothing is retired any more, which is exactly why this exists: an operator
   * watching a summary count that will not move needs to tell three unreadable
   * pages refused forty times each from every page refused once, and only the
   * second of those is a broken prompt or a seat whose ceiling is too tight. The
   * phase's `skippedItems` says how many; this says which, and for how long.
   *
   * **The moment anything compares this against a threshold, the refuted design
   * is back.** A counter that decides is a counter whose increments have to be
   * trusted, and the parse-failure increment below is precisely the signal this
   * code says it cannot trust. It is written to be read by a person.
   *
   * Called only for the two outcomes the model is answerable for. A transient
   * stops the phase before any page is charged for it, so an outage of any
   * length moves nothing here, however many pages it touches — and an operator
   * reading a non-zero count is therefore never reading an outage.
   *
   * `updated_at` is deliberately left alone, where the retiring version of this
   * write moved it. Today the column's only other writer is the staleness phase
   * marking a page stale, so its one established meaning is "something about
   * this page changed" — and a phase failing to READ a page has changed nothing
   * about it. Nothing consumes the column yet, which is the argument for care
   * rather than against it: the cheapest moment to keep a timestamp honest is
   * before anything depends on it, and a counter that moved it would make an
   * untouched document look edited to whatever reads it first.
   */
  const noteRefusal = async (pageId: string): Promise<void> => {
    // One statement against the stored count rather than a read followed by a
    // write: two attempts of the same run can meet the same page, and the losing
    // half of a read-modify-write would be a refusal nobody counted.
    await deps.sql`
      UPDATE page
         SET consolidation_refusals = consolidation_refusals + 1
       WHERE page_id = ${pageId}::bigint
    `;
  };

  for (const page of pages) {
    // Checked **before** the call, not after: the cheapest place to stop is the
    // one where the next unit of work has not been paid for yet.
    if (attempt.stop() !== null) return outcome('out_of_time');

    const prompt = buildSynopsisPrompt({
      title: page.title,
      text: page.text,
      origins: page.origins,
      ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
    });
    const answer = await chat(deps, phase, prompt);
    if (!answer.ok) {
      // The cap is not the page's fault and no other page will fare better
      // against it, so it stops the phase at once and under its own name — the
      // cycle turns it into `budget_exhausted` rather than `phase_failed`, and
      // burning another call to rediscover it would be spending money the budget
      // has already refused.
      if (answer.stop === 'budget_exhausted') return outcome('budget_exhausted');
      // **The stop/skip line, and it is drawn from the answer rather than from a
      // tally.** Not durable means the provider never gave this request a
      // verdict: it was down, the socket died, the key would not resolve, the
      // scope was denied, we were rate-limited. Every remaining page meets that
      // identically, so the first one is the whole of the evidence — counting to
      // three would only buy two more calls into the same wall — and the phase
      // stops rather than walking a whole candidate set into a dead provider.
      // The pages it did not reach are still unsummarised, so the next cycle
      // selects exactly them; nothing is owed to a run that stayed open.
      if (!answer.durable) return outcome(answer.stop);
      // Durable: the provider read the request and refused THIS request, a
      // 400/413/422. That is one page's outcome. It is skipped, counted, and
      // offered again next cycle — a payload too large today is a payload a
      // re-chunk or a wider seat accepts tomorrow, and none of that is the
      // document's fault.
      await noteRefusal(page.pageId);
      logged += 1;
      skippedItems += 1;
      continue;
    }
    calls += 1;

    const body = parseJsonObject(answer.text);
    const summary = body === null ? null : text(body, 'summary');
    if (summary === null) {
      // **The widest failure, and the one that must never be acted on.** The
      // provider was reachable, billed us, and produced something this code
      // cannot read — which for a page whose size or shape defeats the model is
      // permanent, and for a model that sampled badly once is not. Nothing here
      // can tell those apart in one exchange, and a previous design that retired
      // the page after two of these would have removed real documents from the
      // owner's search on an inference this comment concedes cannot be made.
      //
      // So it is the page's outcome and it is only ever recorded: skipped,
      // counted, offered again next cycle, forever if need be. One wasted call
      // per unreadable page per cycle is the standing price, and it is the right
      // side of the trade.
      await noteRefusal(page.pageId);
      logged += 1;
      skippedItems += 1;
      continue;
    }

    const written = await writeCanonicalSummary(deps.sql, {
      sourcePageId: page.pageId,
      title: page.title,
      summary,
      origins: page.origins,
      sources: [{ sourceType: page.sourceType, externalRef: page.externalRef }],
      runId: deps.runId,
    });
    // A synthesis whose inputs span more than one origin has no honest scalar to
    // be filed under, and the seam refuses it. Counted as `logged` and skipped
    // but NOT as a refusal on the page: the model answered, this code declined
    // the result, and a counter named for what the summariser could not read
    // must not fill up with what this file would not write. Unreachable from
    // here today — `selectIngestedPages` derives `origins` from a page's own
    // scalar column — and read rather than ignored, because a caller that
    // discarded the outcome is how the seam's refusal would come to mean nothing
    // the day a phase summarises across pages.
    if (!written.ok) {
      logged += 1;
      skippedItems += 1;
      continue;
    }
    applied += 1;
  }

  // **The phase did everything it could do, so it completes — including when
  // everything it could do was skip.**
  //
  // This is the line the whole redesign turns on, and it looks wrong until the
  // chain behind it is read. `stopped` is not a report card; it is what makes
  // the cycle stop, and a cycle that stops here never reaches the contradiction
  // and salience phases at all. An earlier version returned the last failure
  // whenever `applied === 0` — reasonable-sounding, and it put the freeze back
  // exactly when it mattered: a skipped page is offered again next cycle, so the
  // candidate set converges onto the unreadable ones, and the pass where they
  // are all that is left is a pass that applied nothing. Every later phase then
  // stopped being reached, cycle after cycle, which is the incident.
  //
  // A pass that summarised nothing is not thereby hidden. `items`, `logged` and
  // `skippedItems` are on this outcome and reach the fleet's cycle log, and the
  // per-page counter says which pages and for how long. The refusal that must
  // not be swallowed is the systemic one, and that is carried out above, at the
  // first answer that proves it — not inferred here from an empty pass, which
  // an unreadable corpus and a dead provider produce alike.
  return outcome(null);
}

// ---------------------------------------------------------------------------
// contradiction — detection and report, never resolution.
// ---------------------------------------------------------------------------

/**
 * Find pairs that cannot both be true, and write them down.
 *
 * **There is no apply branch, and its absence is the feature.** R12 says
 * contradiction handling is report-only, so a high confidence buys a report and
 * nothing else — the facts on both sides are untouched at any score. The
 * confidence gate still runs, because it decides whether the report is worth
 * making: below 0.5 the model is guessing, and a fabricated conflict is worse
 * than a missed one when the count is what R8's upgrade prompt shows the user.
 *
 * Stale rows are excluded upstream by the staleness phase, which supersedes a
 * superseded page's claims *before* this runs. Without that ordering this phase
 * reports every edit as a conflict, which is Gap #18's exact wording.
 *
 * **This is the one phase whose unit of work is not the row it marks**, and the
 * selection below is shaped by that. The other three ask the model a question
 * about one row at a time; this one asks about a SET, and a conflict lives
 * between two members of it. So the consideration stamp cannot simply subtract:
 * a batch made only of facts nobody has considered would compare each new fact
 * against other new facts and never against the brain's existing claims, which
 * is where a contradiction usually is.
 *
 * So the stamp governs **admission** rather than membership. A batch must be led
 * by facts nobody has considered — no unconsidered facts, no batch, no call,
 * which is what makes closing the run free for this phase too — and it is then
 * FILLED from already-considered facts up to the same limit, so every new claim
 * is read beside old ones. The filler is not re-stamped, because it was already
 * considered at this version and nothing about it changed.
 *
 * The coverage this gives is a strict superset of what the phase had. Before,
 * the query took the first N live facts by id on every cycle forever: fact
 * N+1 was never in a batch at all, so no pair containing it was ever compared.
 * Now every fact enters a batch exactly once, alongside the oldest live facts.
 */
export async function runContradictionPhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'contradiction';
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const version = (deps.consideration ?? CONSIDERATION_VERSION).contradiction;

  const fresh = (await deps.sql`
    SELECT fact_id::text AS fact_id, statement, origin_contexts
      FROM fact
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
       AND (contradiction_considered_version IS NULL
            OR contradiction_considered_version < ${version})
     ORDER BY fact_id
     LIMIT ${limit}
  `) as Array<{ fact_id: string; statement: string; origin_contexts: string[] }>;

  // Nothing new to say anything about. The already-considered facts have been
  // compared once at this version and comparing them again buys a second
  // identical answer at full price.
  if (fresh.length === 0) return empty(phase);

  const filler =
    fresh.length >= limit
      ? []
      : ((await deps.sql`
          SELECT fact_id::text AS fact_id, statement, origin_contexts
            FROM fact
           WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
             AND contradiction_considered_version >= ${version}
           ORDER BY fact_id
           LIMIT ${limit - fresh.length}
        `) as Array<{ fact_id: string; statement: string; origin_contexts: string[] }>);

  const facts = [...fresh, ...filler];
  // One statement contradicts nothing on its own, and asking costs a call.
  if (facts.length < 2) return empty(phase);

  const byId = new Map(facts.map((fact) => [fact.fact_id, fact]));
  const prompt = buildContradictionPrompt({
    facts: facts.map((fact) => ({
      factId: fact.fact_id,
      statement: fact.statement,
      origins: fact.origin_contexts,
    })),
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });

  const answer = await chat(deps, phase, prompt);
  if (!answer.ok) return { ...empty(phase, answer.stop), items: facts.length };

  const body = parseJsonObject(answer.text);
  const conflicts = body === null ? null : rows(body, 'conflicts');
  if (conflicts === null) return { ...empty(phase, 'bad_output'), items: facts.length, modelCalls: 1 };

  let reported = 0;
  let logged = 0;

  for (const row of conflicts) {
    const leftId = identifier(row, 'left');
    const rightId = identifier(row, 'right');
    const kind = text(row, 'kind') ?? 'value_conflict';
    const score = confidence(row);
    const left = leftId === null ? undefined : byId.get(leftId);
    const right = rightId === null ? undefined : byId.get(rightId);

    if (left === undefined || right === undefined || left === right || score === null) {
      logged += 1;
      continue;
    }
    if (kind !== 'value_conflict' && kind !== 'temporal_conflict') {
      logged += 1;
      continue;
    }
    if (gateFor(score) === 'log') {
      logged += 1;
      continue;
    }

    const origins = [...new Set([...left.origin_contexts, ...right.origin_contexts])].sort();
    await deps.sql`
      INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
      VALUES (${left.fact_id}::bigint, ${right.fact_id}::bigint, ${kind},
              ${textArrayLiteral(origins)}::text[])
      ON CONFLICT DO NOTHING
    `;
    reported += 1;
  }

  // Only the facts that led the batch. The filler carries this version already,
  // and re-stamping it would be a write that changes nothing.
  await markConsidered(deps.sql, phase, fresh.map((fact) => fact.fact_id), version);

  return {
    phase,
    items: facts.length,
    // Reports are the output of this phase; nothing was applied to a fact, and
    // counting them as `applied` would read as a mutation that did not happen.
    applied: 0,
    queued: reported,
    logged,
    skippedItems: 0,
    spentMicroUsd: answer.costMicroUsd,
    modelCalls: 1,
    stopped: null,
  };
}

// ---------------------------------------------------------------------------
// salience refinement.
// ---------------------------------------------------------------------------

/**
 * Re-score pages against a rubric the deterministic pass cannot express.
 *
 * It **overwrites** the deterministic score and records that it did
 * (`salience_source`), rather than writing to a second column: two salience
 * numbers on one page is two answers to one question, and every consumer would
 * have to choose.
 *
 * **That stamp is load-bearing in the other direction too, and it did not used
 * to be.** This phase scored the whole candidate set every cycle, so the
 * deterministic pass overwriting it first thing next cycle cost nothing — the
 * model simply scored it again. Rung 22's consideration stamp ended that: a page
 * is refined **once, ever**, so an unconditional deterministic pass erased every
 * model score within a cycle of it being paid for. `computeDeterministicSalience`
 * now skips a page stamped `model_refined`, which is what makes this phase's
 * output survive the cycle that produced it. Its header carries the measurement
 * and the cost.
 */
/**
 * Pages per salience request.
 *
 * **Its own number rather than the cycle's `limit`, because this phase's unit of
 * work is the BATCH.** Every other model phase spends `limit` on how many items
 * it will consider one at a time; here `limit` multiplied the size of a single
 * request, so a cycle that raised it to get more extraction done made this
 * phase's one prompt proportionally larger until the provider refused it. Two
 * knobs that read the same field and mean opposite things is not a knob.
 *
 * Bounded with {@link SALIENCE_PAGE_CHARS}, this is ~40KB of document per
 * request — comfortably inside every seat this op routes to, and it converges
 * across cycles rather than within one, because rung 22's consideration stamp
 * means each pass takes pages no pass has scored.
 */
const SALIENCE_REFINE_BATCH = 25;

export async function runSalienceRefinePhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'salience_refine';
  const version = (deps.consideration ?? CONSIDERATION_VERSION).salience_refine;
  const pages = await selectIngestedPages(deps.sql, {
    limit: Math.min(deps.limit ?? SALIENCE_REFINE_BATCH, SALIENCE_REFINE_BATCH),
    consideredVersion: version,
  });
  if (pages.length === 0) return empty(phase);

  const known = new Set(pages.map((page) => page.pageId));
  const prompt = buildSaliencePrompt({
    pages: pages.map((page) => ({
      pageId: page.pageId,
      title: page.title,
      text: page.text,
      origins: page.origins,
    })),
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  });

  const answer = await chat(deps, phase, prompt);
  if (!answer.ok) return { ...empty(phase, answer.stop), items: pages.length };

  const body = parseJsonObject(answer.text);
  const scores = body === null ? null : rows(body, 'scores');
  if (scores === null) return { ...empty(phase, 'bad_output'), items: pages.length, modelCalls: 1 };

  let applied = 0;
  let logged = 0;

  for (const row of scores) {
    const pageId = identifier(row, 'page_id');
    const value = row['salience'];
    if (pageId === null || !known.has(pageId) || typeof value !== 'number' || !Number.isFinite(value)) {
      logged += 1;
      continue;
    }
    const salience = Math.min(1, Math.max(0, value));
    await deps.sql`
      UPDATE page
         SET salience = ${salience}, salience_source = 'model_refined', salience_at = ${deps.now}
       WHERE page_id = ${pageId}::bigint
    `;
    applied += 1;
  }

  // Every page in the batch, scored or not. A model that returned no entry for a
  // page has still been asked about it at this version, and a marker keyed on
  // the score would keep re-sending exactly the pages it declines to score.
  await markConsidered(deps.sql, phase, pages.map((page) => page.pageId), version);

  return {
    phase,
    items: pages.length,
    applied,
    queued: 0,
    logged,
    skippedItems: 0,
    spentMicroUsd: answer.costMicroUsd,
    modelCalls: 1,
    stopped: null,
  };
}

export const MODEL_PHASE_RUNNERS: Readonly<
  Record<ModelPhase, (deps: ModelPhaseDeps) => Promise<PhaseOutcome>>
> = Object.freeze({
  // U21's, and it lives in `src/core/media/` where the plan puts it: the module
  // is about media, and the cycle is where it is scheduled. The import runs one
  // way — this file pulls the runner in, and `ocr-phase.ts` takes only types
  // back — so the graph has no cycle at runtime.
  transcribe: runTranscribePhase,
  extract: runExtractPhase,
  enrich: runEnrichPhase,
  synopsis: runSynopsisPhase,
  contradiction: runContradictionPhase,
  salience_refine: runSalienceRefinePhase,
});
