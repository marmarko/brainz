/**
 * The cycle's order, as data.
 *
 * U11's first approach step is an ordering — cheap→expensive, with the free tier
 * stopping at the boundary — and the reason it is a table here rather than the
 * sequence of statements inside `cycle.ts` is that the ordering degrades
 * *silently* in one direction. Move a model phase ahead of a deterministic one
 * and nothing errors: a truncated cycle still reports `dreamt: false`, still
 * checkpoints, still resumes. It has simply spent money before doing the work
 * that costs nothing, and a free-tier brain gets less of what it was promised.
 * {@link findPhaseOrderViolations} is what refuses that, and `cycle.ts` runs it
 * at construction.
 *
 * **The free-tier line is not a third list.** R8 defines the free tier as the
 * deterministic phases, so {@link FREE_TIER_PHASES} *is*
 * {@link DETERMINISTIC_PHASES}. A separate constant would be a second place to
 * state one fact, and the day they disagreed the free tier would either pay for
 * a model call or lose a phase it was owed.
 *
 * **Each model phase names an op, never a model** (KTD13). Retuning a phase is a
 * row in `src/ai/routing.ts`; nothing here knows which vendor answers.
 *
 * **On the order within the deterministic tier.** It is the plan's, verbatim:
 * dedup, link reconciliation, staleness marking, rule-based entity merge,
 * deterministic salience, embedding-space clustering. One consequence is worth
 * writing down rather than discovering: reconciliation reads the *live* fact set
 * and staleness *changes* it, so a fact invalidated by staleness leaves its edge
 * standing until something reconciles again. `deterministic.ts` closes that
 * inside the staleness phase — a fix-point re-reconcile when, and only when,
 * staleness invalidated something — rather than by reordering the plan's phases.
 */

import type { GatewayResult } from '../../ai/gateway.ts';
import type { ModelOp } from '../../ai/routing.ts';

/** The free half. Every one of these is countable SQL and shared write-path code. */
export const DETERMINISTIC_PHASES = [
  'dedup',
  'link_reconcile',
  'staleness',
  'entity_merge',
  'salience',
  'cluster',
] as const;

export type DeterministicPhase = (typeof DETERMINISTIC_PHASES)[number];

/**
 * The metered half: transcribe, then the plan's order — extract, enrich, wrap,
 * report, refine.
 *
 * **`transcribe` is first, and its position is an argument rather than a
 * preference.** U21 adds it to this tier (its output is a model call, so it
 * belongs where calls are batched, budgeted and checkpointed), and two things
 * put it at the head: it is the cheapest seat in KTD13's table per item, which
 * is the same cheap→expensive rule the tier boundary follows; and it *creates*
 * what the phases after it read. A screenshot transcribed after extraction has
 * run is a screenshot whose text no phase sees until the next cycle.
 */
export const MODEL_PHASES = [
  'transcribe',
  'extract',
  'enrich',
  'synopsis',
  'contradiction',
  'salience_refine',
] as const;

export type ModelPhase = (typeof MODEL_PHASES)[number];

export type CyclePhase = DeterministicPhase | ModelPhase;

export const CYCLE_PHASES: readonly CyclePhase[] = [...DETERMINISTIC_PHASES, ...MODEL_PHASES];

/**
 * R8's line. The same list as {@link DETERMINISTIC_PHASES}, deliberately aliased
 * rather than copied — see the header.
 */
export const FREE_TIER_PHASES: readonly CyclePhase[] = DETERMINISTIC_PHASES;

/**
 * Why a phase stopped short. `null` means it finished its work.
 *
 * **It lives here, beside the phase names, because the two are one vocabulary.**
 * A run record that says which phase stopped the cycle has to say what it
 * stopped with, and both halves are persisted against a CHECK in rung 20 — so
 * the alphabet the database accepts is this array, and `test/consolidate/
 * schema.test.ts` is what holds the two in agreement. Declared as data rather
 * than only as a type for the same reason `CYCLE_PHASES` is: a union type cannot
 * be enumerated at runtime, and a check that cannot be enumerated is a check
 * written out by hand somewhere else.
 *
 * `payload_unavailable` is U21's: the transcription phase reads bytes out of
 * object storage, and an object that is not there is neither a budget problem
 * nor a model problem. Marking the attachment done instead would retire a
 * payload nobody ever read, which is the one thing R23 promised not to do.
 *
 * `out_of_time` is not a failure. The attempt's wall clock ran out (or its lease
 * was lost) part way through a phase that calls the model **once per item**; the
 * items already applied are applied, and the cycle re-reads the precise reason
 * off the budget so `cancelled` and `out_of_time` stay distinguishable on the
 * run record.
 *
 * A phase stopping that way banks **no checkpoint**, on purpose — the previous
 * fleet version reads any checkpoint row as a completion. Its progress is
 * durable in the content instead, which is why `selectIngestedPages` grew an
 * already-summarised predicate: the next attempt simply does not select what
 * this one finished.
 *
 * `input_rejected` is the provider refusing the **request** rather than the
 * connection: a 400/413/422-class status, which says the thing we sent is not
 * something it will accept while it stays the same. It was `model_unavailable`
 * until rung 21, and collapsing the two cost more than a misleading word: they
 * want opposite responses — `model_unavailable` means wait, `input_rejected`
 * means the payload has to get smaller or the seat wider.
 *
 * **It is also the line a per-item phase stops on.** `runSynopsisPhase` sends
 * one page per request, so a durable refusal is a fact about that page and is
 * skipped, while anything not durable is a fact about the provider, the
 * credential or the configuration and would meet every remaining page
 * identically — so that one stops the phase, at the first answer, without
 * counting. 429, 408, every 5xx and a status-less network failure stay
 * `model_unavailable`: those are the provider having a bad minute, and no page
 * is answerable for one.
 *
 * Nothing is retired on either code. An earlier design let two durable refusals
 * set `page.quarantined_at`, which every read in the system honours — so a page
 * the summariser could not parse would have left search, the briefing and the
 * user's own self-export. These codes inform the diagnosis and never a deletion.
 *
 * **`cancelled` is deliberately not a member.** A lost lease is something the
 * *run* suffered, not something a phase reported, and admitting it here would
 * make the column mean two things at once.
 */
export const PHASE_STOPS = [
  'budget_exhausted',
  'model_unavailable',
  'input_rejected',
  'bad_output',
  'payload_unavailable',
  'out_of_time',
] as const;

export type PhaseStop = (typeof PHASE_STOPS)[number];

/**
 * Which phase a cycle stopped in, and the code it stopped with.
 *
 * `null` where a cycle stopped for a reason no phase is answerable for — the
 * clock read *between* two phases, a lease lost, or a cycle that simply
 * finished. A pair invented for those cases would name a phase that did nothing
 * wrong, which is worse than the aggregate reason it was meant to improve on.
 */
export interface PhaseAttribution {
  readonly phase: CyclePhase;
  readonly code: PhaseStop;
}

export type PhaseTier = 'deterministic' | 'model';

const MODEL_PHASE_SET = new Set<string>(MODEL_PHASES);

export function isModelPhase(phase: CyclePhase): phase is ModelPhase {
  return MODEL_PHASE_SET.has(phase);
}

export const TIER_OF: Readonly<Record<CyclePhase, PhaseTier>> = Object.freeze(
  Object.fromEntries(
    CYCLE_PHASES.map((phase) => [phase, isModelPhase(phase) ? 'model' : 'deterministic']),
  ) as Record<CyclePhase, PhaseTier>,
);

/**
 * KTD13's table, keyed by phase.
 *
 * `salience_refine` routes through the `salience` op: the op names what the
 * model is being asked to do, and the phase names when in the cycle it happens.
 * Collapsing the two would mean either a phase called `salience` that collides
 * with the deterministic one, or an op nobody grades.
 */
export const PHASE_OP: Readonly<Record<ModelPhase, ModelOp>> = Object.freeze({
  // KTD13's "Image / PDF → text" row. The plan's prose calls the op
  // `image_to_text`; the table — which KTD13 says is the source of truth, not
  // the prose — files it as `vision`, and a tenth op would be a second name for
  // one row.
  transcribe: 'vision',
  extract: 'extract',
  enrich: 'enrich',
  synopsis: 'synopsis',
  contradiction: 'contradiction',
  salience_refine: 'salience',
});

/**
 * Every way an order is not a cycle order.
 *
 * Returned as findings rather than thrown, so a caller validating a
 * configuration can report all of them at once — and so the check can be handed
 * a deliberately broken order and watched to go red, which is the only way to
 * know it works.
 */
export function findPhaseOrderViolations(order: readonly CyclePhase[]): string[] {
  const findings: string[] = [];
  const seen = new Set<CyclePhase>();

  for (const phase of order) {
    if (seen.has(phase)) {
      findings.push(
        `'${phase}' appears more than once — a checkpoint is keyed on the phase, so a repeat makes "where is this brain up to" ambiguous`,
      );
      continue;
    }
    seen.add(phase);
  }

  for (const phase of CYCLE_PHASES) {
    if (!seen.has(phase)) {
      findings.push(`'${phase}' is missing — a cycle that skips a phase is a cycle nobody declared`);
    }
  }

  let firstModelAt: number | null = null;
  order.forEach((phase, index) => {
    if (isModelPhase(phase)) {
      if (firstModelAt === null) firstModelAt = index;
      return;
    }
    if (firstModelAt !== null) {
      findings.push(
        `'${order[firstModelAt] as string}' is a model phase and runs before the deterministic phase '${phase}' — ` +
          'budget truncation would then stop the cycle before the free work was done, which is the whole reason the order exists',
      );
    }
  });

  return findings;
}

export function assertPhaseOrder(order: readonly CyclePhase[] = CYCLE_PHASES): void {
  const findings = findPhaseOrderViolations(order);
  if (findings.length > 0) {
    throw new Error(`the consolidation cycle's phase order is not runnable:\n  ${findings.join('\n  ')}`);
  }
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
 *     pace, and a request timeout is work that started. Charging either to a
 *     page would let one busy hour blame a shelf of perfectly good documents.
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
export const DURABLE_PROVIDER_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * A phase stop, and whether the request itself is what was refused.
 *
 * `durable` is the fact `stopFor` used to throw away, and it is what a per-item
 * loop needs in order to know **whose** failure it is holding: a durable refusal
 * is the provider's verdict on this one request, and everything else is the
 * provider, the credential or the configuration, which the next item will meet
 * identically. That is the whole of the stop/skip decision in
 * {@link runSynopsisPhase} — no counting, because a fact that is true of every
 * remaining item is already complete at the first one.
 */
export interface PhaseFailure {
  readonly stop: PhaseStop;
  /**
   * True only when re-sending the same input would be refused the same way.
   *
   * Fail-closed, and the two mistakes are priced very differently. Calling a
   * durable refusal transient stops a phase that could have skipped one page and
   * kept going — recoverable, loud, and on the run record. Calling a transient
   * durable makes an outage read as a per-item outcome, so the phase would walk
   * a whole candidate set into a dead provider, complete, close the run and bank
   * a checkpoint saying it was paid for.
   */
  readonly durable: boolean;
}

/** How a gateway refusal maps onto a phase stop. Budget is its own reason. */
export function stopFor(result: Extract<GatewayResult, { ok: false }>): PhaseFailure {
  if (result.reason === 'budget_exhausted') return { stop: 'budget_exhausted', durable: false };
  if (result.reason === 'transport_failed' && result.providerStatus !== null) {
    if (DURABLE_PROVIDER_STATUSES.has(result.providerStatus)) {
      return { stop: 'input_rejected', durable: true };
    }
  }
  // Everything else: a provider that was down, a network that dropped, a key
  // that would not resolve, a scope that was denied, a model nobody priced. Each
  // has a remedy, none of them is the page's, and every one of them would meet
  // the next page in exactly the same way — which is what makes them the phase's
  // failure rather than an item's.
  return { stop: 'model_unavailable', durable: false };
}
