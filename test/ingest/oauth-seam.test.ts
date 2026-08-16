/**
 * U18 §5 — the connector-auth seam.
 *
 * Two properties are worth testing here and neither is "the stub refuses":
 *
 *   1. **The vendor path is observably unchanged.** A seam that altered
 *      behaviour on the day it landed would make every later swap
 *      indistinguishable from a regression. So the test drives a recording
 *      client and asserts the same `ProviderRequest` arrives at the same method
 *      with the same arguments.
 *
 *   2. **The swap decision is ordered fleet-fact-first.** Un-marking a source
 *      must roll every tenant back without a tenant write, because the moment
 *      you want to roll back is an incident. A rule keyed on the tenant grant
 *      first would need a fleet-wide write to undo, and the test that catches
 *      the difference is the one where the tenant HAS granted and the source is
 *      NOT certified.
 *
 * The refusals are tested for their *reason*, not merely for failing: a stub
 * that said "not configured" for all three states would flatten a four-week
 * external dependency into a shrug.
 */

import { describe, expect, test } from 'bun:test';

import {
  OWN_OAUTH_BLOCKERS,
  ownOAuth,
  ownOAuthOf,
  pipedreamAuth,
  resolveAuthProvider,
  type OwnGrantStore,
  type SwapConfig,
} from '../../src/ingest/oauth/seam.ts';
import type { ClientOutcome, ExternalUserDeletion, ProviderRequest } from '../../src/ingest/pipedream/client.ts';

const TENANT = 'tenant-seam';

function recordingClient() {
  const requests: ProviderRequest[] = [];
  const deletions: string[] = [];
  return {
    requests,
    deletions,
    client: {
      request(request: ProviderRequest): Promise<ClientOutcome<unknown>> {
        requests.push(request);
        return Promise.resolve({ ok: true as const, value: { seen: true } });
      },
      deleteExternalUser(request: { readonly externalUserId: string }): Promise<ClientOutcome<ExternalUserDeletion>> {
        deletions.push(request.externalUserId);
        return Promise.resolve({
          ok: true as const,
          value: { deleted: true, evidence: 'deleted' as const, tokensRevoked: 'unverified' as const },
        });
      },
    },
  };
}

const grantStore = (has: boolean): OwnGrantStore => ({ has: () => Promise.resolve(has) });

describe('the vendor path through the seam is the vendor path', () => {
  test('a source adapter\'s request reaches the client unchanged', async () => {
    const recorder = recordingClient();
    const auth = pipedreamAuth(recorder.client);
    const api = auth.apiFor({ tenantId: TENANT, source: 'gmail' });

    const request: ProviderRequest = {
      app: 'gmail',
      method: 'GET',
      path: '/users/me/messages',
      query: { maxResults: 50 },
      externalUserId: TENANT,
    };
    const outcome = await api.request(request);

    expect(outcome.ok).toBe(true);
    // Identity, not equality: a seam that rebuilt the request object is a seam
    // that can drop a field, and dropping `accountId` is how one Google account's
    // messages arrive under another's cursor.
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.requests[0]).toBe(request);
  });

  test('the erasure leg reaches the vendor with the tenant id as its external user', async () => {
    const recorder = recordingClient();
    const auth = pipedreamAuth(recorder.client);
    const outcome = await auth.deleteExternalUser({ tenantId: TENANT });

    expect(outcome.ok).toBe(true);
    expect(recorder.deletions).toEqual([TENANT]);
    // The vendor's own honesty is passed through rather than upgraded — U17's
    // rule, restated one layer up: `unverified` stays `unverified`.
    if (outcome.ok) expect(outcome.value.tokensRevoked).toBe('unverified');
  });

  test('per-source revocation reports that it did nothing rather than reporting success', async () => {
    const auth = pipedreamAuth(recordingClient().client);
    const outcome = await auth.revoke({ tenantId: TENANT, source: 'gmail' });
    // A `revoke` that returned ok having done nothing is how a disconnect comes
    // to be believed.
    expect(outcome.ok).toBe(false);
  });
});

describe('the swap decision', () => {
  const certified: SwapConfig = { certifiedSources: ['gmail'] };
  const none: SwapConfig = { certifiedSources: [] };

  test('an uncertified source stays on the vendor even when the tenant has granted', async () => {
    // **The ordering test.** Fleet fact first is what makes un-marking a source
    // roll every tenant back without a tenant write.
    const resolved = await resolveAuthProvider(none, grantStore(true), {
      tenantId: TENANT,
      source: 'gmail',
    });
    expect(resolved.provider).toBe('pipedream');
    expect(resolved.because).toBe('not_certified');
  });

  test('a certified source with no tenant grant stays on the vendor, and says which', async () => {
    const resolved = await resolveAuthProvider(certified, grantStore(false), {
      tenantId: TENANT,
      source: 'gmail',
    });
    expect(resolved.provider).toBe('pipedream');
    expect(resolved.because).toBe('no_tenant_grant');
  });

  test('certified plus granted is the only combination that moves', async () => {
    const resolved = await resolveAuthProvider(certified, grantStore(true), {
      tenantId: TENANT,
      source: 'gmail',
    });
    expect(resolved.provider).toBe('own_oauth');
    expect(resolved.because).toBe('certified_and_granted');
  });

  test('a different source is unaffected by another\'s certification', async () => {
    const resolved = await resolveAuthProvider(certified, grantStore(true), {
      tenantId: TENANT,
      source: 'calendar',
    });
    expect(resolved.provider).toBe('pipedream');
    expect(resolved.because).toBe('not_certified');
  });
});

describe('own OAuth is inert, and says exactly what is missing', () => {
  test('every method refuses', async () => {
    const auth = ownOAuth();
    const api = auth.apiFor({ tenantId: TENANT, source: 'gmail' });
    const request = await api.request({
      app: 'gmail',
      method: 'GET',
      path: '/users/me/messages',
      externalUserId: TENANT,
    });
    expect(request.ok).toBe(false);
    expect((await auth.revoke({ tenantId: TENANT, source: 'gmail' })).ok).toBe(false);
    expect((await auth.deleteExternalUser({ tenantId: TENANT })).ok).toBe(false);
  });

  test('each blocker is a distinct sentence naming a distinct thing somebody must do', async () => {
    const details = new Set<string>();
    for (const blocker of OWN_OAUTH_BLOCKERS) {
      const outcome = await ownOAuth({ blocker }).deleteExternalUser({ tenantId: TENANT });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) details.add(outcome.detail ?? '');
    }
    // Flattening the three into "not configured" is how a four-week external
    // dependency with an invoice becomes a surprise in a launch week.
    expect(details.size).toBe(OWN_OAUTH_BLOCKERS.length);
    expect([...details].join(' ')).toContain('CASA');
  });

  test('the default blocker is the true one: no application is registered', async () => {
    const outcome = await ownOAuth().deleteExternalUser({ tenantId: TENANT });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('registers none');
  });
});

describe('ownOAuthOf — one answer to "which auth serves this pull"', () => {
  test('returns the vendor whenever the swap has not happened', async () => {
    const vendor = pipedreamAuth(recordingClient().client);
    const resolved = await ownOAuthOf({ certifiedSources: [] }, grantStore(true), vendor, {
      tenantId: TENANT,
      source: 'gmail',
    });
    expect(resolved).toBe(vendor);
  });

  test('refuses loudly rather than falling back once the swap HAS been declared', async () => {
    // The state after CASA clears and before the client is written. A silent
    // fallback to the vendor here would make a failed cutover
    // indistinguishable from a successful one — the fleet would quietly keep
    // using the subprocessor the swap existed to remove, and the register would
    // be wrong.
    const vendor = pipedreamAuth(recordingClient().client);
    const resolved = await ownOAuthOf({ certifiedSources: ['gmail'] }, grantStore(true), vendor, {
      tenantId: TENANT,
      source: 'gmail',
    });
    expect(resolved).not.toBe(vendor);
    expect(resolved.provider).toBe('own_oauth');
    expect((await resolved.deleteExternalUser({ tenantId: TENANT })).ok).toBe(false);
  });
});
