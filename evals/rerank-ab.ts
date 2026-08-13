/**
 * `bun run evals/rerank-ab.ts` — the rerank on/off A/B, its cost line, and the
 * two things U12 cannot measure without spending money it was told not to spend.
 *
 * ============================================================================
 * WHAT THIS RECEIPT CLAIMS AND WHAT IT REFUSES TO
 * ============================================================================
 *
 * The plan's test scenario reads: *"Rerank on/off A-B on the fixture corpus:
 * nDCG@10 improves; cost per query recorded and within KTD4's envelope."* Two
 * halves, and they have different evidentiary standing:
 *
 *   - **The cost is real.** It is arithmetic over the canonical pricing table
 *     and the pinned routed model, with the candidate count and the measured
 *     passage length as its inputs. Nothing about it needs a provider.
 *
 *   - **The uplift is not measurable here, and this receipt says so rather than
 *     reporting a number that looks like one.** Stage 12 sorts by the
 *     cross-encoder score and nothing else, so an A/B over a *stand-in* scorer
 *     measures the stand-in. The committed scores are synthetic
 *     (`evals/rerank-scores.ts` argues why at length), the measured delta is
 *     **negative**, and the honest reading of a negative delta from a thirty-line
 *     lexical function standing in for a 278M-parameter model is not "reranking
 *     hurts" — it is "this is not a cross-encoder".
 *
 * So `uplift_status` is `deferred` while every committed score is synthetic, the
 * measured delta is carried as the *evidence for the deferral*, and the day a
 * provider-sourced score lands the same command reports `measured` with no edit
 * anywhere. That is the same non-rotting switch `gates.ts` uses for a floor the
 * synthetic vectors cannot reach.
 *
 * **The p99 latency cannot be produced here at all.** KTD4 asks for a measured
 * p99 from a deployed container, which needs a deployment. It is recorded
 * `deferred` with the run that would produce it named, never estimated.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANONICAL_PRICING, costMicroUsd } from '../src/ai/pricing.ts';
import { HOSTED_PROFILE, routeFor } from '../src/ai/routing.ts';
import { rerankPassageOf } from '../src/core/search/rerank.ts';
import {
  RERANK_CANDIDATES_DEFAULT,
  RERANK_CANDIDATES_FLOOR,
  LATENCY_DIAL,
} from '../src/core/search/rerank-stage.ts';
import { loadRerankScoreIndex, loadTierContext, runBlockingTier, type TierContext } from './blocking.ts';
import { RANKING_FLOORS } from './gates.ts';
import { scoreCorpus } from './regenerate-rerank-scores.ts';
import type { RerankScoreIndex } from './rerank-scores.ts';
import type { EvalReport } from './run.ts';

export const RECEIPT_PATH = 'evals/receipts/u12-rerank-ab.json';

/** KTD4's quoted shape: a hundred candidates of about four hundred tokens. */
const KTD4_CANDIDATE_TOKENS = 400;

/** `gateway.ts:estimateTokens`, which is what the meter will actually charge on. */
const CHARS_PER_TOKEN = 4;

export interface CostLine {
  readonly model_id: string;
  readonly candidates: number;
  /** Mean tokens per passage, measured over the committed corpus. */
  readonly measured_tokens_per_candidate: number;
  /** KTD4's assumption, carried so the two can be compared without arithmetic. */
  readonly envelope_tokens_per_candidate: number;
  readonly micro_usd_per_query_measured: number;
  readonly micro_usd_per_query_at_envelope: number;
  /** At the plan's ~860 queries/month single-active-user volume. */
  readonly usd_per_active_user_month: number;
  readonly envelope: string;
  readonly within_envelope: boolean;
}

/**
 * What one rerank call costs, from the canonical table and nothing else.
 *
 * No price appears in this file: `costMicroUsd` and `CANONICAL_PRICING` are the
 * only source, which is the discipline `test/ai/price-drift.test.ts` enforces
 * over `src/` and which is worth keeping here for the same reason — a receipt
 * quoting its own number is a receipt that stops being true when a vendor moves.
 */
export function costLine(options: { readonly candidates?: number } = {}): CostLine {
  const route = routeFor(HOSTED_PROFILE, 'rerank');
  const price = CANONICAL_PRICING.get(route.id);
  if (price === undefined) throw new Error(`the rerank route ${route.id} has no canonical price`);

  const candidates = options.candidates ?? RERANK_CANDIDATES_DEFAULT;
  const corpus = scoreCorpus();
  const measured =
    corpus.passages.length === 0
      ? 0
      : Math.round(
          corpus.passages.reduce(
            (total, passage) => total + Math.ceil(rerankPassageOf(passage).length / CHARS_PER_TOKEN),
            0,
          ) / corpus.passages.length,
        );

  const perQuery = (tokensEach: number): number =>
    costMicroUsd({ inputTokens: candidates * tokensEach, outputTokens: 0 }, price);

  const atEnvelope = perQuery(KTD4_CANDIDATE_TOKENS);
  const monthly = (atEnvelope * 860) / 1_000_000;

  return {
    model_id: route.id,
    candidates,
    measured_tokens_per_candidate: measured,
    envelope_tokens_per_candidate: KTD4_CANDIDATE_TOKENS,
    micro_usd_per_query_measured: perQuery(measured),
    micro_usd_per_query_at_envelope: atEnvelope,
    usd_per_active_user_month: Number(monthly.toFixed(4)),
    envelope:
      "KTD4: '~$0.00012/query, about $0.10/active user/month at the ~860-query volume, roughly 15-30x " +
      "under the original $1.50-3 envelope'",
    // The bar KTD4 states, checked rather than asserted. Deliberately the loose
    // end of the range: the receipt's job is to catch a price that moved by an
    // order of magnitude, not to re-derive the plan's own arithmetic.
    within_envelope: monthly <= 3,
  };
}

export interface AbLeg {
  readonly ranker: string;
  readonly digest: string;
  readonly aggregate_ndcg10: number;
  readonly by_floor: Readonly<Record<string, number>>;
}

export interface RerankAbReceipt {
  readonly unit: 'U12';
  readonly corpus_queries: number;
  readonly embedding_manifest_digest: string;
  readonly rerank_manifest_digest: string;
  readonly score_sources: Readonly<Record<string, number>>;
  readonly off: AbLeg;
  readonly on: AbLeg;
  readonly delta_ndcg10: number;
  readonly uplift_status: 'measured' | 'deferred';
  readonly uplift_reason: string;
  readonly cost: CostLine;
  readonly latency: {
    readonly status: 'deferred';
    readonly reason: string;
    readonly what_would_produce_it: string;
    readonly dial_if_it_misses: string;
    readonly dial_floor: number;
  };
}

function legOf(report: EvalReport, digest: string, measurements: Record<string, number>): AbLeg {
  return {
    ranker: report.ranker,
    digest,
    aggregate_ndcg10: Number(report.aggregate.ndcg10.toFixed(6)),
    by_floor: measurements,
  };
}

function floorValues(report: EvalReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const floor of RANKING_FLOORS) {
    const bucket =
      floor.scope.kind === 'aggregate'
        ? report.aggregate
        : floor.scope.kind === 'type'
          ? report.byType[floor.scope.type]
          : report.byFamily[floor.scope.family];
    if (bucket === undefined) continue;
    const value =
      floor.metric === 'ndcg@10'
        ? bucket.ndcg10
        : floor.metric === 'hit@1'
          ? bucket.hit1
          : floor.metric === 'hit@3'
            ? bucket.hit3
            : floor.scope.kind === 'family'
              ? (report.byFamily[floor.scope.family]?.dilutionHit3 ?? Number.NaN)
              : Number.NaN;
    out[floor.id] = Number(value.toFixed(6));
  }
  return out;
}

export async function buildReceipt(deps?: {
  readonly context?: TierContext;
  readonly scores?: RerankScoreIndex;
}): Promise<RerankAbReceipt> {
  const { stackRanker, rerankedStackRanker } = await import('../test/core/search/corpus-ranker.ts');
  const context = deps?.context ?? loadTierContext();
  const scores = deps?.scores ?? loadRerankScoreIndex();

  const off = runBlockingTier({ ranker: stackRanker, context });
  const on = runBlockingTier({ ranker: rerankedStackRanker(scores), context });

  const measured = scores.sources.provider > 0;
  const delta = on.report.aggregate.ndcg10 - off.report.aggregate.ndcg10;

  return {
    unit: 'U12',
    corpus_queries: off.report.queryCount,
    embedding_manifest_digest: off.report.embeddingManifestDigest,
    rerank_manifest_digest: scores.manifestDigest,
    score_sources: { ...scores.sources },
    off: legOf(off.report, off.digest, floorValues(off.report)),
    on: legOf(on.report, on.digest, floorValues(on.report)),
    delta_ndcg10: Number(delta.toFixed(6)),
    uplift_status: measured ? 'measured' : 'deferred',
    uplift_reason: measured
      ? 'scored against provider-sourced cross-encoder scores'
      : 'every committed (query, candidate) score is synthetic. Stage 12 sorts by the cross-encoder score ' +
        'and nothing else, so an A/B over a stand-in measures the stand-in: the delta below is evidence ' +
        'that a thirty-line lexical function is weaker than the stack it reranks, and is not evidence ' +
        'about `@cf/baai/bge-reranker-base`. Re-run against provider scores and this flips to `measured` ' +
        'with no edit — the switch is `score_sources.provider`, counted from the manifest.',
    cost: costLine(),
    latency: {
      status: 'deferred',
      reason:
        'KTD4 asks for a measured request-time p99 from a deployed container, which cannot be produced ' +
        'without deploying one. U12 wires the stage, the dial and the degraded path; the number is a ' +
        'deployment output, and estimating it here would be the fake pass the whole gate exists to prevent.',
      what_would_produce_it:
        'the R6 fixture queries replayed against the deployed Cloudflare Container over its public origin, ' +
        'warm, with the rerank op routed through the hosted gateway — the same shape U5 used to settle ' +
        "Assumption 5's query-embedding latency, extended to the second external call",
      dial_if_it_misses: LATENCY_DIAL,
      dial_floor: RERANK_CANDIDATES_FLOOR,
    },
  };
}

export function serializeReceipt(receipt: RerankAbReceipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/** The digest a freshness test compares, so a stale receipt is a red run. */
export function receiptDigest(receipt: RerankAbReceipt): string {
  return createHash('sha256').update(serializeReceipt(receipt)).digest('hex');
}

export function readCommittedReceipt(): RerankAbReceipt {
  const text = readFileSync(fileURLToPath(new URL(`../${RECEIPT_PATH}`, import.meta.url)), 'utf8');
  return JSON.parse(text) as RerankAbReceipt;
}

if (import.meta.main) {
  const receipt = await buildReceipt();
  await Bun.write(RECEIPT_PATH, serializeReceipt(receipt));
  process.stderr.write(
    `wrote ${RECEIPT_PATH}\n` +
      `  delta nDCG@10 ${receipt.delta_ndcg10} (${receipt.uplift_status})\n` +
      `  cost ${receipt.cost.micro_usd_per_query_at_envelope} micro-USD/query at KTD4's envelope shape\n` +
      `  latency ${receipt.latency.status}\n`,
  );
}
