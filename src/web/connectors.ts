/**
 * The connector vendor, as the web app's port over U9's Pipedream client.
 *
 * **The defect this closes.** `src/ingest/pipedream/client.ts` is complete —
 * the Connect client, the OAuth mint, the per-project rate budget, the three
 * source adapters, the tombstone semantics, the erasure call — and
 * `createPipedreamClient` had **zero constructors anywhere in `src/`**. What
 * stood in its place was a `ConnectorVendor` whose two methods threw a bare
 * `Error` from inside a request handler, so `/api/connectors` answered a
 * stack-traced 500 to the one user who had paid to reach it. This module is the
 * adapter; `src/web/serve.ts` is where it is built from the deployment's own
 * credentials, and the choice of *whether* to build one is made there.
 *
 * **The claim URL is the vendor's connect link, and that is a decision rather
 * than a shortcut.** `client.ts` also carries a claim-URL scheme of its own —
 * `mintClaimUrl`, `redeemClaimUrl`, a single-use record with the secret in the
 * fragment — and it is deliberately not used here. It needs two things this
 * deployment does not have: a durable {@link import('../ingest/pipedream/client.ts').ClaimStore}
 * (the only implementation is in-memory, and a per-container capability store is
 * the failure the durable secret store was built to end) and a
 * `/connect/claim/:id` route that can read a fragment, which no surface in
 * `src/web/` serves. A capability minted into a store that dies with the
 * instance is a link that attaches nothing and reports that it did.
 *
 * What `mintConnectToken` answers **is** the capability the port describes:
 * short-TTL, bound to this tenant's external user at the vendor, and enough on
 * its own for whoever holds it to attach *their* Google account to *this*
 * brain. So it is returned once, to the authenticated owner, and never logged —
 * the same handling `app.ts` already gives the field.
 *
 * **One consequence is worth naming rather than discovering.**
 * `CLAIM_URL_PATTERN` and `redactClaimUrls` match brainz-minted claim URLs, so
 * they do not cover a vendor-hosted link: a connect link pasted into a
 * transcript that U8 later re-ingests is not redacted by that pattern. The TTL
 * is the control that remains, and it is the vendor's rather than ours.
 *
 * **Failures throw, typed, carrying a code and nothing else.** That is
 * `reportedNeon`'s shape one vendor over, and for the same reason: the port
 * `app.ts` declares has no failure channel, an error object is the most
 * casually-logged thing in any system, and a vendor body may quote a request
 * that carried a credential. {@link ConnectorVendorError} holds an operation, a
 * reason code and a status; the entrypoint's error boundary turns it into a
 * generic 500 for the user and one structured line for the operator.
 */

import {
  APP_FOR_SOURCE,
  externalUserIdFor,
  type PipedreamClient,
  type PullFailureReason,
} from '../ingest/pipedream/client.ts';
import type { ConnectorSource } from '../ingest/cursor.ts';
import type { ConnectorSourceName, ConnectorVendor } from './app.ts';

/**
 * A vendor call that did not succeed, in the vocabulary the client already
 * classifies into — plus the operation, so an operator reading one stderr line
 * knows whether a mint or a deletion failed.
 *
 * **No body, no URL, no header.** The client never hands one out and this never
 * asks for one. The message is assembled from three fixed-vocabulary values, so
 * there is no path by which a provider's response text reaches a log.
 */
export class ConnectorVendorError extends Error {
  readonly operation: 'mint_connect_token' | 'delete_external_user';
  readonly reason: PullFailureReason;
  readonly status: number | null;

  constructor(
    operation: 'mint_connect_token' | 'delete_external_user',
    reason: PullFailureReason,
    status: number | null,
  ) {
    super(`the connector vendor refused ${operation}: ${reason} (status ${status ?? 'none'})`);
    this.name = 'ConnectorVendorError';
    this.operation = operation;
    this.reason = reason;
    this.status = status;
  }
}

/**
 * How long a connect link is good for.
 *
 * Ten minutes, which is {@link import('../ingest/pipedream/client.ts').DEFAULT_CLAIM_TTL_MS}
 * restated for the vendor's own scheme and for the same reason: long enough to
 * walk through a consent screen, short enough that a link that ends up in a
 * transcript is usually already dead. Sent as a request rather than assumed —
 * the expiry the port reports is whatever the vendor came back with.
 */
export const DEFAULT_CONNECT_TTL_SECONDS = 600;

export interface PipedreamVendorOptions {
  readonly client: PipedreamClient;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

export function createPipedreamConnectorVendor(options: PipedreamVendorOptions): ConnectorVendor {
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_CONNECT_TTL_SECONDS;

  return {
    async mintClaimUrl(request) {
      const source = request.source as ConnectorSource;
      const minted = await options.client.mintConnectToken({
        externalUserId: externalUserIdFor(request.tenantId, source),
        now: now(),
        ttlSeconds,
        app: APP_FOR_SOURCE[source],
      });
      if (!minted.ok) {
        throw new ConnectorVendorError('mint_connect_token', minted.reason, minted.status);
      }
      return { claimUrl: minted.value.connectLinkUrl, expiresAt: minted.value.expiresAt };
    },

    async disconnect(request) {
      // The external user is per source (see `externalUserIdFor`), so this
      // deletes exactly the connection the caller named. A tenant-wide id here
      // would make one disconnect revoke the other two sources at the vendor.
      const deleted = await options.client.deleteExternalUser({
        externalUserId: externalUserIdFor(request.tenantId, request.source as ConnectorSource),
      });
      if (!deleted.ok) {
        throw new ConnectorVendorError('delete_external_user', deleted.reason, deleted.status);
      }
      // Reported exactly as the vendor reported it. `tokensRevoked` stays
      // `unverified` until the compliance question in
      // `docs/vendor/2026-08-12-pipedream-compliance.md` is answered in writing,
      // because "no live credential remains anywhere" is a sentence that ends up
      // in a privacy policy.
      return { deleted: deleted.value.deleted, tokensRevoked: deleted.value.tokensRevoked };
    },
  };
}

/**
 * Restated as a type-level assertion rather than a runtime one: the web app's
 * closed set of connector names and the ingest layer's closed set of sources are
 * the same three strings, and a fourth added to one and not the other would be a
 * connector the vendor adapter above cannot address.
 *
 * `cursor.ts` already says the same thing about job targets. This is the third
 * copy of that set meeting the first two, checked where they meet.
 */
export type ConnectorNamesAgree = ConnectorSourceName extends ConnectorSource
  ? ConnectorSource extends ConnectorSourceName
    ? true
    : never
  : never;
export const CONNECTOR_NAMES_AGREE: ConnectorNamesAgree = true;
