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
 * **What no phase does is mutate on the model's say-so.** ≥0.8 applies, 0.5–0.8
 * queues for a human, <0.5 is counted and dropped. The contradiction phase does
 * not even have an apply branch: R12 says handling is report-only, so the gate
 * governs *what gets written down*, and what gets written down is a report.
 */

import type { SQL } from 'bun';

import type { Budget, GatewayResult, ModelGateway } from '../../ai/gateway.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import { documentEncoding, embedTexts, vectorLiteral } from '../../core/write/embed.ts';
import { textArrayLiteral } from '../../core/write/pg-values.ts';
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
import { NO_SPEND } from './estimate.ts';
import type { ModelPhase } from './phases.ts';
import { PHASE_OP } from './phases.ts';

/**
 * Why a phase stopped short. `null` means it finished its work.
 *
 * `payload_unavailable` is U21's: the transcription phase reads bytes out of
 * object storage, and an object that is not there is neither a budget problem
 * nor a model problem. Marking the attachment done instead would retire a
 * payload nobody ever read, which is the one thing R23 promised not to do.
 */
export type PhaseStop =
  | 'budget_exhausted'
  | 'model_unavailable'
  | 'bad_output'
  | 'payload_unavailable';

export interface PhaseOutcome {
  readonly phase: ModelPhase;
  /** Candidates this phase was given. Zero means the brain had nothing to do. */
  readonly items: number;
  readonly applied: number;
  readonly queued: number;
  readonly logged: number;
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
  /** Injected in tests so a prompt is byte-comparable. Production mints one. */
  readonly nonce?: string;
}

const DEFAULT_LIMIT = 200;

function empty(phase: ModelPhase, stopped: PhaseStop | null = null): PhaseOutcome {
  return {
    phase,
    items: 0,
    applied: 0,
    queued: 0,
    logged: 0,
    spentMicroUsd: NO_SPEND,
    modelCalls: 0,
    stopped,
  };
}

/** How a gateway refusal maps onto a phase stop. Budget is its own reason. */
function stopFor(result: Extract<GatewayResult, { ok: false }>): PhaseStop {
  return result.reason === 'budget_exhausted' ? 'budget_exhausted' : 'model_unavailable';
}

interface ChatOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly costMicroUsd: number;
  readonly modelId: string;
  readonly stop: PhaseStop | null;
}

async function chat(deps: ModelPhaseDeps, phase: ModelPhase, prompt: Prompt): Promise<ChatOutcome> {
  const result = await deps.gateway.call({
    op: PHASE_OP[phase],
    tenantId: deps.tenantId,
    caller: deps.caller,
    budget: deps.budget,
    input: { kind: 'chat', system: prompt.system, user: prompt.user },
  });

  if (!result.ok) {
    return { ok: false, text: '', costMicroUsd: NO_SPEND, modelId: '', stop: stopFor(result) };
  }
  if (result.output.kind !== 'chat') {
    return { ok: false, text: '', costMicroUsd: NO_SPEND, modelId: '', stop: 'bad_output' };
  }
  return {
    ok: true,
    text: result.output.text,
    costMicroUsd: result.metering.costMicroUsd ?? 0,
    modelId: result.metering.modelId,
    stop: null,
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

    const inserted = (await deps.sql`
      INSERT INTO fact (statement, embedding, origin_contexts, page_id, confidence,
                        derivation, trust_level, run_id)
      VALUES (${statement}, ${vectorLiteral([...vector])}::vector,
              ${textArrayLiteral([...source.origins].sort())}::text[],
              ${source.pageId}::bigint, ${score}, ${MODEL_DERIVED}, 'model_extracted',
              ${deps.runId}::bigint)
      RETURNING fact_id::text AS fact_id
    `) as Array<{ fact_id: string }>;
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
  const pages = await selectIngestedPages(deps.sql, { limit: deps.limit ?? 25 });
  if (pages.length === 0) return empty(phase);

  let applied = 0;
  let logged = 0;
  let calls = 0;

  for (const page of pages) {
    const prompt = buildSynopsisPrompt({
      title: page.title,
      text: page.text,
      origins: page.origins,
      ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
    });
    const answer = await chat(deps, phase, prompt);
    if (!answer.ok) {
      return {
        phase,
        items: pages.length,
        applied,
        queued: 0,
        logged,
        spentMicroUsd: deps.budget.spentMicroUsd(),
        modelCalls: calls,
        stopped: answer.stop,
      };
    }
    calls += 1;

    const body = parseJsonObject(answer.text);
    const summary = body === null ? null : text(body, 'summary');
    if (summary === null) {
      return {
        phase,
        items: pages.length,
        applied,
        queued: 0,
        logged,
        spentMicroUsd: deps.budget.spentMicroUsd(),
        modelCalls: calls,
        stopped: 'bad_output',
      };
    }

    await writeCanonicalSummary(deps.sql, {
      sourcePageId: page.pageId,
      title: page.title,
      summary,
      origins: page.origins,
      sources: [{ sourceType: page.sourceType, externalRef: page.externalRef }],
      runId: deps.runId,
    });
    applied += 1;
  }

  return {
    phase,
    items: pages.length,
    applied,
    queued: 0,
    logged,
    spentMicroUsd: deps.budget.spentMicroUsd(),
    modelCalls: calls,
    stopped: null,
  };
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
    spentMicroUsd: answer.costMicroUsd,
    modelCalls: 1,
    stopped: null,
  };
}

export const MODEL_PHASE_RUNNERS: Readonly<
  Record<ModelPhase, (deps: ModelPhaseDeps) => Promise<PhaseOutcome>>
> = Object.freeze({
  extract: runExtractPhase,
  enrich: runEnrichPhase,
  synopsis: runSynopsisPhase,
  contradiction: runContradictionPhase,
  salience_refine: runSalienceRefinePhase,
});
