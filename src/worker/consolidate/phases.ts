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
