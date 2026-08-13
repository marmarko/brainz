/**
 * The edge limiter — the only control between a public origin and a fleet of
 * scale-to-zero containers billed per 10ms.
 *
 * Two properties matter more than the arithmetic:
 *
 *   * **It runs in front of the container.** A limiter consulted inside the
 *     instance has already paid for the instance. `test/mcp/router.test.ts`
 *     pins the ordering; this file pins the decision.
 *   * **It fails CLOSED.** A limiter that returns `ok` when its own clock or
 *     counter throws is worse than no limiter, because the flood is exactly the
 *     condition under which it breaks. That is the mutation this file hunts.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_EDGE_LIMITS, createEdgeLimiter } from '../../src/mcp/rate-limit.ts';

function clockFrom(start: number): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const CALLER = { ip: '198.51.100.7', grantId: 'grant-1', tenantId: 'tenant-a' };

describe('per-IP and per-grant buckets', () => {
  test('admits up to the burst and then refuses with a typed reason', () => {
    const clock = clockFrom(1_000);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 3, perGrantBurst: 100 },
    });

    for (let i = 0; i < 3; i += 1) {
      const decision = limiter.admit(CALLER);
      expect(decision.ok).toBe(true);
      decision.release();
    }

    const refused = limiter.admit(CALLER);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('per_ip');
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('the bucket refills over time', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 1, perIpPerMinute: 60 },
    });

    limiter.admit(CALLER).release();
    expect(limiter.admit(CALLER).ok).toBe(false);
    clock.advance(1_100);
    const after = limiter.admit(CALLER);
    expect(after.ok).toBe(true);
    after.release();
  });

  test('a grant over its own limit is refused even from a fresh IP', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 1000, perGrantBurst: 2 },
    });

    limiter.admit({ ...CALLER, ip: '203.0.113.1' }).release();
    limiter.admit({ ...CALLER, ip: '203.0.113.2' }).release();
    const refused = limiter.admit({ ...CALLER, ip: '203.0.113.3' });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('per_grant');
  });

  test('one tenant flooding does not spend another tenant’s budget', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perGrantBurst: 1, perIpBurst: 1000 },
    });

    limiter.admit(CALLER).release();
    expect(limiter.admit(CALLER).ok).toBe(false);
    const other = limiter.admit({ ip: '198.51.100.7', grantId: 'grant-2', tenantId: 'tenant-b' });
    expect(other.ok).toBe(true);
    other.release();
  });
});

describe('the per-tenant concurrency ceiling', () => {
  test('refuses a request beyond the ceiling while the earlier ones are in flight', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, tenantConcurrency: 2, perIpBurst: 1000, perGrantBurst: 1000 },
    });

    const first = limiter.admit(CALLER);
    const second = limiter.admit(CALLER);
    expect(first.ok && second.ok).toBe(true);

    const third = limiter.admit(CALLER);
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('tenant_concurrency');

    first.release();
    const fourth = limiter.admit(CALLER);
    expect(fourth.ok).toBe(true);
    fourth.release();
    second.release();
  });

  test('a double release does not free another holder’s slot', () => {
    // The failure this pins is not "the counter goes negative" — a clamp hides
    // that. It is that one request releasing twice frees a slot a *different*
    // in-flight request is still holding, so the ceiling silently rises by one
    // for as long as that request runs.
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, tenantConcurrency: 2, perIpBurst: 1000, perGrantBurst: 1000 },
    });

    const first = limiter.admit(CALLER);
    const second = limiter.admit(CALLER);
    expect(first.ok && second.ok).toBe(true);
    expect(limiter.inFlight(CALLER.tenantId)).toBe(2);

    first.release();
    first.release();
    first.release();

    // One holder remains, so exactly one slot is free.
    expect(limiter.inFlight(CALLER.tenantId)).toBe(1);
    const third = limiter.admit(CALLER);
    expect(third.ok).toBe(true);
    expect(limiter.admit(CALLER).ok).toBe(false);

    third.release();
    second.release();
    expect(limiter.inFlight(CALLER.tenantId)).toBe(0);
  });

  test('a refused request holds no slot', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 0, tenantConcurrency: 1 },
    });

    const refused = limiter.admit(CALLER);
    expect(refused.ok).toBe(false);
    refused.release();

    const relaxed = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, tenantConcurrency: 1 },
    });
    const admitted = relaxed.admit(CALLER);
    expect(admitted.ok).toBe(true);
    admitted.release();
  });
});

describe('failing closed', () => {
  test('a clock that throws refuses the request instead of admitting it', () => {
    const limiter = createEdgeLimiter({
      now: () => {
        throw new Error('the clock is having a day');
      },
      limits: DEFAULT_EDGE_LIMITS,
    });

    const decision = limiter.admit(CALLER);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('unavailable');
  });

  test('a caller with no identifiable IP is still limited, not exempted', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 1 },
    });

    limiter.admit({ ...CALLER, ip: null }).release();
    const refused = limiter.admit({ ...CALLER, ip: null });
    expect(refused.ok).toBe(false);
  });

  test('an unauthenticated caller is limited on the IP lane before any grant exists', () => {
    const clock = clockFrom(0);
    const limiter = createEdgeLimiter({
      now: clock.now,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 1 },
    });

    limiter.admit({ ip: '198.51.100.9', grantId: null, tenantId: null }).release();
    const refused = limiter.admit({ ip: '198.51.100.9', grantId: null, tenantId: null });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('per_ip');
  });
});
