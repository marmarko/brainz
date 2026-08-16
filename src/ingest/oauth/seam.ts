/**
 * U18 §5 — the connector-auth seam, and the exit ramp from the vendor.
 *
 * ============================================================================
 * WHAT IS ALREADY A SEAM, AND WHAT IS NOT
 * ============================================================================
 *
 * `src/ingest/pipedream/sources/types.ts` already made a *provider* pluggable:
 * "the Phase 5 own-OAuth swap and Assumption 1's MBOX fallback are each a new
 * implementation of `ProviderSource` rather than a change to the pull runner.
 * Nothing above this interface knows what Gmail is." That half is done, and this
 * unit does not touch it — **the adapters stay**.
 *
 * What has no seam is the *obtaining*. `pull.ts` reaches `pipedream/client.ts`
 * directly, so who holds the OAuth grant is a fact hard-wired into the ingest
 * path rather than a choice. R16 names this as the exit ramp; this file is it.
 *
 * ============================================================================
 * THREE METHODS, AND EACH ONE IS A CONSEQUENCE
 * ============================================================================
 *
 *   * `apiFor` — the {@link ProviderApi} a source adapter calls. Narrow on
 *     purpose: an adapter that could reach the connect-token mint would have
 *     bound itself to the vendor, which is the thing this seam exists to undo.
 *   * `revoke` — hand back one source's grant. Today the user's "disconnect".
 *   * `deleteExternalUser` — **R12's fourth erasure leg**, and the reason this
 *     port has three methods rather than one.
 *
 * **The erasure leg is the constraint that shapes the whole port.** U17's
 * account-erasure runbook has five legs and the fourth is "Pipedream external-
 * user deletion with token revocation" — without it, live OAuth tokens to an
 * erased user's mailbox persist at a vendor inside the trust boundary and "no
 * queryable trace" is false. If brainz starts holding its own refresh tokens,
 * that leg has to cover them **on the day the swap happens**, not in a follow-up.
 *
 * So the runbook's leg calls this port rather than Pipedream directly: one leg,
 * two implementations, **no sixth store**. A design where own-OAuth tokens lived
 * somewhere the runbook did not know about would be the same failure U17 already
 * paid for once, with a different vendor name on it.
 *
 * ============================================================================
 * THE SWAP PATH, AND WHY IT IS ORDERED THIS WAY
 * ============================================================================
 *
 * A source moves to brainz's own OAuth only when **both** hold:
 *
 *   1. the source is marked **certified** in fleet config, and
 *   2. this tenant has an own-OAuth grant for it.
 *
 * Order matters. Certification is a fleet fact and the tenant grant is a tenant
 * fact, and putting the fleet fact first is what makes the cutover **reversible
 * without touching a single tenant row**: un-mark the source and every tenant
 * moves back to the vendor on their next pull. A design keyed on the tenant row
 * alone would need a fleet-wide write to roll back — during the incident that
 * made you want to.
 *
 * Anything else is Pipedream. That is the default, and it stays the default
 * until CASA clears (§5.1 of the re-plan): the assessment is what lets brainz's
 * own Google app request Gmail's restricted scopes at all, it is a 3–4 week
 * external process with an invoice and an annual renewal, and **this unit starts
 * none of it and registers no OAuth application.** {@link ownOAuthOf} therefore
 * refuses with a typed reason naming exactly what is missing, rather than
 * pretending to have a client it does not have.
 */

import type {
  ClientOutcome,
  ExternalUserDeletion,
  ProviderApi,
  ProviderRequest,
} from '../pipedream/client.ts';
import type { ConnectorSource } from '../cursor.ts';

/**
 * Who holds the grant for one tenant's one source.
 *
 * The vendor-shaped methods only. Nothing here knows what Gmail is, and nothing
 * here mints a connect link — that is the web app's flow (U15) and it is
 * vendor-specific by nature.
 */
export interface ConnectorAuth {
  /** Which implementation answered, for a receipt that has to name it. */
  readonly provider: AuthProvider;
  /** The API surface a source adapter calls. */
  apiFor(request: { readonly tenantId: string; readonly source: ConnectorSource }): ProviderApi;
  /** Hand back one source's grant. The user's "disconnect". */
  revoke(request: {
    readonly tenantId: string;
    readonly source: ConnectorSource;
  }): Promise<ClientOutcome<{ readonly revoked: boolean }>>;
  /**
   * R12's fourth erasure leg, whoever holds the tokens.
   *
   * Named for the *effect* rather than for Pipedream's noun, so the runbook's
   * fourth leg reads the same either side of the swap.
   */
  deleteExternalUser(request: {
    readonly tenantId: string;
  }): Promise<ClientOutcome<ExternalUserDeletion>>;
}

export const AUTH_PROVIDERS = ['pipedream', 'own_oauth'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/**
 * Why an own-OAuth call could not be made.
 *
 * A closed set rather than a string, because each one is a different *thing
 * somebody has to go and do* and flattening them into "not configured" is how a
 * four-week external dependency becomes a surprise in a launch week.
 */
export const OWN_OAUTH_BLOCKERS = [
  /** No Google/Microsoft OAuth application has been registered. This unit registers none. */
  'no_oauth_app',
  /**
   * The app exists but has not cleared CASA, so it may not request the
   * restricted scopes Gmail message bodies live behind.
   */
  'not_certified',
  /** The app is certified but this tenant has never granted through it. */
  'no_tenant_grant',
] as const;
export type OwnOAuthBlocker = (typeof OWN_OAUTH_BLOCKERS)[number];

export class OwnOAuthUnavailableError extends Error {
  readonly blocker: OwnOAuthBlocker;

  constructor(blocker: OwnOAuthBlocker, detail: string) {
    super(`brainz's own OAuth cannot serve this call (${blocker}): ${detail}`);
    this.name = 'OwnOAuthUnavailableError';
    this.blocker = blocker;
  }
}

/** What the fleet knows about the swap, per source. */
export interface SwapConfig {
  /**
   * Sources whose own-OAuth application has cleared certification.
   *
   * A **fleet** fact, checked first, so un-marking a source rolls every tenant
   * back without a tenant write. Empty until CASA clears.
   */
  readonly certifiedSources: readonly ConnectorSource[];
}

/** Whether this tenant has granted through brainz's own app for this source. */
export interface OwnGrantStore {
  has(request: {
    readonly tenantId: string;
    readonly source: ConnectorSource;
  }): Promise<boolean>;
}

/**
 * Which implementation serves one tenant's one source, and why.
 *
 * Returns the reason as well as the answer, so the decision is reportable: an
 * operator asking "why is this tenant still on the vendor" gets `not_certified`
 * or `no_tenant_grant` rather than a boolean.
 */
export async function resolveAuthProvider(
  config: SwapConfig,
  grants: OwnGrantStore,
  request: { readonly tenantId: string; readonly source: ConnectorSource },
): Promise<{ readonly provider: AuthProvider; readonly because: OwnOAuthBlocker | 'certified_and_granted' }> {
  // **Fleet fact first.** See the header: this ordering is what makes the
  // cutover reversible without touching a tenant row.
  if (!config.certifiedSources.includes(request.source)) {
    return { provider: 'pipedream', because: 'not_certified' };
  }
  if (!(await grants.has(request))) {
    return { provider: 'pipedream', because: 'no_tenant_grant' };
  }
  return { provider: 'own_oauth', because: 'certified_and_granted' };
}

/**
 * Today's implementation: the vendor, behind the port.
 *
 * **Observably identical to calling the client directly**, and that is the
 * requirement rather than an accident — a seam that changed behaviour on the day
 * it landed would make every later swap indistinguishable from a regression.
 * `test/ingest/oauth-seam.test.ts` pins it: the same `ProviderRequest` reaches
 * the same client method with the same arguments.
 */
export function pipedreamAuth(client: {
  request(request: ProviderRequest): Promise<ClientOutcome<unknown>>;
  deleteExternalUser(request: {
    readonly externalUserId: string;
  }): Promise<ClientOutcome<ExternalUserDeletion>>;
}): ConnectorAuth {
  return {
    provider: 'pipedream',
    apiFor() {
      // The vendor's external user id *is* the tenant id (U9), so there is
      // nothing to translate — and the adapter passes it on the request, which
      // is why this returns the client's own surface rather than wrapping it.
      return { request: (request) => client.request(request) };
    },
    revoke() {
      // Pipedream's disconnect is an account-level operation the web app drives
      // through its own vendor client (U15's `ConnectorVendor`), not something
      // the ingest path performs. Reported as such rather than silently
      // succeeding: a `revoke` that returned ok having done nothing is how a
      // disconnect comes to be believed.
      return Promise.resolve({
        ok: false as const,
        reason: 'provider_error' as const,
        status: null,
        detail: 'per-source revocation at this vendor is driven by the web app, not the ingest path',
      });
    },
    deleteExternalUser(request) {
      return client.deleteExternalUser({ externalUserId: request.tenantId });
    },
  };
}

/**
 * The own-OAuth implementation: structurally complete, deliberately inert.
 *
 * Every method refuses with a typed {@link OwnOAuthBlocker}. That is not a
 * placeholder — it is the honest state of a dependency that costs money and
 * three to four weeks, and a stub that returned plausible data would let a
 * caller be written against a client that does not exist and cannot be tested.
 *
 * What it *does* establish is the shape the real one must have, so the day CASA
 * clears the work is filling in three method bodies rather than designing a
 * seam: the token store it reads, the refresh contract it honours, and the fact
 * that its `deleteExternalUser` is the same erasure leg the vendor's is.
 */
export function ownOAuth(options: { readonly blocker?: OwnOAuthBlocker } = {}): ConnectorAuth {
  const blocker = options.blocker ?? 'no_oauth_app';
  const detail =
    blocker === 'no_oauth_app'
      ? 'no Google or Microsoft OAuth application is registered for brainz; U18 deliberately registers none'
      : blocker === 'not_certified'
        ? "the application has not cleared CASA, so it may not request Gmail's restricted scopes"
        : 'this tenant has never granted through the brainz application';

  const refuse = <T>(): Promise<ClientOutcome<T>> =>
    Promise.resolve({
      ok: false as const,
      reason: 'provider_error' as const,
      status: null,
      detail: new OwnOAuthUnavailableError(blocker, detail).message,
    });

  return {
    provider: 'own_oauth',
    apiFor() {
      return { request: () => refuse<unknown>() };
    },
    revoke: () => refuse<{ readonly revoked: boolean }>(),
    deleteExternalUser: () => refuse<ExternalUserDeletion>(),
  };
}

/**
 * The own-OAuth implementation for a given blocker, or the vendor.
 *
 * The one function a caller should use. It exists so that "which auth does this
 * pull run under" has exactly one answer in the codebase — the same reason
 * `grant-scope.ts:resolveGrant` is one function, and the same failure if it is
 * two.
 */
export async function ownOAuthOf(
  config: SwapConfig,
  grants: OwnGrantStore,
  vendor: ConnectorAuth,
  request: { readonly tenantId: string; readonly source: ConnectorSource },
): Promise<ConnectorAuth> {
  const resolved = await resolveAuthProvider(config, grants, request);
  if (resolved.provider === 'pipedream') return vendor;
  // Certified and granted, and still no client: this is the state after CASA
  // clears and before the client is written, and it refuses loudly rather than
  // falling back to the vendor — a silent fallback would make a failed cutover
  // indistinguishable from a successful one.
  return ownOAuth({ blocker: 'no_oauth_app' });
}
