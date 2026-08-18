/**
 * Stopping a connector's standing `ingest_pull` lane — the one statement, in the
 * one place, that both surfaces which need it call.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS: `dead` IS THE STATE WITH NO WAY OUT
 * ============================================================================
 *
 * `enqueueDuePulls` (`src/worker/connectors.ts`) treats a lane as standing when
 * it is `due`, `running` **or `dead`**, and enqueues nothing over it. Each
 * member is right on its own terms — a queued pull does not advance
 * `lastPullAt`, so without the anti-join every tick would issue an INSERT and be
 * told `already_open`, and a dead-lettered lane would be told `quarantined`
 * every minute for the rest of the tenant's life.
 *
 * Two of those three drain by themselves. `due` runs, `running` settles. **The
 * third does not, and nothing in `src/` cleared it.** `handleDisconnect` — the
 * only writer that stopped a lane — matched `('due', 'running')`, so a
 * dead-lettered row survived the disconnect, survived the reconnect after it,
 * and stood in the anti-join forever. The source was then never polled again by
 * anything: not by the cadence, not by a reconnect, not by a fixed fleet.
 *
 * That is how a bug in one HTTP request shape became permanent. A vendor request
 * built in a shape the vendor answers `404` to walked all three of one brain's
 * connectors to `dead` inside ten minutes; the corrected shape then deployed and
 * changed nothing, because nothing would ever ask again. The dashboard read
 * `failing` and the copy beside it said to disconnect and reconnect — the one
 * remedy that could not work, because the row that blocks the cadence outlives
 * both halves of it.
 *
 * ============================================================================
 * ONE STATEMENT, TWO CALLERS, AND WHY THEY ARE THE SAME STATEMENT
 * ============================================================================
 *
 * The user's disconnect and the operator's requeue want different things
 * afterwards — one is removing the connection, the other is keeping it — but
 * they want the identical thing here: *no lane for this source is left
 * standing*. Writing it twice is how the two drift, and the half that drifts is
 * always the rarely-exercised one. So the statement lives here and the callers
 * differ only in what they do next.
 *
 * **It discards rather than reviving.** The tempting shape is to flip the dead
 * row back to `due` with `attempts = 0`; this does not, and the reason is
 * `lease_token`. That column is the fence every worker write names, and a row
 * put back into circulation carrying a token some straggler may still believe it
 * holds is a fence that has stopped fencing. A discarded row leaves the
 * anti-join, the cadence enqueues a **new** job — new id, zero attempts, token
 * zero — and no fence is reused. It is also the transition `handleDisconnect`
 * already made, so this adds no state machine.
 *
 * **A settled row is history and is not rewritten.** `done` and `discarded` rows
 * are outside the match: they already left the anti-join, and moving them would
 * make every later reading of the queue report a disconnect that did not happen.
 *
 * **The target is checked against the connector vocabulary before the statement
 * runs.** `whole_brain` is a legal `control.job_target`, so a call that passed
 * its argument straight through could discard a tenant's consolidation or their
 * scheduled export through a connector-shaped door. The check is here rather
 * than in each caller for the same reason the statement is.
 */

import type { SQL } from 'bun';

import { isConnectorSource } from '../ingest/cursor.ts';

export interface DiscardConnectorLanesRequest {
  readonly tenantId: string;
  /** A connector source. Anything else is refused before a statement runs. */
  readonly source: string;
  readonly now: Date;
}

/**
 * Discard every standing `ingest_pull` lane for one tenant's one source.
 *
 * Returns the ids of the rows it moved, so a caller can report a count without
 * asking a second question — and so "it cleared nothing" is distinguishable from
 * "it cleared something", which is the difference between a source that was
 * stuck and one that was already fine.
 */
export async function discardConnectorLanes(
  sql: SQL,
  request: DiscardConnectorLanesRequest,
): Promise<readonly string[]> {
  if (!isConnectorSource(request.source)) {
    // Named without echoing the argument: this statement is reached from an
    // operator surface whose whole property is that no word a caller wrote comes
    // back out of it.
    throw new Error('discardConnectorLanes: target is not a connector source');
  }

  const rows = (await sql`
    UPDATE control.job
       SET state = 'discarded',
           finished_at = ${request.now},
           updated_at = ${request.now},
           -- The lease columns go with the state. A row left carrying an owner
           -- and an expiry reads as claimed to every later query, including the
           -- operator's own status read.
           lease_owner = NULL,
           lease_expires_at = NULL,
           attempt_deadline_at = NULL
     WHERE tenant_id = ${request.tenantId}
       AND kind = 'ingest_pull'
       AND target = ${request.source}::control.job_target
       AND state IN ('due', 'running', 'dead')
    RETURNING job_id::text AS job_id`) as Array<{ job_id: string }>;

  return rows.map((row) => row.job_id);
}
