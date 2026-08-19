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
 * **A per-item failure is the item's until three in a row say otherwise.** The
 * three properties above were written for the phases that call the model once
 * for a whole batch, where "this answer failed" and "this phase failed" are the
 * same sentence. `synopsis` calls it once per *page*, and there the two come
 * apart: a page the model cannot summarise is one page's problem, and returning
 * on it — which is what this file used to do — stopped the cycle, which left the
 * run open, which left `extract`'s checkpoint standing, which skipped extraction
 * on every resume. One unusable page out of 5,608 pinned a brain at 167 facts.
 *
 * So a per-item loop skips the item and keeps going, bounded by
 * {@link CONSECUTIVE_ITEM_FAILURE_LIMIT}: a run of failures that long is not an
 * item any more, it is the provider or the prompt, and continuing would buy two
 * hundred sequential calls to discover what the first three already said. The
 * bound is on *consecutive* failures rather than total, because a total would
 * make a brain with four scattered unusable pages permanently unable to get past
 * the fourth. `budget_exhausted` and `out_of_time` are exempt and stop at once —
 * neither is anything the item did. And a phase that applied nothing while
 * failing at something reports the failure regardless of the bound, or property
 * 1 would be repealed by the tolerance rather than bounded by it.
 *
 * **The skip alone only defers that freeze, so a page can also leave.** A
 * skipped page writes nothing, and `selectIngestedPages(unsummarised)` excludes
 * a page only once a summary exists for it — so every usable page leaves the
 * candidate set and every unusable one stays. The set converges monotonically
 * onto the unusable pages, the ordering key is fixed so they end up adjacent at
 * its head, and the consecutive bound then trips on calls one to three of every
 * cycle with nothing applied. That terminal state is byte-identical to the
 * freeze the skip was written to fix.
 *
 * The link that has to break is the candidate set itself, and
 * {@link QUARANTINE_AFTER_REFUSALS} is the bar a page clears to leave it. **The
 * hazard is the whole difficulty**: quarantining on a TRANSIENT failure drops a
 * good page from consolidation silently and forever, which is worse than the
 * freeze precisely because the freeze is loud. So two things guard it, and
 * neither is sufficient alone — {@link stopFor} keeps the provider's status
 * instead of collapsing every failure into `model_unavailable`, so only a
 * refusal of the *request* counts at all; and a refusal counts as evidence
 * rather than as a verdict, because one phase run offers a page to the model
 * once and the threshold is more than one.
 *
 * **What no phase does is mutate on the model's say-so.** ≥0.8 applies, 0.5–0.8
 * queues for a human, <0.5 is counted and dropped. The contradiction phase does
 * not even have an apply branch: R12 says handling is report-only, so the gate
 * governs *what gets written down*, and what gets written down is a report.
 */

import type { SQL } from 'bun';

import type { Budget, GatewayResult, ModelGateway } from '../../ai/gateway.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import type { StoredPayloadReader } from '../../core/media/accept.ts';
import { runTranscribePhase } from '../../core/media/ocr-phase.ts';
import { embeddingSeatFor } from '../../ai/routing.ts';
import { documentEncoding, embedTexts, vectorLiteral } from '../../core/write/embed.ts';
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
import { unboundedAttempt, type AttemptBudget } from './deadline.ts';
import { NO_SPEND } from './estimate.ts';
import type { ModelPhase, PhaseStop } from './phases.ts';
import { PHASE_OP } from './phases.ts';

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
   * Items this phase retired from its own candidate set, a subset of `logged`.
   *
   * Non-zero only on a per-item phase that can prove an item is unusable — see
   * {@link QUARANTINE_AFTER_REFUSALS}. It is counted separately from `logged`
   * because the two mean opposite things to whoever reads them: `logged` is
   * work the brain will try again, and this is work it has decided to stop
   * trying. A number that never appears anywhere would make removing a user's
   * page the quietest thing this file does.
   */
  readonly quarantined: number;
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
   * U21's transcription phase reads the stored payload back through this port.
   * Absent for a fleet with no object store wired: the phase then finds work it
   * cannot do and says so, rather than reporting a brain with nothing to read.
   */
  readonly payloads?: StoredPayloadReader;
}

const DEFAULT_LIMIT = 200;

/**
 * How many items in a row may fail before a per-item phase stops trying.
 *
 * The number that separates "this page" from "this provider". A broken provider
 * or a broken prompt fails the very next call too, so three is enough to tell
 * them apart; an unusable page is surrounded by usable ones, so three is more
 * than enough not to be tripped by one. It is the ceiling on what tolerance
 * costs — at most this many wasted calls per phase per cycle — and it is
 * deliberately small, because the thing being bought is the ability to get past
 * one page, not the ability to grind through an outage.
 */
export const CONSECUTIVE_ITEM_FAILURE_LIMIT = 3;

/**
 * How many DURABLE refusals a page must collect before it leaves the candidate
 * set for good.
 *
 * **Two, and the second one is what the number is for.** A phase run offers a
 * given page to the model at most once, so a second strike is necessarily a
 * second cycle — a separate attempt, a separate completion, and for the parse
 * case a separately sampled answer. One durable refusal is a fact about one
 * exchange; two is a fact about the page.
 *
 * Not one, because the cheapest way to be wrong here is to believe a single
 * answer. Not three, because each extra strike is another whole cycle in which
 * the phase spends a call on a page it will not use, and every cycle before the
 * last one is a cycle where the unreadable pages are still adjacent at the head
 * of the ordering and still tripping {@link CONSECUTIVE_ITEM_FAILURE_LIMIT} —
 * which is the freeze, arriving later.
 */
export const QUARANTINE_AFTER_REFUSALS = 2;

/** Where a quarantine decision is recorded. A code from `PHASE_STOPS`, never a sentence. */
type QuarantineReason = Extract<PhaseStop, 'input_rejected' | 'bad_output'>;

function empty(phase: ModelPhase, stopped: PhaseStop | null = null): PhaseOutcome {
  return {
    phase,
    items: 0,
    applied: 0,
    queued: 0,
    logged: 0,
    quarantined: 0,
    spentMicroUsd: NO_SPEND,
    modelCalls: 0,
    stopped,
  };
}

/**
 * The provider statuses that mean "this request, not this moment".
 *
 * 400 malformed, 413 too large, 422 unprocessable: three ways of saying the
 * thing we sent is not something this model will accept, and sending it again
 * gets the same answer for as long as the request is the same. Every other
 * status is deliberately absent, and two absences are worth naming because they
 * are the ones a wider rule would have swept in:
 *
 *   * **429 and 408** are 4xx and are not durable. A rate limit is the fleet's
 *     pace, and a request timeout is work that started. Quarantining on either
 *     would let one busy hour retire a shelf of perfectly good pages.
 *   * **401/403** say the credential is wrong, which is a configuration remedy.
 *     The page is blameless and every page would fail identically.
 *
 * The gateway keeps this number and nothing else — deliberately, so a provider
 * that echoes the request in its error body cannot write the user's words into
 * a log — which is exactly why the number has to be carried rather than
 * collapsed here. `control.connector_health` learned the same lesson: the
 * provider's status beside the failure code named a ten-hour outage's cause in
 * one cycle, after months of an undifferentiated `provider_error`.
 */
const DURABLE_PROVIDER_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * A phase stop, and whether the request itself is what was refused.
 *
 * `durable` is the fact `stopFor` used to throw away, and it is the only thing
 * that separates "the provider was rate-limiting us, wait" from "this page will
 * never parse". Nothing may retire a page without it.
 */
interface PhaseFailure {
  readonly stop: PhaseStop;
  /**
   * True only when re-sending the same input would be refused the same way.
   *
   * Fail-closed: everything this function cannot positively prove durable is
   * transient, because the cost of the two mistakes is not symmetric. Treating
   * a durable refusal as transient costs one wasted model call per cycle and is
   * visible in the run record; treating a transient as durable retires a page
   * the user can no longer find, and nothing says so.
   */
  readonly durable: boolean;
}

/** How a gateway refusal maps onto a phase stop. Budget is its own reason. */
function stopFor(result: Extract<GatewayResult, { ok: false }>): PhaseFailure {
  if (result.reason === 'budget_exhausted') return { stop: 'budget_exhausted', durable: false };
  if (result.reason === 'transport_failed' && result.providerStatus !== null) {
    if (DURABLE_PROVIDER_STATUSES.has(result.providerStatus)) {
      return { stop: 'input_rejected', durable: true };
    }
  }
  // Everything else: a provider that was down, a network that dropped, a key
  // that would not resolve, a seat whose output ceiling is too tight. Each has
  // a remedy and none of them is the page's.
  return { stop: 'model_unavailable', durable: false };
}

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
  // wrong seat. Never durable: the page is not what is wrong, and a routing bug
  // would otherwise retire every page it touched.
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
  const candidates = await selectExtractionCandidates(deps.sql, {
    limit: deps.limit ?? DEFAULT_LIMIT,
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
    const chunkId = text(row, 'chunk_id');
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
        // A whole-batch phase never retires an item: the request it sent was a
        // batch, so a refusal indicts the batch and not any page inside it.
        quarantined: 0,
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

  // The embedding calls settle against the same budget, so the phase's spend is
  // what the budget says rather than what the chat call alone cost.
  spent = deps.budget.spentMicroUsd();
  return {
    phase,
    items: candidates.length,
    applied,
    queued,
    logged,
    quarantined: 0,
    spentMicroUsd: spent,
    modelCalls: 1,
    stopped: null,
  };
}

// ---------------------------------------------------------------------------
// enrich.
// ---------------------------------------------------------------------------

export async function runEnrichPhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'enrich';
  const limit = deps.limit ?? DEFAULT_LIMIT;

  const entities = (await deps.sql`
    SELECT e.entity_id::text AS entity_id, e.canonical_name, e.entity_type, e.origin_contexts,
           coalesce(
             (SELECT array_agg(f.statement ORDER BY f.fact_id)
                FROM fact f
               WHERE f.deleted_at IS NULL AND f.quarantined_at IS NULL AND f.superseded_by IS NULL
                 AND f.statement ILIKE '%' || e.canonical_name || '%'),
             ARRAY[]::text[]
           ) AS evidence
      FROM entity e
     WHERE e.deleted_at IS NULL
     ORDER BY e.entity_id
     LIMIT ${limit}
  `) as Array<{
    entity_id: string;
    canonical_name: string;
    entity_type: string;
    origin_contexts: string[];
    evidence: string[];
  }>;

  if (entities.length === 0) return empty(phase);

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

    await writeEntityCard(deps.sql, {
      entityId: entity.entity_id,
      summary,
      confidence: score,
      modelId: answer.modelId,
      runId: deps.runId,
      evidenceOrigins: entity.origin_contexts,
    });
    applied += 1;
  }

  return {
    phase,
    items: entities.length,
    applied,
    queued,
    logged,
    quarantined: 0,
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
  let quarantined = 0;
  /**
   * Failures since the last page the model answered readably.
   *
   * Reset on the parse, not on the write: a summary the seam then refuses is the
   * model working and this code declining the result, which says nothing about
   * whether the provider is up.
   */
  let consecutiveFailures = 0;
  /** The code the last failure reported, for the two stops that report one. */
  let lastFailure: PhaseStop | null = null;

  const outcome = (stopped: PhaseStop | null): PhaseOutcome => ({
    phase,
    items: pages.length,
    applied,
    queued: 0,
    logged,
    quarantined,
    spentMicroUsd: deps.budget.spentMicroUsd(),
    modelCalls: calls,
    stopped,
  });

  /**
   * Record one durable refusal against a page, and retire it if it has now
   * earned that.
   *
   * **Called for a durable refusal and nothing else.** A transient leaves this
   * untouched — no counter moves, no row is written — so an outage of any
   * length quarantines exactly zero pages however many times it recurs in one
   * pass. That asymmetry is the point of the whole rung: the freeze this fixes
   * is loud, and a page wrongly retired is silent, so the two mistakes are not
   * priced the same and the code is not allowed to treat them as if they were.
   */
  const strike = async (pageId: string, reason: QuarantineReason): Promise<void> => {
    // One statement, and the threshold is evaluated by the database against the
    // stored count rather than against anything this process remembers. A read
    // followed by a write would let two attempts of the same run race to the
    // same strike, and the losing one would be a refusal nobody counted.
    const rows = (await deps.sql`
      UPDATE page
         SET consolidation_refusals = consolidation_refusals + 1,
             quarantined_at = CASE
               WHEN consolidation_refusals + 1 >= ${QUARANTINE_AFTER_REFUSALS} THEN ${deps.now}
               ELSE quarantined_at
             END,
             quarantine_reason = CASE
               WHEN consolidation_refusals + 1 >= ${QUARANTINE_AFTER_REFUSALS} THEN ${reason}
               ELSE quarantine_reason
             END,
             updated_at = ${deps.now}
       WHERE page_id = ${pageId}::bigint AND quarantined_at IS NULL
      RETURNING (quarantined_at IS NOT NULL) AS retired
    `) as Array<{ retired: boolean }>;
    if (rows[0]?.retired === true) quarantined += 1;
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
      // burning two more calls to rediscover it would be spending money the
      // budget has already refused.
      if (answer.stop === 'budget_exhausted') return outcome('budget_exhausted');
      // `input_rejected` and nothing else: the provider read the request and
      // refused it, which is a fact about this page. A 429 or a 503 arrives here
      // as `model_unavailable` with `durable: false` and costs the page nothing.
      if (answer.durable) await strike(page.pageId, 'input_rejected');
      logged += 1;
      consecutiveFailures += 1;
      lastFailure = answer.stop;
      if (consecutiveFailures >= CONSECUTIVE_ITEM_FAILURE_LIMIT) return outcome(answer.stop);
      continue;
    }
    calls += 1;

    const body = parseJsonObject(answer.text);
    const summary = body === null ? null : text(body, 'summary');
    if (summary === null) {
      // **The other durable refusal, and the one that needs the threshold most.**
      // The provider was reachable, billed us, and produced something this code
      // cannot read — which for a page whose size or shape defeats the model is
      // permanent, and for a model that sampled badly once is not. Nothing here
      // can tell those apart in one exchange, so neither is decided in one: the
      // strike is recorded and {@link QUARANTINE_AFTER_REFUSALS} makes the page
      // prove it across independent cycles before it leaves the set.
      await strike(page.pageId, 'bad_output');
      logged += 1;
      consecutiveFailures += 1;
      lastFailure = 'bad_output';
      if (consecutiveFailures >= CONSECUTIVE_ITEM_FAILURE_LIMIT) return outcome('bad_output');
      continue;
    }
    consecutiveFailures = 0;

    const written = await writeCanonicalSummary(deps.sql, {
      sourcePageId: page.pageId,
      title: page.title,
      summary,
      origins: page.origins,
      sources: [{ sourceType: page.sourceType, externalRef: page.externalRef }],
      runId: deps.runId,
    });
    // A synthesis whose inputs span more than one origin has no honest scalar to
    // be filed under, and the seam refuses it. Counted as `logged` rather than
    // `applied`: the page was seen and the model was paid for, and nothing was
    // written. Unreachable from here today — `selectIngestedPages` derives
    // `origins` from a page's own scalar column — and read rather than ignored,
    // because a caller that discarded the outcome is how the seam's refusal
    // would come to mean nothing the day a phase summarises across pages.
    if (!written.ok) {
      logged += 1;
      continue;
    }
    applied += 1;
  }

  // **A phase that wrote nothing while failing at something has not succeeded**,
  // however few pages it was given. Returning `null` here would bank a
  // checkpoint saying `synopsis` is paid for and put a cycle that summarised
  // nothing on the run record as `complete` — indistinguishable from a brain
  // with nothing left to summarise, which is the exact reading the "a refusal is
  // carried out, never swallowed" rule exists to refuse. The consecutive bound
  // catches this on a large brain; on a small one there are not three pages to
  // fail, and this is what catches it.
  return outcome(applied === 0 && lastFailure !== null ? lastFailure : null);
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
 */
export async function runContradictionPhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'contradiction';

  const facts = (await deps.sql`
    SELECT fact_id::text AS fact_id, statement, origin_contexts
      FROM fact
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
     ORDER BY fact_id
     LIMIT ${deps.limit ?? DEFAULT_LIMIT}
  `) as Array<{ fact_id: string; statement: string; origin_contexts: string[] }>;

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
    const leftId = text(row, 'left');
    const rightId = text(row, 'right');
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

  return {
    phase,
    items: facts.length,
    // Reports are the output of this phase; nothing was applied to a fact, and
    // counting them as `applied` would read as a mutation that did not happen.
    applied: 0,
    queued: reported,
    logged,
    quarantined: 0,
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
 * have to choose. The deterministic pass runs first in every cycle, so the
 * previous value is one phase old rather than lost.
 */
export async function runSalienceRefinePhase(deps: ModelPhaseDeps): Promise<PhaseOutcome> {
  const phase: ModelPhase = 'salience_refine';
  const pages = await selectIngestedPages(deps.sql, { limit: deps.limit ?? 50 });
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
    const pageId = text(row, 'page_id');
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

  return {
    phase,
    items: pages.length,
    applied,
    queued: 0,
    logged,
    quarantined: 0,
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
