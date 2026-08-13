/**
 * The edge limiter — enforced in front of container spin-up (U6 approach 6).
 *
 * **Why the position matters more than the arithmetic.** `/mcp`, the
 * authorization endpoint and the token endpoint sit on a public origin in front
 * of scale-to-zero containers billed per 10ms. A limiter consulted *inside* the
 * instance has already paid for the instance, so a flood is billed and then
 * rejected. This module is called by the Worker (`router.ts`) before the Durable
 * Object is addressed; `test/mcp/router.test.ts` pins that ordering with a fleet
 * stub that records whether it was reached at all.
 *
 * R14's caps meter *model* spend. Nothing else meters compute, which is what
 * this is.
 *
 * **Three lanes, because three different things go wrong.**
 *
 *   * **Per-IP** — the only lane that exists before a caller authenticates, and
 *     therefore the only one that limits an attacker who never presents a valid
 *     grant. It is also the weakest: an IP is cheap to change.
 *   * **Per-grant** — survives an IP rotation, because the credential is the
 *     scarce thing. A compromised grant hammering from a botnet is bounded here
 *     and nowhere else.
 *   * **Per-tenant concurrency** — a ceiling on requests *in flight*, not on
 *     their rate. Tenant affinity means one tenant's traffic lands on one
 *     container instance (KTD2), so this is the lane that keeps one brain from
 *     wedging its own instance, and it is the only one whose accounting must be
 *     released rather than expiring on its own.
 *
 * **It fails closed.** Everything below runs inside a try/catch that answers
 * `unavailable` — a refusal — rather than admitting. A limiter that admits when
 * its own state throws is worse than no limiter, because "the limiter is
 * struggling" and "we are being flooded" are the same event.
 *
 * **Deliberately not durable.** The state is per-Worker-isolate, which means a
 * distributed flood gets one bucket per isolate rather than one globally. That
 * is a real weakening and it is the accepted alpha shape: the alternative is a
 * Durable Object round-trip on every unauthenticated request, which is itself
 * the billed work the limiter exists to avoid. Written down rather than
 * discovered — U15's re-plan is where a global counter would land.
 */

export interface EdgeLimits {
  readonly perIpBurst: number;
  readonly perIpPerMinute: number;
  readonly perGrantBurst: number;
  readonly perGrantPerMinute: number;
  readonly tenantConcurrency: number;
  /** Buckets untouched for this long are dropped, so the map cannot grow without bound. */
  readonly idleEvictionMs: number;
}

/**
 * Alpha defaults, reasoned rather than measured.
 *
 * An interactive agent session is a handful of calls per turn; 60/minute per
 * grant is generous for a person and small for a script. The per-IP lane is
 * looser because a household or an office NATs several users behind one address.
 * Concurrency is 4 because one tenant is one container instance and a personal
 * brain has one user.
 */
export const DEFAULT_EDGE_LIMITS: EdgeLimits = {
  perIpBurst: 120,
  perIpPerMinute: 240,
  perGrantBurst: 60,
  perGrantPerMinute: 60,
  tenantConcurrency: 4,
  idleEvictionMs: 10 * 60 * 1000,
};

export type RefusalReason = 'per_ip' | 'per_grant' | 'tenant_concurrency' | 'unavailable';

export interface Admission {
  readonly ok: boolean;
  readonly reason?: RefusalReason;
  readonly retryAfterSeconds?: number;
  /** Idempotent. Safe (and required) to call on every path, including refusals. */
  release(): void;
}

export interface Caller {
  readonly ip: string | null;
  readonly grantId: string | null;
  readonly tenantId: string | null;
}

export interface EdgeLimiter {
  admit(caller: Caller): Admission;
  /** In-flight count for a tenant. Observability for the tests and the fleet. */
  inFlight(tenantId: string): number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const NO_OP_RELEASE = (): void => {};

export function createEdgeLimiter(options: {
  readonly now: () => number;
  readonly limits?: EdgeLimits;
}): EdgeLimiter {
  const limits = options.limits ?? DEFAULT_EDGE_LIMITS;
  const buckets = new Map<string, Bucket>();
  const concurrency = new Map<string, number>();

  function take(key: string, burst: number, perMinute: number, at: number): boolean {
    if (burst <= 0) return false;
    const bucket = buckets.get(key) ?? { tokens: burst, updatedAt: at };
    const refill = ((at - bucket.updatedAt) / 60_000) * perMinute;
    const tokens = Math.min(burst, bucket.tokens + Math.max(0, refill));
    if (tokens < 1) {
      buckets.set(key, { tokens, updatedAt: at });
      return false;
    }
    buckets.set(key, { tokens: tokens - 1, updatedAt: at });
    return true;
  }

  function evict(at: number): void {
    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt > limits.idleEvictionMs) buckets.delete(key);
    }
  }

  function refuse(reason: RefusalReason, retryAfterSeconds: number): Admission {
    return { ok: false, reason, retryAfterSeconds, release: NO_OP_RELEASE };
  }

  return {
    admit(caller: Caller): Admission {
      try {
        const at = options.now();
        evict(at);

        // A caller with no resolvable address is not exempt — it shares one
        // bucket with every other such caller, which is the fail-closed
        // direction. The alternative ("no key, no limit") is the bug.
        const ipKey = `ip:${caller.ip ?? 'unknown'}`;
        if (!take(ipKey, limits.perIpBurst, limits.perIpPerMinute, at)) {
          return refuse('per_ip', retryAfter(limits.perIpPerMinute));
        }

        if (caller.grantId !== null) {
          const grantKey = `grant:${caller.grantId}`;
          if (!take(grantKey, limits.perGrantBurst, limits.perGrantPerMinute, at)) {
            return refuse('per_grant', retryAfter(limits.perGrantPerMinute));
          }
        }

        if (caller.tenantId === null) {
          return { ok: true, release: NO_OP_RELEASE };
        }

        const tenantId = caller.tenantId;
        const held = concurrency.get(tenantId) ?? 0;
        if (held >= limits.tenantConcurrency) {
          return refuse('tenant_concurrency', 1);
        }
        concurrency.set(tenantId, held + 1);

        // Idempotent by a captured flag rather than by trusting the caller:
        // a double release is how a ceiling silently becomes a suggestion.
        let released = false;
        return {
          ok: true,
          release(): void {
            if (released) return;
            released = true;
            const current = concurrency.get(tenantId) ?? 0;
            if (current <= 1) concurrency.delete(tenantId);
            else concurrency.set(tenantId, current - 1);
          },
        };
      } catch {
        return refuse('unavailable', 1);
      }
    },

    inFlight(tenantId: string): number {
      return concurrency.get(tenantId) ?? 0;
    },
  };
}

function retryAfter(perMinute: number): number {
  if (perMinute <= 0) return 60;
  return Math.max(1, Math.ceil(60 / perMinute));
}
