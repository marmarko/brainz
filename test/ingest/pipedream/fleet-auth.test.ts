/**
 * Two failures that shared one code, and the day that would have cost every
 * tenant their connectors.
 *
 * ==========================================================================
 * THE DEFECT
 * ==========================================================================
 * `auth_expired` was answered by two unrelated classifiers:
 *
 *   * `classifyHttpFailure` — a **proxy** 401 or 403. The user's grant at
 *     Google is gone: withdrawn, expired, or scoped away. Nothing this fleet
 *     can do changes that answer, so the lane stops now and the panel asks for
 *     a reconnection. That reading is correct and this file keeps it.
 *
 *   * `classifyTokenFailure` — brainz's **own** `client_credentials` mint
 *     against the vendor's `/oauth/token`, with the fleet-wide client id and
 *     secret. It answered `auth_expired` for everything that was not 429, 5xx
 *     or 408 — 400, 401, 403, 404 and 422 all measured — and the 2xx that came
 *     back without an `access_token` answered it too.
 *
 * Since `auth_expired` is terminal, a rotated or mistyped **fleet** credential
 * marked every tenant's every lane dead, told every one of them to reconnect an
 * account that was perfectly healthy, and left no retry that could ever recover
 * it. One code, two owners, opposite remedies.
 *
 * ==========================================================================
 * WHAT THESE CASES ASSERT, AND WHY NOT THE OBVIOUS THING
 * ==========================================================================
 * A test that asserts `fleet_auth_failed` exists passes the moment the string
 * is typed. So every case here asserts a **consequence**, and takes it from the
 * shipped classifier through the shipped mapping rather than from a fixture
 * that restates it:
 *
 *   * a fleet mint refusal leaves the lane **retryable** (`jobRetryableOf` on
 *     the real `IngestPullFailure`), and the panel never says reconnect;
 *   * a proxy refusal is still **terminal**, and the panel still says reconnect;
 *   * the code an operator reads on `/admin connector_status` tells the two
 *     apart, which is the whole point: nothing a tenant does fixes the first.
 *
 * One file across three layers on purpose. The failure crosses `client.ts` →
 * `pull.ts` → `control.connector_health` → the panel's copy, and a code that is
 * right in the first and wrong in the last is the exact shape of the bug.
 */

import { describe, expect, test } from 'bun:test';

import { causeOf, type ConnectorHealthView } from '../../../src/control/connector-health.ts';
import { INGEST_FAILURE_CODES } from '../../../src/ingest/log.ts';
import {
  classifyHttpFailure,
  classifyTokenFailure,
  createPipedreamClient,
} from '../../../src/ingest/pipedream/client.ts';
import {
  IngestPullFailure,
  attemptFor,
  pullStopIsTerminal,
  type PullResult,
  type PullStopReason,
} from '../../../src/ingest/pipedream/pull.ts';
import { itemFailureFor } from '../../../src/ingest/pipedream/sources/types.ts';
import type { ConnectorStatus } from '../../../src/web/connector-panel.ts';
import { blockedReconnectSuffix, causeSentence, renderPage } from '../../../src/web/pages.ts';
import { jobRetryableOf } from '../../../src/worker/jobs.ts';
import { CONFIG, createScriptedTransport, withToken } from './fixture.ts';

const NOW = new Date('2026-08-17T09:00:00.000Z');

/** No pacing: what these assert is the classification, not the token bucket. */
const UNPACED = { take: () => Promise.resolve() };

function clientWith(transport: ReturnType<typeof createScriptedTransport>) {
  return createPipedreamClient({ config: CONFIG, transport, now: () => NOW, rate: UNPACED });
}

/** One ordinary provider call — the path every poll takes. */
async function poll(transport: ReturnType<typeof createScriptedTransport>) {
  return clientWith(transport).request({
    app: 'gmail',
    method: 'GET',
    path: '/gmail/v1/users/me/messages',
    externalUserId: 'tenant-a-gmail',
    // A connection id, because a proxy call with nothing attached is
    // `not_connected` before a token is ever minted.
    accountId: 'apn_1',
  });
}

/** A failed pull, as `runPull` reports one. */
function failedPull(stopReason: PullStopReason): PullResult {
  return {
    outcome: 'failed',
    mode: 'delta',
    runId: null,
    decision: null,
    estimate: null,
    counts: {
      written: 0,
      unchanged: 0,
      quarantined: 0,
      warned: 0,
      failed: 0,
      tombstoned: 0,
      suppressed: 0,
    },
    widen: { excludedItems: 0, windowDays: null, outsideWindow: null },
    attemptedItems: 0,
    cursorAdvanced: false,
    cursorInvalidated: false,
    stopReason,
  };
}

/** What the panel reads, from what the handler banked. */
function panelCauseFor(stopReason: PullStopReason): string | null {
  const attempt = attemptFor({ tenantId: 't-1' }, 'gmail', NOW, failedPull(stopReason));
  const health: ConnectorHealthView = {
    source: 'gmail',
    lastAttemptAt: NOW,
    lastSuccessAt: null,
    runOutcome: attempt.runOutcome,
    ingestFailureCode: attempt.ingestFailureCode,
    ingestFailureStatus: null,
    jobFailureCode: attempt.jobFailureCode,
    itemsWritten: attempt.itemsWritten,
    itemsFailed: attempt.itemsFailed,
  };
  return causeOf(health);
}

/**
 * Every spelling of the one **instruction** that costs a user a
 * re-authorization — and deliberately not every mention of the word.
 *
 * A bare `/reconnect/i` was the first draft and it was wrong in a way worth
 * recording: the `failing` copy ends *"That starts the checks from scratch and
 * does not cost you a reconnection"*, which is the opposite of an instruction —
 * it is the page promising the button is free. A guard that read that as
 * "asks the user to reconnect" would force the reassurance to be deleted to go
 * green, which is a worse page arrived at by a stricter test.
 *
 * So the shapes are the two the copy actually gives, plus the ordinary future
 * spelling of the same instruction.
 */
const ASKS_FOR_A_RECONNECTION =
  /disconnect(?:ing)? (?:this source|and connecting again)|connect (?:it|this source) again|reconnect (?:your|this|the|it)\b/i;

/** The dashboard, rendered around one connector in whatever state it is in. */
function dashboardFor(overrides: Partial<ConnectorStatus>): string {
  const status: ConnectorStatus = {
    source: 'gmail',
    state: 'blocked',
    lastCheckedAt: NOW,
    // This file is about which instruction each CAUSE earns, so the freshness
    // axis is pinned to the reading that adds no sentence of its own. A stale
    // connector renders an extra clause, and a clause this file did not put
    // there is a clause its regexes would be judging by accident.
    freshness: 'current',
    lastSuccessAt: NOW,
    failureCode: null,
    cause: null,
    itemsFailed: 0,
    nextAttemptAt: null,
    attempts: 1,
    maxAttempts: 12,
    ...overrides,
  };
  return renderPage({
      kind: 'connectors',
      connectorsAvailable: true,
      connectors: [status],
    });
}

describe('the fleet’s own credential is not the user’s grant', () => {
  test('every mint refusal that is not a wait or an outage is the fleet’s', () => {
    // Measured against the shipped classifier, status by status. 400, 401, 403,
    // 404 and 422 are all "we could not obtain a token with our own client id
    // and secret" — a sentence with no tenant in it.
    for (const status of [400, 401, 403, 404, 422]) {
      expect({ status, reason: classifyTokenFailure(status) }).toEqual({
        status,
        reason: 'fleet_auth_failed',
      });
    }

    // The two neighbours that were already right, kept right: a busy vendor is
    // not a broken credential, and neither is a vendor that fell over.
    expect(classifyTokenFailure(429)).toBe('rate_limited');
    expect(classifyTokenFailure(503)).toBe('provider_error');
    expect(classifyTokenFailure(408)).toBe('provider_error');
  });

  test('a proxy refusal is still the user’s grant', () => {
    // The half the terminal classification was added for. If this moves, a
    // revoked grant goes back to being retried for two days while the one
    // person who could fix it in thirty seconds is never asked.
    expect(classifyHttpFailure(401, { error: 'invalid_grant' })).toBe('auth_expired');
    expect(classifyHttpFailure(403, {})).toBe('auth_expired');
  });

  test('a refused mint reaches the caller as the fleet’s failure, through the real client', () => {
    // Not the classifier in isolation: the transport answers the vendor's own
    // token endpoint the way a rotated fleet secret would, and this is the
    // outcome an adapter actually receives.
    const transport = createScriptedTransport();
    transport.on('/oauth/token', { status: 401, body: { error: 'invalid_client' } });

    return poll(transport).then((outcome) => {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('fleet_auth_failed');
      // And it never reached Google. A fleet with no token asked the provider
      // nothing, which is why no tenant's grant can be implicated by it.
      expect(transport.requests.filter((request) => request.url.includes('/proxy/'))).toHaveLength(0);
    });
  });

  test('a proxy 401 after a good mint is still the user’s, through the same client', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/messages', { status: 401, body: { error: 'invalid_grant' } });

    const outcome = await poll(transport);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('auth_expired');
  });

  test('a 2xx mint carrying no access_token is the fleet’s, and says which', async () => {
    // The third case: the vendor answered successfully and gave us nothing
    // usable. It is not the user's grant — no grant was consulted — and the
    // consequence is identical to a refusal: this fleet holds no token and no
    // tenant can do anything about it. So it shares the code, and `detail`
    // carries the part the code cannot.
    const transport = createScriptedTransport();
    transport.on('/oauth/token', { status: 200, body: { token_type: 'Bearer', expires_in: 3600 } });

    const outcome = await poll(transport);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('fleet_auth_failed');
    expect(outcome.detail ?? '').toContain('access_token');
    // These strings reach logs and receipts. The vendor's body does not.
    expect(outcome.detail ?? '').not.toContain('Bearer');
  });
});

describe('the two halves have opposite retry policies', () => {
  test('a fleet credential failure leaves the lane retryable', () => {
    // The consequence, not the code. `pullStopIsTerminal` decides whether the
    // job walks its ladder, and `jobRetryableOf` is what the runner actually
    // asks — so both are taken from the shipped path.
    expect(pullStopIsTerminal('fleet_auth_failed')).toBe(false);

    const failure = new IngestPullFailure('gmail', 'fleet_auth_failed');
    expect(failure.jobRetryable).toBe(true);
    expect(jobRetryableOf(failure, false)).toBe(true);
    expect(failure.failureCode).toBe('fleet_auth_failed');
  });

  test('a revoked grant is still terminal', () => {
    expect(pullStopIsTerminal('auth_expired')).toBe(true);

    const failure = new IngestPullFailure('gmail', 'auth_expired');
    expect(failure.jobRetryable).toBe(false);
    expect(jobRetryableOf(failure, false)).toBe(false);
  });

  test('an item this fleet could not fetch holds the cursor', () => {
    // The quiet one. `itemFailureFor` sends anything it does not name to the
    // `provider_error` default, whose retry verdict is the provider's status —
    // and a mint 401 is not worth retrying by that rule, so the item would be
    // written off and the cursor would advance past a message nobody ever read.
    // A token this fleet could not mint says nothing whatever about the item.
    expect(itemFailureFor('gmail:m1', { reason: 'fleet_auth_failed', status: 401 })).toEqual({
      externalRef: 'gmail:m1',
      reason: 'fleet_auth_failed',
      retryable: true,
    });
  });
});

describe('the operator hears it, the user does not', () => {
  test('the cause an operator reads tells the two apart', () => {
    // `causeOf` is what `/admin connector_status` and the dashboard both read,
    // and it is fed by `attemptFor`. A fleet outage that arrived as
    // `provider_error` would be indistinguishable from every 502 in the fleet.
    expect(panelCauseFor('fleet_auth_failed')).toBe('fleet_auth_failed');
    expect(panelCauseFor('auth_expired')).toBe('auth_expired');
    expect(panelCauseFor('provider_error')).toBe('provider_error');
  });

  test('the panel never asks a user to reconnect over the fleet’s own credential', () => {
    const sentence = causeSentence('fleet_auth_failed') ?? '';
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).not.toMatch(ASKS_FOR_A_RECONNECTION);
    // Nor does it print the code at somebody. That artifact is what the whole
    // per-code branch exists to keep off the page.
    expect(sentence).not.toContain('fleet_auth_failed');

    // And the suffix the `blocked` copy appends when the cause has not already
    // given an instruction. A retryable cause should never reach `blocked` at
    // all — but the copy must be right where it lands, not where it is
    // expected to.
    expect(blockedReconnectSuffix('fleet_auth_failed')).toBe('');
  });

  test('the rendered page never asks either, in the state that would', () => {
    // **The assertion the one above cannot make.** `blockedReconnectSuffix` can
    // be perfect and unreferenced: restoring the inline comparison it replaced
    // leaves it exported, tested and dead, and the page goes back to telling a
    // user to reconnect over the fleet's own credential. So this reads the
    // HTML.
    //
    // `blocked` is the state that carries the instruction, and `failing` is
    // where a retryable cause actually lands once it spends its ladder. Both
    // are asserted, because the copy has to be right in whichever one it
    // reaches.
    for (const state of ['blocked', 'failing'] as const) {
      const html = dashboardFor({ state, cause: 'fleet_auth_failed', attempts: 12 });
      expect({ state, asks: ASKS_FOR_A_RECONNECTION.test(html) }).toEqual({ state, asks: false });
      expect(html).toContain('That is ours, not yours');
    }
  });

  test('the user’s own half still asks for the reconnection, and asks once', () => {
    expect(causeSentence('auth_expired') ?? '').toMatch(ASKS_FOR_A_RECONNECTION);
    // Once: the cause sentence already carries the instruction, so the blocked
    // copy must not repeat it.
    expect(blockedReconnectSuffix('auth_expired')).toBe('');
    // And a cause that carries no instruction still gets one.
    expect(blockedReconnectSuffix('provider_error')).toMatch(ASKS_FOR_A_RECONNECTION);

    // Through the page, both halves. A revoked grant is asked to reconnect
    // exactly once — the pair that was the original defect — and a blocked lane
    // whose cause carries no instruction of its own still gets the generic one.
    const revoked = dashboardFor({ state: 'blocked', cause: 'auth_expired' });
    expect(revoked).toMatch(ASKS_FOR_A_RECONNECTION);
    expect(revoked).not.toContain('Disconnect this source and connect it again');

    expect(dashboardFor({ state: 'blocked', cause: 'provider_error' })).toContain(
      'Disconnect this source and connect it again',
    );
  });

  test('every code the ingest vocabulary can produce has a sentence', () => {
    // Derived from the constant rather than listed, so a seventh code cannot
    // arrive with no copy and be noticed by nobody.
    for (const code of INGEST_FAILURE_CODES) {
      const sentence = causeSentence(code) ?? '';
      expect({ code, names: sentence.includes(code) }).toEqual({ code, names: false });
      expect({ code, length: sentence.length > 20 }).toEqual({ code, length: true });
    }
  });
});

/**
 * A gate refusal reaches the dashboard.
 *
 * **Observed in production before this was fixed**: a tenant sat at
 * `run_outcome = 'refused'` with `ingest_failure_code = NULL` for two days
 * while every pull was turned away for `cap_exhausted`. The connectors page
 * already had a written sentence for that code — *"This brain's spending cap
 * stopped the import before it finished"* — waiting for a value that never
 * arrived, because a refusal carries `decision.reason` and the health row only
 * consulted `stopReason`. The page could say a check had happened; it could not
 * say the brain was out of budget.
 */
describe('a refusal says why, not just that it happened', () => {
  const refusedPull = (reason: 'cap_exhausted' | 'quarantined'): PullResult =>
    ({
      outcome: 'refused',
      mode: 'delta',
      runId: 'r-1',
      decision: { proceed: 'refused', reason, headroom: null },
      estimate: null,
      counts: {
        written: 0, unchanged: 0, quarantined: 0, warned: 0, failed: 0,
        tombstoned: 0, suppressed: 0,
      },
      widen: { excludedItems: 0, windowDays: null, outsideWindow: null },
      attemptedItems: 0,
      cursorAdvanced: false,
      cursorInvalidated: false,
    }) as unknown as PullResult;

  test('an exhausted cap is recorded as budget_exhausted', () => {
    const attempt = attemptFor({ tenantId: 't-1' }, 'gmail', NOW, refusedPull('cap_exhausted'));
    expect(attempt.runOutcome).toBe('refused');
    expect(attempt.ingestFailureCode).toBe('budget_exhausted');
  });

  test('any other refusal is cancelled, which is what the ingest log records too', () => {
    const attempt = attemptFor({ tenantId: 't-1' }, 'gmail', NOW, refusedPull('quarantined'));
    expect(attempt.ingestFailureCode).toBe('cancelled');
  });

  test('a completed run still carries no code, because there is nothing to explain', () => {
    const completed = {
      ...refusedPull('cap_exhausted'),
      outcome: 'completed',
      decision: null,
    } as unknown as PullResult;
    const attempt = attemptFor({ tenantId: 't-1' }, 'gmail', NOW, completed);
    // A code left on a recovered connector is a red line nobody can clear.
    expect(attempt.ingestFailureCode).toBeNull();
  });
});
