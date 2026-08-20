/**
 * What a cycle will cost, before it costs it — and the per-phase caps derived
 * from that number.
 *
 * U11: "Per-phase budget caps; estimate before run ... the caps are computed
 * from the canonical pricing table rather than guessed." Both halves are here,
 * and both are arithmetic over `src/ai/pricing.ts` rather than constants: this
 * module contains no number that is money, which is what keeps
 * `test/ai/price-drift.test.ts` honest about there being one pricing table.
 *
 * **The projection is deliberately pessimistic on output.** A phase's input
 * tokens can be counted; its output tokens cannot, so the estimate uses the
 * route's own `maxOutputTokens` ceiling — the same direction `gateway.ts` takes
 * for the same reason. An estimate that assumed a short answer would produce a
 * cap that fires after the money is gone, which is a cap in name only.
 *
 * **An unpriced model is a hard failure here, not a zero.** R14's rule is that a
 * model absent from the pricing table hard-fails when a cap is set, and a cap is
 * exactly what this module exists to produce. Estimating such a phase at zero
 * would hand it an unlimited budget wearing a cap's clothes.
 */

import type { SQL } from 'bun';

import { createBudget, type Budget } from '../../ai/gateway.ts';
import { CANONICAL_PRICE_BOOK, costMicroUsd, type PriceBook } from '../../ai/pricing.ts';
import { IMAGE_INPUT_TOKENS, routeFor, type NamedProfile } from '../../ai/routing.ts';
import { CONSIDERATION_VERSION, type ConsiderationVersions } from './consideration.ts';
import { MODEL_PHASES, PHASE_OP, type ModelPhase } from './phases.ts';

/** How much work a phase has, and how big one unit of it is. */
export interface PhaseWorkload {
  readonly items: number;
  /** Input tokens one item contributes. Rough by design — see the header. */
  readonly inputTokensPerItem: number;
}

export type CycleWorkload = Readonly<Partial<Record<ModelPhase, PhaseWorkload>>>;

export const EMPTY_WORKLOAD: PhaseWorkload = Object.freeze({ items: 0, inputTokensPerItem: 0 });

/**
 * Zero money, named.
 *
 * `spentMicroUsd: 0` reads to `test/ai/price-drift.test.ts` as a price written
 * down outside the canonical table, and the guard is blunt on purpose — its
 * whole job is that a number must never appear next to a money word anywhere
 * but `src/ai/pricing.ts`. `src/core/write/links.ts` hoisted a constant for the
 * same reason and said so; this is the same move, and it costs one identifier
 * to keep the scanner able to fire on the thing it is actually watching for.
 */
export const NO_SPEND = 0;

export class UnpricedPhaseError extends Error {
  readonly phase: ModelPhase;
  readonly modelId: string;

  constructor(phase: ModelPhase, modelId: string) {
    super(
      `phase '${phase}' routes to '${modelId}', which the canonical pricing table does not price. ` +
        'A per-phase cap over a cost nobody can compute is not a cap (R14), and the first place that shows up is an invoice.',
    );
    this.name = 'UnpricedPhaseError';
    this.phase = phase;
    this.modelId = modelId;
  }
}

export interface CycleEstimate {
  readonly perPhase: Readonly<Record<ModelPhase, number>>;
  readonly modelIds: Readonly<Record<ModelPhase, string>>;
  readonly totalMicroUsd: number;
  readonly profile: string;
}

export function estimateCycle(input: {
  readonly profile: NamedProfile;
  readonly workload: CycleWorkload;
  readonly priceBook?: PriceBook;
}): CycleEstimate {
  const priceBook = input.priceBook ?? CANONICAL_PRICE_BOOK;
  const perPhase = {} as Record<ModelPhase, number>;
  const modelIds = {} as Record<ModelPhase, string>;
  let total = 0;

  for (const phase of MODEL_PHASES) {
    const route = routeFor(input.profile, PHASE_OP[phase]);
    const price = priceBook.lookup(route.id);
    if (price === undefined) throw new UnpricedPhaseError(phase, route.id);

    const work = input.workload[phase] ?? EMPTY_WORKLOAD;
    const cost = costMicroUsd(
      {
        inputTokens: work.items * work.inputTokensPerItem,
        outputTokens: work.items * route.maxOutputTokens,
      },
      price,
    );
    perPhase[phase] = cost;
    modelIds[phase] = route.id;
    total += cost;
  }

  return { perPhase, modelIds, totalMicroUsd: total, profile: input.profile.name };
}

export interface BudgetOptions {
  /**
   * A ceiling on the whole cycle. When present, each phase's cap is its share of
   * it — so a tenant near its rolling spend limit degrades by tier rather than
   * by whichever phase happened to run first.
   */
  readonly capMicroUsd?: number | null;
  /** Multiplier on the estimate when no cycle cap is given. 1 is the estimate. */
  readonly headroom?: number;
}

/**
 * One budget object per phase, so a phase cannot spend another's cap.
 *
 * They are separate objects rather than one budget consulted five times, and
 * that is the point of the whole exercise: a shared budget makes "the extraction
 * phase overran" and "the contradiction phase was starved" the same event.
 */
export function budgetsFor(
  estimate: CycleEstimate,
  options: BudgetOptions = {},
): Readonly<Record<ModelPhase, Budget>> {
  const cap = options.capMicroUsd;
  const headroom = options.headroom ?? 1;

  const budgets = {} as Record<ModelPhase, Budget>;
  for (const phase of MODEL_PHASES) {
    const estimated = estimate.perPhase[phase];
    let phaseCap: number;
    if (cap === null || cap === undefined) {
      phaseCap = Math.ceil(estimated * headroom);
    } else if (cap <= 0 || estimate.totalMicroUsd === 0) {
      // Zero is the free tier, exactly: a cap of zero refuses every priced call
      // rather than admitting a free one.
      phaseCap = 0;
    } else {
      // Floor rather than round: the shares must sum to no more than the cycle
      // cap, and a rounded share can push the total over it.
      phaseCap = Math.min(estimated, Math.floor((estimated * cap) / estimate.totalMicroUsd));
    }
    budgets[phase] = createBudget({ label: `consolidate.${phase}`, capMicroUsd: phaseCap });
  }
  return budgets;
}

// ---------------------------------------------------------------------------
// What the brain actually has to work on.
// ---------------------------------------------------------------------------

/**
 * Average input size per item, per phase, in tokens.
 *
 * Not measured per run: the estimate exists to make a cap fire early, and
 * counting the exact characters of every candidate before deciding whether to
 * afford them is a read of the whole corpus to save a fraction of a cent. These
 * are the shapes each phase actually sends — a chunk, an entity's evidence, a
 * page's chunk list, a fact pair, a page's chunks — rounded up.
 */
const TOKENS_PER_ITEM: Readonly<Record<ModelPhase, number>> = Object.freeze({
  // An image is a short prompt and a large picture, and the picture is the whole
  // of it. `IMAGE_INPUT_TOKENS` is the one place that figure lives, so the cap
  // this module computes and the reservation `gateway.ts` takes cannot disagree
  // — and they must not, because a phase budgeted below what its first call
  // reserves stops before it starts.
  transcribe: IMAGE_INPUT_TOKENS + 100,
  extract: 500,
  enrich: 1_000,
  synopsis: 500,
  contradiction: 400,
  salience_refine: 1_200,
});

/**
 * How many items each model phase would process, asked of the tenant database.
 *
 * Every count carries the same anti-loop predicate the phases themselves use: an
 * estimate that counted model-derived rows would budget for work the cycle is
 * forbidden to do, and the budget would then look mysteriously generous.
 *
 * **And the same consideration predicate**, for a sharper reason than tidiness.
 * A phase's cap is its share of the estimate, so a count that included rows the
 * phase will not select prices a batch that will never be sent — and on a
 * converged brain that is the whole corpus, which turns "nothing to do" into a
 * generous budget for it. The failure runs the other way too, and that is the
 * one that bites: the contradiction phase FILLS a short batch of new facts with
 * already-considered ones, so counting only the new facts would produce a cap
 * one item wide in front of a prompt two hundred items long, and the phase would
 * stop on `budget_exhausted` every time a single fact arrived.
 */
export async function measureWorkload(
  sql: SQL,
  limits: { readonly batch: number; readonly consideration?: ConsiderationVersions },
): Promise<CycleWorkload> {
  const version = limits.consideration ?? CONSIDERATION_VERSION;
  const scalar = async (query: Promise<unknown>): Promise<number> => {
    const rows = (await query) as Array<{ n: number }>;
    return Math.min(limits.batch, rows[0]?.n ?? 0);
  };

  const chunks = await scalar(sql`
    SELECT count(*)::int AS n
      FROM chunk c JOIN page p ON p.page_id = c.page_id
     WHERE c.deleted_at IS NULL AND c.quarantined_at IS NULL
       AND p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.stale_at IS NULL
       AND p.derivation = 'ingested'
       AND (c.extract_considered_version IS NULL
            OR c.extract_considered_version < ${version.extract})`);

  const entities = await scalar(sql`
    SELECT count(*)::int AS n FROM entity
     WHERE deleted_at IS NULL
       AND (enrich_considered_version IS NULL
            OR enrich_considered_version < ${version.enrich})`);

  const pages = await scalar(sql`
    SELECT count(*)::int AS n FROM page
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND stale_at IS NULL
       AND derivation = 'ingested'`);

  const unrefinedPages = await scalar(sql`
    SELECT count(*)::int AS n FROM page
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND stale_at IS NULL
       AND derivation = 'ingested'
       AND (salience_refine_considered_version IS NULL
            OR salience_refine_considered_version < ${version.salience_refine})`);

  // The batch the contradiction phase will actually send: nothing at all when no
  // fact is unconsidered, and otherwise a full batch, because the phase fills
  // the space behind the new facts with old ones so a new claim is read beside
  // the brain's existing ones.
  const freshFacts = await scalar(sql`
    SELECT count(*)::int AS n FROM fact
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
       AND (contradiction_considered_version IS NULL
            OR contradiction_considered_version < ${version.contradiction})`);
  const liveFacts = await scalar(sql`
    SELECT count(*)::int AS n FROM fact
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL`);
  const factPairs = freshFacts === 0 ? 0 : liveFacts;

  // The same predicate the phase itself queues on (`ocr-phase.ts`). An estimate
  // that counted quarantined or already-read attachments would budget for calls
  // the phase is forbidden to make, and the cap would look mysteriously generous.
  const attachments = await scalar(sql`
    SELECT count(*)::int AS n FROM attachment
     WHERE ocr_text IS NULL AND deleted_at IS NULL AND quarantined_at IS NULL`);

  const workload: Record<ModelPhase, PhaseWorkload> = {
    transcribe: { items: attachments, inputTokensPerItem: TOKENS_PER_ITEM.transcribe },
    extract: { items: chunks, inputTokensPerItem: TOKENS_PER_ITEM.extract },
    enrich: { items: entities, inputTokensPerItem: TOKENS_PER_ITEM.enrich },
    synopsis: { items: pages, inputTokensPerItem: TOKENS_PER_ITEM.synopsis },
    contradiction: { items: factPairs, inputTokensPerItem: TOKENS_PER_ITEM.contradiction },
    salience_refine: { items: unrefinedPages, inputTokensPerItem: TOKENS_PER_ITEM.salience_refine },
  };
  return workload;
}
