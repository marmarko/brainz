/**
 * Reconciliation — how an authorization completed at the vendor becomes a
 * connection this brain polls.
 *
 * ============================================================================
 * THE DEFECT THIS CLOSES, AND WHY THE BROWSER COULD NOT CLOSE IT
 * ============================================================================
 *
 * `connectSource` (`src/ingest/cursor.ts`) had no production caller. The web app
 * minted a real connect link, the user authorized at Google, and nothing in this
 * fleet was ever told: no `ConnectorState` was written, `enqueueDuePulls` read
 * nothing, no `ingest_pull` was ever queued, and an attached mailbox was
 * invisible here forever.
 *
 * The obvious fix is a return URL, and it is the one that quietly loses
 * authorizations. **The user leaves this origin for the vendor's consent screen
 * and owes us nothing afterwards** — they can close the tab, follow a link out,
 * or lose the network on the way back. A design whose only channel is the
 * browser coming home records the connections of the users who happened to come
 * home, and the ones who did not are attached at the vendor, billed by the
 * vendor, and dark here.
 *
 * So the channel is **the vendor's own account listing**, asked for by this
 * fleet rather than reported to it:
 *
 *     GET /connect/{project}/accounts?external_user_id=<tenant>-<source>
 *
 * That call was checked against the live vendor rather than assumed (it answers
 * `200` with an empty `data` array for an external user that has attached
 * nothing, which is what every user still on the consent screen looks like).
 * Asking has three properties a callback does not: it survives a closed tab, it
 * is idempotent, and it is the only design that can *self-heal* — a state that
 * drifted, a callback that was lost, a container that died mid-write all
 * converge on the next pass.
 *
 * ============================================================================
 * WHAT BOUNDS THE ASKING: THE PENDING LINK
 * ============================================================================
 *
 * Reconciliation is not a sweep of every tenant against the vendor. Three
 * sources times every ready tenant, every tick, would be a vendor bill and a
 * rate budget spent on people who have never pressed the button.
 *
 * What bounds it is the **intent the user already expressed**: pressing
 * "connect gmail" mints a link, and minting a link records a pending link in the
 * control plane before the user leaves. Reconciliation asks about pending links
 * and nothing else, and a pending link expires — a user who abandoned the
 * consent screen stops being asked about. The intent is recorded *before* the
 * user leaves precisely because that is the last moment this side is guaranteed
 * to see.
 *
 * ============================================================================
 * THREE RULINGS, AND EACH IS A HAZARD RATHER THAN A PREFERENCE
 * ============================================================================
 *
 * **1. It creates, and it never overwrites.** `ConnectorState` carries the
 * cursor. A reconciler that wrote a fresh state over a live one would reset that
 * cursor to `null`, and `pullModeFor` would answer `backfill` — a full re-list
 * of a mailbox already held, which is both the spend and the duplicate-content
 * failure. Create-only is enforced *in the store's own statement*
 * (`state IS NULL` in the compare-and-set), not by a check here, so a second
 * pass cannot reset a cursor even if this module is wrong.
 *
 * **2. The tier is asked before the vendor is.** `connectorGate` refuses a free
 * account at the button because each connected account carries a monthly vendor
 * fee whether or not the brain is used. A reconciler that wrote state for a
 * source the tier no longer permits would re-enable that fee — and the polling
 * behind it — for an account that stopped paying, silently, from a background
 * tick. Asked *first*, so a downgraded tenant costs a vendor call as well as a
 * connection.
 *
 * What this ruling does NOT do, said plainly rather than left to be discovered:
 * a tenant that was paid when it connected and is free now keeps the state it
 * already has, and keeps polling. Reconciliation is additive, so it is not the
 * place that can stop it — removal has exactly one door (see 3), and wiring a
 * tier lapse into that door is a billing decision with its own owner. This
 * module refuses to *create*; it does not pretend to be a subscription enforcer.
 *
 * **3. Disconnect wins every race, and the mechanism is a fence rather than an
 * ordering.** `handleDisconnect` clears the state and bumps a monotonic fence
 * before it tells the vendor anything. A reconciliation pass reads the fence
 * with the pending link, spends a vendor round trip, and writes under the fence
 * it read; the store's statement refuses a write whose fence has moved. So the
 * interleaving that would otherwise re-add a connection the user just removed —
 * read the listing, disconnect, write — cannot commit, and the reconciler does
 * not retry: a retry is the same bug with a longer window.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================
 *
 * **It never removes.** An empty listing for a source that already has state is
 * not read as "disconnect this" — it is read as nothing at all. A grant revoked
 * at Google surfaces as `auth_expired` on the next pull, which dead-letters the
 * lane where an operator and the dashboard can both see it; a reconciler that
 * deleted state on an empty listing would answer a vendor hiccup by discarding a
 * cursor, and the recovery from that is a full re-import of somebody's mailbox.
 *
 * **It claims nothing about whose mailbox it is.** See
 * {@link import('./client.ts').ConnectedAccount}.
 */

import {
  APP_FOR_SOURCE,
  externalUserIdFor,
  type ConnectedAccount,
  type ClientOutcome,
  type PipedreamClient,
} from './client.ts';
import { connectSource, type ConnectorSource, type ConnectorState } from '../cursor.ts';

/**
 * A connect the user asked for and that has not produced a connection yet, plus
 * the fence it was read under.
 *
 * The fence travels with the link rather than being re-read at write time, and
 * that is the whole of ruling 3: a value re-read after the vendor round trip
 * would already include the disconnect this pass has to lose to.
 */
export interface PendingLink {
  readonly tenantId: string;
  readonly source: ConnectorSource;
  /** The disconnect fence as it stood when this link was read. */
  readonly fence: number;
}

/** The vendor half: what is attached under this tenant's per-source external user. */
export interface ConnectorAccountLister {
  accountsFor(request: {
    readonly tenantId: string;
    readonly source: ConnectorSource;
  }): Promise<ClientOutcome<readonly ConnectedAccount[]>>;
}

/**
 * The store half, narrowed to one method on purpose.
 *
 * Reconciliation can create a connection and can do nothing else — it cannot
 * read one back, cannot advance a cursor and cannot remove a link. That is the
 * same narrowing `ProviderKeyWriter` applies to BYOK, applied to the surface
 * where a background pass writes on a user's behalf.
 */
export interface ConnectorLinkWriter {
  /**
   * Write this state **if** the link is still absent and the fence has not
   * moved. `false` means somebody else got there first — a disconnect, or
   * another instance's tick.
   */
  adopt(request: {
    readonly tenantId: string;
    readonly source: ConnectorSource;
    readonly fence: number;
    readonly state: ConnectorState;
  }): Promise<boolean>;
}

/**
 * Which tier this tenant is on, from the control plane's own column.
 *
 * `control.tenant.tier` rather than the account's subscription row: the worker
 * fleet holds no identity database, `applyBillingEvent` writes both halves of a
 * tier transition, and a reconciler whose answer depended on which fleet was
 * asking would be two rulings wearing one name.
 */
export interface ConnectorTierReader {
  tierFor(tenantId: string): Promise<'free' | 'paid' | 'internal'>;
}

export type ReconcileRefusal =
  /** The tier does not permit a connected account. Asked before the vendor is. */
  | 'tier_forbidden'
  /** Nothing attached yet — the ordinary answer while a user is mid-consent. */
  | 'no_account'
  /** More than one live account and no order between them. Never guessed. */
  | 'ambiguous_accounts'
  /** The vendor would not answer. This link is left pending for the next pass. */
  | 'vendor_error'
  /** The compare-and-set lost: a disconnect, or another instance, got there. */
  | 'superseded';

export interface ReconcileResult {
  /** Links that reached the vendor. Below the pending count by the tier refusals. */
  readonly asked: number;
  readonly adopted: readonly { readonly tenantId: string; readonly source: ConnectorSource }[];
  readonly refused: readonly {
    readonly tenantId: string;
    readonly source: ConnectorSource;
    readonly reason: ReconcileRefusal;
  }[];
}

export type AccountChoice =
  | { readonly ok: true; readonly account: ConnectedAccount }
  | { readonly ok: false; readonly reason: 'no_account' | 'ambiguous_accounts' };

/**
 * Which of a listing's accounts this source's connection is — exported so the
 * rule is testable without a vendor standing in front of it.
 *
 * **Dead accounts are dropped first, and that ordering matters.** A user who
 * revoked at Google and reconnected has an old dead grant beside a new live one;
 * treating both as candidates would refuse exactly the person who just fixed
 * their connection.
 *
 * **A named app that is not this source's is dropped too.** The external user id
 * is per source, so this should not arise — but the vendor's connect token is
 * *not* app-scoped, so a user genuinely can attach Gmail through the link that
 * opened on Calendar. Adopting it would point the calendar adapter at a mailbox
 * and dead-letter the lane with a provider error nobody can act on. An app the
 * listing does not name is accepted, because the id it was asked under is
 * already the binding and refusing on a missing field would un-connect every
 * user the day the vendor renames one.
 *
 * **Two live accounts resolve to the newest, and only when they can be
 * ordered.** `ConnectorState` holds one account id; the newest is the last thing
 * the user did. If any candidate carries no usable timestamp there is no order,
 * and a coin flip between two mailboxes is not a thing to do with somebody's
 * mail — so it refuses and says so.
 */
export function chooseAccount(
  source: ConnectorSource,
  accounts: readonly ConnectedAccount[],
): AccountChoice {
  const wanted = APP_FOR_SOURCE[source];
  const candidates = accounts.filter(
    (candidate) => !candidate.dead && (candidate.appSlug === null || candidate.appSlug === wanted),
  );

  if (candidates.length === 0) return { ok: false, reason: 'no_account' };
  const only = candidates[0] as ConnectedAccount;
  if (candidates.length === 1) return { ok: true, account: only };

  const dated = candidates.map((candidate) => ({
    candidate,
    at: candidate.createdAt === null ? Number.NaN : Date.parse(candidate.createdAt),
  }));
  if (dated.some((entry) => Number.isNaN(entry.at))) {
    return { ok: false, reason: 'ambiguous_accounts' };
  }

  let newest = dated[0] as { candidate: ConnectedAccount; at: number };
  for (const entry of dated) if (entry.at > newest.at) newest = entry;
  return { ok: true, account: newest.candidate };
}

export interface ReconcileDeps {
  readonly vendor: ConnectorAccountLister;
  readonly links: ConnectorLinkWriter;
  readonly tiers: ConnectorTierReader;
}

export interface ReconcileOptions {
  readonly pending: readonly PendingLink[];
  readonly now: Date;
}

/**
 * Ask the vendor about every pending link, and write the ones it confirms.
 *
 * Sequential rather than concurrent: the client's rate budget is per project and
 * shared across the fleet, so a parallel fan-out here would spend a ceiling that
 * the pull lane also has to fit inside — and reconciliation is never the thing a
 * user is waiting on.
 *
 * Nothing throws out of a single link. One tenant's vendor failure must not stop
 * the pass for the rest of the fleet, which is `enqueueDuePulls`'s own rule for
 * an unreadable state, and the refusal list is what tells an operator it is
 * happening.
 */
export async function reconcileConnectors(
  deps: ReconcileDeps,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const adopted: { tenantId: string; source: ConnectorSource }[] = [];
  const refused: { tenantId: string; source: ConnectorSource; reason: ReconcileRefusal }[] = [];
  let asked = 0;

  for (const link of options.pending) {
    const { tenantId, source } = link;

    // The tier, before the vendor. See ruling 2.
    const tier = await deps.tiers.tierFor(tenantId);
    if (tier === 'free') {
      refused.push({ tenantId, source, reason: 'tier_forbidden' });
      continue;
    }

    asked += 1;
    const listing = await deps.vendor.accountsFor({ tenantId, source });
    if (!listing.ok) {
      refused.push({ tenantId, source, reason: 'vendor_error' });
      continue;
    }

    const chosen = chooseAccount(source, listing.value);
    if (!chosen.ok) {
      refused.push({ tenantId, source, reason: chosen.reason });
      continue;
    }

    // **`connectSource`, not a literal.** It is the constructor that decides a
    // fresh connection has no cursor, no banked approval and no last pull — the
    // shape `pullModeFor` reads as `backfill` and the first-import gate
    // therefore still sees. A state assembled here would be a second opinion
    // about that, and the one that skipped the gate would re-list a mailbox at
    // full price.
    const state = connectSource({
      source,
      externalUserId: externalUserIdFor(tenantId, source),
      accountId: chosen.account.accountId,
      // Not observed here, and null is the honest value. See `ConnectedAccount`.
      accountKey: null,
      // The connect flow does not ask which half of the brain this belongs to,
      // so no answer is recorded. `ConnectorState.contextClass` says why null is
      // the honest default and why it is not `personal`.
      contextClass: null,
      now: options.now,
    });

    const won = await deps.links.adopt({ tenantId, source, fence: link.fence, state });
    if (!won) {
      // Lost to a disconnect or to another instance. Not retried — see ruling 3.
      refused.push({ tenantId, source, reason: 'superseded' });
      continue;
    }
    adopted.push({ tenantId, source });
  }

  return { asked, adopted, refused };
}

// ---------------------------------------------------------------------------
// The two adapters, and the object both fleets actually hold.
// ---------------------------------------------------------------------------

/**
 * The vendor port over the real client.
 *
 * **The external user id is derived here and nowhere else in this lane**, from
 * `externalUserIdFor`, which is the function that makes it per source. A caller
 * that passed its own string would be the one place a tenant-wide id could
 * appear, and `deleteExternalUser` — the only revocation this vendor offers —
 * destroys exactly what an external user id spans.
 */
export function createPipedreamAccountLister(client: PipedreamClient): ConnectorAccountLister {
  return {
    accountsFor(request) {
      return client.listAccounts({
        externalUserId: externalUserIdFor(request.tenantId, request.source),
      });
    },
  };
}

/** Where the pending links come from. The control plane's, in both fleets. */
export interface PendingLinkSource {
  pending(request: {
    readonly now: Date;
    readonly tenantId?: string;
    readonly limit?: number;
  }): Promise<readonly PendingLink[]>;
}

/**
 * One reconciliation pass, ready to be called by whoever has a reason to.
 *
 * **Two callers, deliberately, because neither alone answers the founder's
 * question.** The worker fleet's tick is the one that does not depend on the
 * user ever coming back — it is what makes a closed tab converge — but the
 * worker sleeps and is woken on a half-hourly cron, so it is slow. A dashboard
 * load is immediate and is exactly where somebody who *did* come back is
 * standing, but it can only ever serve the users who return. Running both means
 * the answer to "I authorized, how long until my mail appears?" is *at once if
 * you come back to the page, and within about half an hour if you never do*.
 *
 * Scoping by tenant is what makes the dashboard call cheap: a page render asks
 * the vendor about that user's own unfinished connects and about nothing else,
 * and about nothing at all in the overwhelmingly common case where they have
 * none.
 */
export interface ConnectorReconciler {
  run(options: {
    readonly now: Date;
    /** One tenant's pending links, for a page render. Absent means the fleet's. */
    readonly tenantId?: string;
    readonly limit?: number;
  }): Promise<ReconcileResult>;
}

export function createConnectorReconciler(deps: {
  readonly links: ConnectorLinkWriter & PendingLinkSource;
  readonly vendor: ConnectorAccountLister;
  readonly tiers: ConnectorTierReader;
}): ConnectorReconciler {
  return {
    async run(options) {
      const pending = await deps.links.pending({
        now: options.now,
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      // The early return is not an optimisation, it is the bound: a fleet where
      // nobody is mid-connect must reach the vendor zero times per tick.
      if (pending.length === 0) return { asked: 0, adopted: [], refused: [] };
      return await reconcileConnectors(deps, { pending, now: options.now });
    },
  };
}
