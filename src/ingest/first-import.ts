/**
 * The first-import gate (R8a, R14) — shared, and U9 consumes it unchanged.
 *
 * **Why it lives with U8 rather than with the connectors.** Chat-export and
 * folder import carry no per-user *connector* vendor fee, which is what makes
 * them the free tier's guaranteed ingestion path — and it is exactly why the
 * gate has to be here. They are not free: every imported chunk is a metered
 * embedding call, KTD8 prices a 50k-chunk first import at roughly $2.60, and
 * this unit ships before any billing relationship exists. Shipping it ungated
 * would put the largest uncapped spend in the system behind the tier with no
 * card on file.
 *
 * Four mechanisms, and each one is a way the gate goes quietly false:
 *
 * **1. The estimate is delta-aware, and it is computed over exactly the item
 * set that will be imported.** Two separate walks — one that decides the cost
 * and one that decides the work — is how a gate approves 1,200 items and
 * imports 40,000. So {@link selectWindow} produces the set, and
 * {@link estimateImport} takes *that set* rather than the candidates it came
 * from. An item already held at the same digest costs nothing, because U4's
 * ingestion is a no-op on an unchanged digest; an item held at a *different*
 * digest costs full price, because it re-chunks and re-embeds.
 *
 * **2. The window is bounded by default and the widen path is visible.** The
 * default is the last {@link DEFAULT_WINDOW_DAYS} days. What the window
 * excluded is reported rather than dropped, so "importing 1,204 of 8,933 —
 * widen to all time" is a sentence the caller can say. **An item with no
 * timestamp is inside every window**: excluding it would silently shrink the
 * import, and the estimate and the import must agree.
 *
 * **3. An unpriced embedding model is a refusal, not a zero.** R14's rule, at
 * the one call site that would otherwise quietly approve an unbounded import:
 * a model the canonical table cannot price yields no estimate at all.
 *
 * **4. The ceiling is read from the control-plane row, and every unknown reads
 * closed.** No row is a refusal. A NULL cap is *the platform default*, which is
 * what `src/control/schema.sql` says the column means — it is not "no cap", and
 * reading it that way is how the free tier gets an unbounded budget. The one
 * unknown that reads *open* is a lapsed spend window: U20's meter rolls
 * `spend_window_started_at` only when it writes, so a tenant whose last call
 * was five weeks ago still carries last month's total, and charging them for it
 * is a wrong refusal rather than a safety property.
 *
 * The decision itself is inert. It approves an amount; **`run.ts` is what turns
 * that amount into a `Budget` and threads it through every write**, and without
 * that the approval is decoration.
 */

import type { SQL } from 'bun';

import { DEFAULT_SPEND_WINDOW_SECONDS } from '../ai/gateway.ts';
import { CANONICAL_PRICE_BOOK, type PriceBook } from '../ai/pricing.ts';
import { routeFor, type NamedProfile } from '../ai/routing.ts';
import { EMBED_OP, backlogSize } from '../core/write/embed.ts';
import { TARGET_CHUNK_CHARS } from '../core/write/chunker.ts';
import { textArrayLiteral } from '../core/write/pg-values.ts';
import type { JobQueue, JobTarget } from '../worker/jobs.ts';

/** The two `import` targets `control.job` admits. Mirrors `LEGAL_TARGETS`. */
export const IMPORT_TARGETS = ['chat_export', 'folder'] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

export function isImportTarget(target: JobTarget): target is ImportTarget {
  return (IMPORT_TARGETS as readonly JobTarget[]).includes(target);
}

/** R14's bounded default window. */
export const DEFAULT_WINDOW_DAYS = 90;

/**
 * Rough, deterministic, and deliberately not a tokenizer — the same choice
 * U20's estimator makes, for the same reason: this number is compared against a
 * ceiling, and a per-provider tokenizer would be a second thing to keep in sync
 * for an approximation.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * The margin between what the estimate measures and what the run will actually
 * encode.
 *
 * The estimate is the **chunk pass**: every chunk is embedded once, which is
 * KTD8's own unit and the number a user is shown. The write path also embeds
 * each extracted *fact*, and those statements are extracted from the same chunk
 * text and are strictly shorter — so the true spend sits between one and two
 * chunk passes, closer to one on ordinary prose. A quarter is the stated
 * allowance. It is a policy choice about how early the cap fires, not a price:
 * too small and every large import stops short of its own approval and has to
 * be resumed; too large and the ceiling stops meaning anything.
 */
export const ESTIMATE_MARGIN_PERCENT = 25;

/**
 * Above either of these the import is not run inline. Items first, because a
 * 40,000-item import is a long-running job whatever it costs.
 *
 * Micro-USD, integer, in the unit `src/control/schema.sql` counts in.
 */
export const DEFAULT_INLINE_ITEM_CEILING = 500;
export const DEFAULT_INLINE_SPEND_CEILING = 250_000;

/**
 * What a NULL `spend_cap_micro_usd` means, spelled out. The column's own comment
 * says "the platform default applies"; this is that default, and it exists so
 * that no code path can read NULL as unbounded.
 */
export const DEFAULT_TENANT_SPEND_CEILING = 5_000_000;

/** One item a source is offering, before anything has been decided about it. */
export interface ImportCandidate {
  /** The provider's own id, and half the idempotency key. */
  readonly externalRef: string;
  /** `contentDigest(title, body)` — the other half. */
  readonly contentSha256: string;
  /** When the item happened. Null is legal and lands *inside* every window. */
  readonly occurredAt: Date | null;
  /** Characters of body text. What the chunk-pass estimate is computed from. */
  readonly characters: number;
}

export type ImportWindow = { readonly days: number } | 'all';

export interface WindowSelection {
  readonly selected: readonly ImportCandidate[];
  /** Older than the window. Reported rather than dropped: this is the widen path. */
  readonly excluded: readonly ImportCandidate[];
  /** Null when the window was `'all'`. */
  readonly windowDays: number | null;
  /** Items admitted because they carry no timestamp at all. */
  readonly undated: number;
}

export interface ImportEstimate {
  readonly items: number;
  readonly newItems: number;
  /** Held at a different digest: re-chunked and re-embedded through U4. */
  readonly changedItems: number;
  /** Held at the same digest: a no-op, and it costs nothing. */
  readonly unchangedItems: number;
  /** Chunks this import will create. The item pass. */
  readonly chunks: number;
  readonly tokens: number;
  /**
   * Chunks already written and still unembedded — U4 defers the chunk pass,
   * and a run that stopped on its ceiling banks its pages and leaves their
   * passages in the backlog. A resumed import sees every one of those items
   * as `unchanged` and would therefore estimate **zero**, approve zero, and
   * be unable to finish the work it already paid to start. Counted through
   * U4's own `backlogSize`, never a re-implementation of its predicate.
   */
  readonly backlogChunks: number;
  /** What the gateway would route the `embedding` op to under this profile. */
  readonly modelId: string;
  /** The item pass, priced through the canonical table. Integer micro-USD. */
  readonly microUsd: number;
  /** The banked backlog, priced the same way. */
  readonly backlogMicroUsd: number;
  /** Both passes plus {@link ESTIMATE_MARGIN_PERCENT}. What is approved. */
  readonly requestedMicroUsd: number;
}

export type EstimateOutcome =
  | { readonly ok: true; readonly estimate: ImportEstimate }
  /** R14: a model the canonical table cannot price does not get an estimate. */
  | { readonly ok: false; readonly reason: 'model_not_priced'; readonly modelId: string };

export interface EstimateRequest {
  /** The **tenant** database. The delta is a query over its pages. */
  readonly sql: SQL;
  readonly profile: NamedProfile;
  readonly candidates: readonly ImportCandidate[];
  readonly priceBook?: PriceBook;
}

export type GateRefusal =
  /** No control-plane row. Reads closed: an unknown tenant has no headroom. */
  | 'tenant_unknown'
  | 'tenant_not_ready'
  | 'cap_exhausted'
  /** Deferral was required and no queue was supplied to defer to. */
  | 'no_queue'
  | 'already_open'
  | 'quarantined'
  | 'raced';

export interface GateHeadroom {
  readonly capMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly headroomMicroUsd: number;
  /** True when the rolling window had lapsed, so the counter read as zero. */
  readonly windowLapsed: boolean;
  /** True when the cap column was NULL and the platform default applied. */
  readonly capIsPlatformDefault: boolean;
}

export type GateDecision =
  | {
      readonly proceed: 'inline';
      readonly approvedMicroUsd: number;
      /** The approval was cut down to the tenant's remaining headroom. */
      readonly clamped: boolean;
      readonly headroom: GateHeadroom;
    }
  | {
      readonly proceed: 'deferred';
      readonly jobId: string;
      readonly approvedMicroUsd: number;
      readonly clamped: boolean;
      readonly headroom: GateHeadroom;
    }
  | {
      readonly proceed: 'refused';
      readonly reason: GateRefusal;
      readonly headroom: GateHeadroom | null;
    };

export interface GateRequest {
  /** The **control plane**. The counter and the cap live on the tenant row. */
  readonly control: SQL;
  readonly tenantId: string;
  readonly target: ImportTarget;
  readonly estimate: ImportEstimate;
  readonly now: Date;
  /** Absent means "inline or nothing": a required deferral becomes `no_queue`. */
  readonly queue?: JobQueue;
  readonly inlineItemCeiling?: number;
  readonly inlineSpendCeiling?: number;
  /** The rolling window U20's meter uses. Same default, read not re-chosen. */
  readonly windowSeconds?: number;
  readonly jobId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Split the candidates on the window boundary.
 *
 * Pure, and separate from the estimate on purpose: the set this returns is the
 * set the estimate is computed over **and** the set the run imports, and keeping
 * it a value rather than a predicate is what makes those three the same thing.
 * Two independent walks is how a gate approves 1,200 items and imports 40,000.
 */
export function selectWindow(
  candidates: readonly ImportCandidate[],
  options: { readonly now: Date; readonly window?: ImportWindow },
): WindowSelection {
  const window = options.window ?? { days: DEFAULT_WINDOW_DAYS };
  if (window === 'all') {
    return { selected: [...candidates], excluded: [], windowDays: null, undated: 0 };
  }

  const days = Math.max(0, Math.trunc(window.days));
  const boundary = options.now.getTime() - days * DAY_MS;
  const selected: ImportCandidate[] = [];
  const excluded: ImportCandidate[] = [];
  let undated = 0;

  for (const candidate of candidates) {
    if (candidate.occurredAt === null) {
      // Inside every window. Excluding it would silently shrink the import
      // relative to what was estimated, and the two must agree.
      undated += 1;
      selected.push(candidate);
      continue;
    }
    if (candidate.occurredAt.getTime() >= boundary) selected.push(candidate);
    else excluded.push(candidate);
  }

  return { selected, excluded, windowDays: days, undated };
}

/** The op this gate prices, resolved through the profile rather than named. */
export function embeddingRouteFor(profile: NamedProfile): string {
  return routeFor(profile, EMBED_OP).id;
}

/** What one item's chunk pass encodes. Deliberately not a tokenizer. */
function tokensFor(characters: number): number {
  const bounded = Math.max(0, Math.trunc(characters));
  return Math.ceil(bounded / CHARS_PER_TOKEN);
}

function chunksFor(characters: number): number {
  const bounded = Math.max(0, Math.trunc(characters));
  return bounded === 0 ? 0 : Math.ceil(bounded / TARGET_CHUNK_CHARS);
}

/**
 * What the chunk pass costs, over a corpus already narrowed to the window.
 *
 * Delta-aware against the tenant's own pages, and the asymmetry is the point: an
 * item held at the **same** digest is a no-op in U4 and costs nothing, while an
 * item held at a **different** digest re-chunks and re-embeds and costs full
 * price. Pricing a changed item as unchanged is the direction that under-counts,
 * which is the direction a spend gate must never take.
 */
export async function estimateImport(request: EstimateRequest): Promise<EstimateOutcome> {
  const modelId = embeddingRouteFor(request.profile);
  const priceBook = request.priceBook ?? CANONICAL_PRICE_BOOK;

  const refs = request.candidates.map((candidate) => candidate.externalRef);
  const held = new Map<string, string>();
  if (refs.length > 0) {
    const rows = (await request.sql`
      SELECT external_ref, content_sha256
        FROM page
       WHERE external_ref = ANY(${textArrayLiteral(refs)}::text[])
         AND deleted_at IS NULL
    `) as Array<{ external_ref: string; content_sha256: string }>;
    for (const row of rows) held.set(row.external_ref, row.content_sha256);
  }

  let newItems = 0;
  let changedItems = 0;
  let unchangedItems = 0;
  let chunks = 0;
  let tokens = 0;

  for (const candidate of request.candidates) {
    const digest = held.get(candidate.externalRef);
    if (digest === candidate.contentSha256) {
      unchangedItems += 1;
      continue;
    }
    if (digest === undefined) newItems += 1;
    else changedItems += 1;
    chunks += chunksFor(candidate.characters);
    tokens += tokensFor(candidate.characters);
  }

  // Work already banked by a run that stopped on its ceiling. Sized through
  // U4's own predicate rather than a second copy of it, at the chunker's target
  // size per chunk — an approximation, and stated as one, because the honest
  // alternative would be this module re-deriving `embedding IS NULL` across
  // pages and chunks and drifting from it the first time U4 tightens the seam.
  const backlogChunks = await backlogSize(request.sql);
  const backlogTokens = tokensFor(backlogChunks * TARGET_CHUNK_CHARS);

  // R14, at the one call site that would otherwise quietly approve an unbounded
  // import: a model with no price yields no estimate, never an estimate of zero.
  const priced = priceBook.cost(modelId, { inputTokens: tokens, outputTokens: 0 });
  const pricedBacklog = priceBook.cost(modelId, { inputTokens: backlogTokens, outputTokens: 0 });
  if (priced === null || pricedBacklog === null) {
    return { ok: false, reason: 'model_not_priced', modelId };
  }

  const withMargin = Math.ceil(((priced + pricedBacklog) * (100 + ESTIMATE_MARGIN_PERCENT)) / 100);

  return {
    ok: true,
    estimate: {
      items: request.candidates.length,
      newItems,
      changedItems,
      unchangedItems,
      chunks,
      tokens,
      backlogChunks,
      modelId,
      microUsd: priced,
      backlogMicroUsd: pricedBacklog,
      requestedMicroUsd: withMargin,
    },
  };
}

/**
 * The tenant's remaining headroom, with every unknown read closed.
 *
 * Two readings are deliberate and pull opposite ways. A **NULL cap** is the
 * platform default, which is what `src/control/schema.sql` says the column
 * means — reading it as "no cap" is how the free tier acquires an unbounded
 * budget. A **lapsed spend window** reads as zero spend, because U20's meter
 * rolls `spend_window_started_at` only when it writes: a tenant whose last call
 * was five weeks ago still carries last month's total, and charging them for it
 * is a wrong refusal rather than a safety property.
 */
export async function readHeadroom(
  control: SQL,
  request: { readonly tenantId: string; readonly now: Date; readonly windowSeconds?: number },
): Promise<
  | { readonly ok: true; readonly headroom: GateHeadroom; readonly state: string }
  | { readonly ok: false; readonly reason: 'tenant_unknown' }
> {
  const windowSeconds = request.windowSeconds ?? DEFAULT_SPEND_WINDOW_SECONDS;
  const rows = (await control`
    SELECT state::text AS state,
           spend_micro_usd::bigint AS spend,
           spend_cap_micro_usd::bigint AS cap,
           spend_window_started_at
      FROM control.tenant
     WHERE tenant_id = ${request.tenantId}
  `) as Array<{
    state: string;
    spend: string | number;
    cap: string | number | null;
    spend_window_started_at: Date;
  }>;

  const row = rows[0];
  // No row is a refusal. An unknown tenant has no headroom, and inventing one
  // for them is the whole failure this gate exists to prevent.
  if (row === undefined) return { ok: false, reason: 'tenant_unknown' };

  const windowLapsed =
    request.now.getTime() - row.spend_window_started_at.getTime() >= windowSeconds * 1_000;
  const spent = windowLapsed ? 0 : Number(row.spend);
  const capIsPlatformDefault = row.cap === null;
  const cap = capIsPlatformDefault ? DEFAULT_TENANT_SPEND_CEILING : Number(row.cap);

  return {
    ok: true,
    state: row.state,
    headroom: {
      capMicroUsd: cap,
      spentMicroUsd: spent,
      headroomMicroUsd: Math.max(0, cap - spent),
      windowLapsed,
      capIsPlatformDefault,
    },
  };
}

function refusal(reason: GateRefusal, headroom: GateHeadroom | null): GateDecision {
  return { proceed: 'refused', reason, headroom };
}

/**
 * Approve, defer, or refuse.
 *
 * The amount it approves is what `run.ts` must build its `Budget` from. Nothing
 * in this module enforces that — the enforcement is one budget threaded through
 * every write, and a test that spends past the cap is what keeps it honest.
 */
export async function gateFirstImport(request: GateRequest): Promise<GateDecision> {
  const read = await readHeadroom(request.control, {
    tenantId: request.tenantId,
    now: request.now,
    ...(request.windowSeconds === undefined ? {} : { windowSeconds: request.windowSeconds }),
  });
  if (!read.ok) return refusal('tenant_unknown', null);
  if (read.state !== 'ready') return refusal('tenant_not_ready', read.headroom);

  const headroom = read.headroom;
  if (headroom.headroomMicroUsd <= 0) return refusal('cap_exhausted', headroom);

  const requested = request.estimate.requestedMicroUsd;
  const approvedMicroUsd = Math.min(requested, headroom.headroomMicroUsd);
  const clamped = approvedMicroUsd < requested;

  const itemCeiling = request.inlineItemCeiling ?? DEFAULT_INLINE_ITEM_CEILING;
  const spendCeiling = request.inlineSpendCeiling ?? DEFAULT_INLINE_SPEND_CEILING;
  const mustDefer = request.estimate.items > itemCeiling || requested > spendCeiling;

  if (!mustDefer) {
    return { proceed: 'inline', approvedMicroUsd, clamped, headroom };
  }

  // A deferral with nowhere to defer to is a refusal. Falling back to an inline
  // run would turn the ceiling that triggered the deferral into a no-op.
  if (request.queue === undefined) return refusal('no_queue', headroom);

  const outcome = await request.queue.enqueue({
    tenantId: request.tenantId,
    kind: 'import',
    target: request.target,
    trigger: 'user_request',
    now: request.now,
    ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
  });

  if (!outcome.enqueued) return refusal(outcome.reason, headroom);

  return {
    proceed: 'deferred',
    jobId: outcome.job.jobId,
    approvedMicroUsd,
    clamped,
    headroom,
  };
}

export { CANONICAL_PRICE_BOOK, DEFAULT_SPEND_WINDOW_SECONDS, TARGET_CHUNK_CHARS };
