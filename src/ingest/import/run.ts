/**
 * The shared import runner: the gate's approval turned into a ceiling that
 * actually holds, and the ingest log's rows actually written.
 *
 * **This is where the first-import gate stops being decoration.** `gateFirstImport`
 * returns a number. If the run then hands `ingestDocument` a budget with no cap
 * — or a fresh uncapped budget per item — the approval bounded nothing and the
 * 50k-chunk import runs to completion at whatever it costs. So there is exactly
 * one `Budget` per run, built from the approved amount, threaded through every
 * write, and **a budget refusal stops the run** rather than being counted as one
 * item's bad luck. Iterating the remaining 49,000 items to collect 49,000
 * identical refusals is the same defect wearing a loop.
 *
 * **Stopping is cheap because resuming is free.** U4's ingestion is a no-op on
 * an unchanged digest and costs no provider call, so a stopped run re-run from
 * the top skips everything it already wrote and continues where the money ran
 * out. That is the property that makes a hard stop the right behaviour instead
 * of a partial-credit heuristic.
 *
 * **Order matters in two places.**
 *
 *   1. **The run row opens first.** It is what `page.ingest_id` references and
 *      what U4's own counter advances, and opening it first means a refusal is
 *      recorded in the ingest log rather than being invisible to the operator
 *      asking why nothing imported.
 *   2. **The raw payload is preserved before the gate runs**, not after the
 *      import succeeds. A deferred import resumes hours later, by which time the
 *      user's export file may be gone; if the bytes were not banked up front,
 *      the deferral is a promise the fleet cannot keep. A failed preservation is
 *      a typed stop (R16) — never a warning that lets unre-derivable pages land.
 *
 * **Every item leaves a row, including the ones the write path never sees.**
 * U4's `countIngestItem` advances `items_seen` for everything it accepts; a
 * malformed conversation and a file that failed to decode never reach it. The
 * runner counts those itself, or a run that skipped a third of a broken export
 * reports a clean import.
 */

import type { SQL } from 'bun';

import { createBudget, type ModelGateway } from '../../ai/gateway.ts';
import type { PriceBook } from '../../ai/pricing.ts';
import type { NamedProfile } from '../../ai/routing.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import type { TenantStorage } from '../../control/storage.ts';
import { runChunkEmbedBacklog } from '../../core/write/embed.ts';
import {
  contentDigest,
  ingestDocument,
  type SourceType,
  type WriteFailureReason,
} from '../../core/write/write-path.ts';
import type { JobLease, JobQueue } from '../../worker/jobs.ts';
import type { JobContext } from '../../worker/runner.ts';
import {
  DEFAULT_WINDOW_DAYS,
  estimateImport,
  gateFirstImport,
  isImportTarget,
  selectWindow,
  type GateDecision,
  type ImportEstimate,
  type ImportTarget,
  type ImportWindow,
} from '../first-import.ts';
import {
  countRunItem,
  finishRun,
  openRun,
  recordItem,
  type IngestFailureCode,
} from '../log.ts';
import { tombstoneMissing, type TombstoneRequest, type TombstoneResult } from './folder.ts';
import {
  manifestKeyFor,
  rawKeyFor,
  readManifest,
  writeManifest,
  type DeferredImport,
  type RawObject,
  type RawStore,
} from './raw.ts';

/** One tenant's live connections. Opened by the caller; never derived here. */
export interface TenantRuntime {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
}

export interface ImportItem {
  readonly externalRef: string;
  readonly title: string | null;
  readonly body: string;
  readonly occurredAt: Date | null;
}

export interface ImportItemFailure {
  readonly externalRef: string | null;
  readonly reason: IngestFailureCode;
}

/** Everything a source offers this run, already parsed and already scanned. */
export interface ImportMaterial {
  readonly items: readonly ImportItem[];
  /** Items the source could not produce. Logged and skipped; the rest completes. */
  readonly failures: readonly ImportItemFailure[];
  /** The bytes to preserve under `{tenant}/raw/`, and the untrusted id to key them by. */
  readonly raw?: { readonly id: string; readonly object: RawObject } | null;
  /** Folder only: the deletion reconciliation this scan supports, if any. */
  readonly tombstone?: TombstoneRequest | null;
}

export interface ImportRunRequest {
  readonly tenant: TenantRuntime;
  /** The control plane. The gate's counter and cap live there. */
  readonly control: SQL;
  readonly storage: TenantStorage;
  readonly rawStore: RawStore;
  readonly profile: NamedProfile;
  readonly originContext: string;
  readonly sourceType: SourceType;
  readonly target: ImportTarget;
  readonly material: ImportMaterial;
  readonly now: Date;
  readonly window?: ImportWindow;
  readonly queue?: JobQueue;
  /** What a deferred run would need to find this material again. */
  readonly resumeWith?: { readonly rawKey?: string; readonly rootId?: string };
  readonly inlineItemCeiling?: number;
  readonly inlineSpendCeiling?: number;
  readonly priceBook?: PriceBook;
  /**
   * A resumed deferred import is already gated: the ceiling was decided when
   * the job was enqueued, and re-gating would re-read a counter the first pass
   * already moved. Present means "skip the gate, use this cap".
   */
  readonly approvedMicroUsd?: number;
  readonly jobId?: string;
  readonly budgetLabel?: string;
}

export type ImportStopReason = 'budget_exhausted' | 'raw_unavailable' | 'model_not_priced';

export interface ImportCounts {
  readonly written: number;
  readonly unchanged: number;
  readonly quarantined: number;
  readonly failed: number;
  readonly tombstoned: number;
}

export interface ImportRunResult {
  readonly outcome: 'completed' | 'stopped' | 'deferred' | 'refused';
  readonly runId: string | null;
  readonly decision: GateDecision | null;
  readonly estimate: ImportEstimate | null;
  /** The visible widen path: what the bounded window left out. */
  readonly widen: { readonly excludedItems: number; readonly windowDays: number | null };
  readonly counts: ImportCounts;
  /**
   * How many items the loop actually reached.
   *
   * The difference between stopping on an exhausted budget and refusing every
   * remaining item one at a time is invisible in the dispositions — both leave
   * the same rows behind. It shows up here, which is also the number an
   * operator wants: "stopped after 3 of 8".
   */
  readonly attemptedItems: number;
  readonly stopReason?: ImportStopReason;
  readonly tombstone: TombstoneResult | null;
}

export interface ImportHandlerDeps {
  readonly control: SQL;
  readonly storage: TenantStorage;
  readonly rawStore: RawStore;
  readonly profile: NamedProfile;
  /** Opens the tenant's database and gateway. Closed again by {@link closeTenant}. */
  readonly openTenant: (tenantId: string) => Promise<TenantRuntime>;
  readonly closeTenant?: (runtime: TenantRuntime) => Promise<void>;
  /**
   * Rebuild what the manifest names: parse the stored export, or re-scan the
   * folder root. Injected because only the caller knows how to reach a root,
   * and because a resumed import should see the source as it is *now*.
   */
  readonly materialize: (
    manifest: DeferredImport,
    tenant: TenantRuntime,
  ) => Promise<ImportMaterial>;
  readonly priceBook?: PriceBook;
}

/** Which ingest-log code a write-path refusal is. A code, never a message. */
function failureCodeFor(reason: WriteFailureReason): IngestFailureCode {
  switch (reason) {
    case 'embed_failed':
    case 'tenant_not_configured':
      return 'provider_error';
    default:
      return 'parse_failed';
  }
}

const EMPTY_COUNTS: ImportCounts = {
  written: 0,
  unchanged: 0,
  quarantined: 0,
  failed: 0,
  tombstoned: 0,
};

interface MutableCounts {
  written: number;
  unchanged: number;
  quarantined: number;
  failed: number;
  tombstoned: number;
}

export async function runImport(request: ImportRunRequest): Promise<ImportRunResult> {
  const { tenant, material } = request;

  // The run row opens first, so a refusal is recorded in the ingest log rather
  // than being invisible to the operator asking why nothing imported. Opening it
  // also sweeps this source's wreckage — see `openRun`.
  const run = await openRun(tenant.sql, {
    originContext: request.originContext,
    sourceType: request.sourceType,
  });

  const counts: MutableCounts = { ...EMPTY_COUNTS };
  let attemptedItems = 0;
  let widen: { readonly excludedItems: number; readonly windowDays: number | null } = {
    excludedItems: 0,
    windowDays: null,
  };

  const stop = async (
    stopReason: ImportStopReason,
    failureCode: IngestFailureCode,
    decision: GateDecision | null,
    estimate: ImportEstimate | null,
  ): Promise<ImportRunResult> => {
    await finishRun(tenant.sql, run.ingestId, { outcome: 'failed', failureCode });
    return {
      outcome: 'stopped',
      runId: run.ingestId,
      decision,
      estimate,
      widen,
      counts: { ...counts },
      attemptedItems,
      stopReason,
      tombstone: null,
    };
  };

  try {
    // ------------------------------------------------------------------
    // 1. Preservation, before the gate.
    //
    // A deferred import resumes hours later, by which time the user's export
    // file may be gone. Banking the bytes after a successful import would make
    // the deferral a promise the fleet cannot keep — and a failed preservation
    // is a stop, never a warning, because pages that can never be re-derived
    // are indistinguishable from the ones that can.
    // ------------------------------------------------------------------
    if (material.raw != null) {
      const key = rawKeyFor(request.storage, tenant.caller, tenant.tenantId, material.raw.id);
      if (!key.ok) return await stop('raw_unavailable', 'provider_error', null, null);
      try {
        await request.rawStore.put(key.key, material.raw.object);
      } catch {
        return await stop('raw_unavailable', 'provider_error', null, null);
      }
    }

    // ------------------------------------------------------------------
    // 2. One item set, used by the estimate and by the loop.
    // ------------------------------------------------------------------
    const candidates = material.items.map((item) => ({
      externalRef: item.externalRef,
      contentSha256: contentDigest(item.title, item.body),
      occurredAt: item.occurredAt,
      characters: item.body.length,
    }));
    const selection = selectWindow(candidates, {
      now: request.now,
      ...(request.window === undefined ? {} : { window: request.window }),
    });
    widen = { excludedItems: selection.excluded.length, windowDays: selection.windowDays };

    const selected = new Set(selection.selected.map((candidate) => candidate.externalRef));
    const items = material.items.filter((item) => selected.has(item.externalRef));

    // ------------------------------------------------------------------
    // 3. The gate — unless this run is a resumed deferral, which was gated
    //    when it was enqueued. Re-gating would re-read a counter the first
    //    pass already moved.
    // ------------------------------------------------------------------
    let decision: GateDecision | null = null;
    let estimate: ImportEstimate | null = null;
    let approvedMicroUsd: number;

    if (request.approvedMicroUsd !== undefined) {
      approvedMicroUsd = request.approvedMicroUsd;
    } else {
      const outcome = await estimateImport({
        sql: tenant.sql,
        profile: request.profile,
        candidates: selection.selected,
        ...(request.priceBook === undefined ? {} : { priceBook: request.priceBook }),
      });
      if (!outcome.ok) {
        return await stop('model_not_priced', 'provider_error', null, null);
      }
      estimate = outcome.estimate;

      decision = await gateFirstImport({
        control: request.control,
        tenantId: tenant.tenantId,
        target: request.target,
        estimate,
        now: request.now,
        ...(request.queue === undefined ? {} : { queue: request.queue }),
        ...(request.inlineItemCeiling === undefined
          ? {}
          : { inlineItemCeiling: request.inlineItemCeiling }),
        ...(request.inlineSpendCeiling === undefined
          ? {}
          : { inlineSpendCeiling: request.inlineSpendCeiling }),
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
      });

      if (decision.proceed === 'refused') {
        await finishRun(tenant.sql, run.ingestId, {
          outcome: 'failed',
          failureCode: decision.reason === 'cap_exhausted' ? 'budget_exhausted' : 'cancelled',
        });
        return {
          outcome: 'refused',
          runId: run.ingestId,
          decision,
          estimate,
          widen,
          counts: { ...counts },
          attemptedItems,
          tombstone: null,
        };
      }

      if (decision.proceed === 'deferred') {
        const key = manifestKeyFor(request.storage, tenant.caller, tenant.tenantId, decision.jobId);
        if (!key.ok) return await stop('raw_unavailable', 'provider_error', decision, estimate);

        const manifest: DeferredImport = {
          tenantId: tenant.tenantId,
          target: request.target,
          originContext: request.originContext,
          sourceType: request.sourceType,
          window: request.window ?? { days: DEFAULT_WINDOW_DAYS },
          ...(request.resumeWith?.rawKey === undefined ? {} : { rawKey: request.resumeWith.rawKey }),
          ...(request.resumeWith?.rootId === undefined ? {} : { rootId: request.resumeWith.rootId }),
          approvedMicroUsd: decision.approvedMicroUsd,
        };
        try {
          await writeManifest(request.rawStore, key.key, manifest);
        } catch {
          return await stop('raw_unavailable', 'provider_error', decision, estimate);
        }

        await finishRun(tenant.sql, run.ingestId, { outcome: 'ok' });
        return {
          outcome: 'deferred',
          runId: run.ingestId,
          decision,
          estimate,
          widen,
          counts: { ...counts },
          attemptedItems,
          tombstone: null,
        };
      }

      approvedMicroUsd = decision.approvedMicroUsd;
    }

    // ------------------------------------------------------------------
    // 4. **One** budget, from the approved amount, for the whole run.
    //
    // This line is the gate. A fresh budget per item, or an uncapped one, and
    // every assertion about the ceiling above becomes decoration.
    // ------------------------------------------------------------------
    const budget = createBudget({
      label: request.budgetLabel ?? `import:${request.target}`,
      capMicroUsd: approvedMicroUsd,
    });

    // ------------------------------------------------------------------
    // 5. What the source could not produce. Counted on the run row, because
    //    nothing else will: U4's counter only advances for what it accepted.
    //
    //    A failure with no id gets no item row. `external_ref IS NULL` is what
    //    makes a row a *run* row, so an anonymous item row would masquerade as
    //    a second run and double every staleness number for this source.
    // ------------------------------------------------------------------
    for (const failure of material.failures) {
      counts.failed += 1;
      await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
      if (failure.externalRef !== null) {
        await recordItem(tenant.sql, {
          originContext: request.originContext,
          sourceType: request.sourceType,
          externalRef: failure.externalRef,
          disposition: 'failed',
          failureCode: failure.reason,
        });
      }
    }

    // ------------------------------------------------------------------
    // 6. The items.
    // ------------------------------------------------------------------
    let stopReason: ImportStopReason | undefined;

    for (const item of items) {
      attemptedItems += 1;
      const receipt = await ingestDocument(
        {
          sql: tenant.sql,
          gateway: tenant.gateway,
          tenantId: tenant.tenantId,
          caller: tenant.caller,
          budget,
        },
        {
          originContext: request.originContext,
          sourceType: request.sourceType,
          title: item.title,
          body: item.body,
          externalRef: item.externalRef,
          ingestId: run.ingestId,
        },
      );

      if (!receipt.ok) {
        if (receipt.reason === 'embed_failed' && receipt.detail === 'budget_exhausted') {
          // Stop. Iterating the remaining items to collect one identical
          // refusal each is the same defect wearing a loop, and it fills the
          // ingest log with a wall of noise. Resuming costs nothing for what
          // was already written, so a hard stop loses no work.
          stopReason = 'budget_exhausted';
          break;
        }
        counts.failed += 1;
        await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
        await recordItem(tenant.sql, {
          originContext: request.originContext,
          sourceType: request.sourceType,
          externalRef: item.externalRef,
          disposition: 'failed',
          failureCode: failureCodeFor(receipt.reason),
        });
        continue;
      }

      const disposition = receipt.status === 'unchanged' ? 'unchanged' : 'written';
      if (disposition === 'unchanged') counts.unchanged += 1;
      else counts.written += 1;

      await recordItem(tenant.sql, {
        originContext: request.originContext,
        sourceType: request.sourceType,
        externalRef: item.externalRef,
        disposition,
      });
    }

    // ------------------------------------------------------------------
    // 7. The chunk pass — the one the estimate priced.
    //
    // U4 defers chunk embedding by design, so a runner that only writes pages
    // spends almost nothing and the gate would be bounding a pass that never
    // happens. Drained under the same budget, so the approval covers what the
    // estimate measured.
    //
    // The backlog is a query over the rows rather than this run's own list, so
    // this may finish chunks another writer deferred. That is correct — the
    // work has to happen — and it is stated because it means a paced import can
    // spend its ceiling on someone else's backlog.
    // ------------------------------------------------------------------
    if (stopReason === undefined) {
      const backlog = await runChunkEmbedBacklog({
        sql: tenant.sql,
        gateway: tenant.gateway,
        tenantId: tenant.tenantId,
        caller: tenant.caller,
        budget,
      });
      if (backlog.failure === 'budget_exhausted') stopReason = 'budget_exhausted';
    }

    // ------------------------------------------------------------------
    // 8. Deletion reconciliation. Runs whether or not the budget held: it
    //    costs no provider call, and a corpus that stopped importing should
    //    still stop answering with files that are gone.
    // ------------------------------------------------------------------
    let tombstone: TombstoneResult | null = null;
    if (material.tombstone != null) {
      tombstone = await tombstoneMissing(tenant.sql, material.tombstone);
      counts.tombstoned = tombstone.tombstoned;
      for (const externalRef of tombstone.externalRefs) {
        await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
        await recordItem(tenant.sql, {
          originContext: request.originContext,
          sourceType: request.sourceType,
          externalRef,
          disposition: 'tombstoned',
        });
      }
    }

    if (stopReason !== undefined) {
      await finishRun(tenant.sql, run.ingestId, {
        outcome: 'failed',
        failureCode: 'budget_exhausted',
      });
      return {
        outcome: 'stopped',
        runId: run.ingestId,
        decision,
        estimate,
        widen,
        counts: { ...counts },
        attemptedItems,
        stopReason,
        tombstone,
      };
    }

    await finishRun(tenant.sql, run.ingestId, { outcome: 'ok' });
    return {
      outcome: 'completed',
      runId: run.ingestId,
      decision,
      estimate,
      widen,
      counts: { ...counts },
      attemptedItems,
      tombstone,
    };
  } catch (error) {
    // A run row left `running` makes U6 report an import in flight forever, so
    // an unexpected throw closes it on the way out — and then propagates,
    // because a swallowed exception is a job that reports success.
    await finishRun(tenant.sql, run.ingestId, {
      outcome: 'failed',
      failureCode: 'provider_error',
    });
    throw error;
  }
}

/**
 * The `import` job kind's handler.
 *
 * Exported and not wired: `src/worker/` is U10's, and the handler map is
 * assembled where the fleet is composed. What this owns is the resume path —
 * find the manifest by the lease's own job id, rebuild the material, and run
 * under the cap the gate already approved.
 *
 * It never touches the queue. U10's runner completes or fails the job around
 * this call, and a handler that also wrote job state would be a second writer
 * outside the fence.
 */
export function createImportHandler(
  deps: ImportHandlerDeps,
): (context: JobContext) => Promise<void> {
  return async (context: JobContext): Promise<void> => {
    const { lease } = context;
    if (!isImportTarget(lease.target)) {
      throw new Error(`import handler claimed a job targeting '${lease.target}'`);
    }

    const tenant = await deps.openTenant(lease.tenantId);
    try {
      const key = manifestKeyFor(deps.storage, tenant.caller, tenant.tenantId, lease.jobId);
      if (!key.ok) throw new Error(`no manifest key for job ${lease.jobId}: ${key.reason}`);

      const manifest = await readManifest(deps.rawStore, key.key);
      // Not a silent success: a job whose manifest is missing has no approved
      // ceiling, and running it without one is the ungated import this whole
      // unit exists to prevent.
      if (manifest === null) throw new Error(`deferred import ${lease.jobId} has no manifest`);

      const material = await deps.materialize(manifest, tenant);

      await runImport({
        tenant,
        control: deps.control,
        storage: deps.storage,
        rawStore: deps.rawStore,
        profile: deps.profile,
        originContext: manifest.originContext,
        sourceType: manifest.sourceType,
        target: manifest.target,
        material,
        now: context.now,
        window: manifest.window,
        approvedMicroUsd: manifest.approvedMicroUsd,
        jobId: lease.jobId,
        budgetLabel: `import:${manifest.target}:${lease.jobId}`,
        ...(deps.priceBook === undefined ? {} : { priceBook: deps.priceBook }),
      });
    } finally {
      await deps.closeTenant?.(tenant);
    }
  };
}

export type { JobLease };
