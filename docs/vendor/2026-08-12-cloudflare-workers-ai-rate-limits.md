# Vendor question — Cloudflare Workers AI rate limits

**Status:** draft, not yet sent
**Owner:** founder
**Blocks:** Phase 3 (asked in Phase 0).
**Why it is asked early:** the answer does not change the model picks — it changes whether the job scheduler needs per-model queueing, which is cheap to design in and expensive to retrofit.

---

## What the answer decides

Every consolidation phase routes through Cloudflare-hosted models. The
unified-billing changelog quotes 20 → 50 requests per minute per account per
model on the frontier tier. If the standard tier is bounded comparably, bulk
consolidation across many tenants hits a throughput ceiling that has nothing to
do with price — and per-account scoping would mean the ceiling is shared across
the whole fleet rather than per tenant.

This is a **separate constraint** from the scheduler's own concurrency bound
(~20 concurrent cycles). Even with unlimited model throughput, that bound caps
capacity; and even with unlimited concurrency, a per-account rpm cap does. Both
have to clear.

Concretely, the answer decides whether U10's job runner needs a per-model token
bucket in front of dispatch, and it feeds the capacity arithmetic that sets the
consolidation time-ceiling period.

---

## Draft

> **Subject:** Workers AI — per-model rate limits at multi-tenant scale
>
> Hi,
>
> We're building a multi-tenant product where each tenant gets a scheduled
> background job that makes a burst of Workers AI calls. We're trying to size the
> scheduler correctly and would like to understand the rate-limit model before we
> build it.
>
> **1. What are the per-model request limits on the standard (non-frontier)
> Workers AI models?** The unified-billing changelog quotes 20 → 50 rpm per
> account per model for the frontier tier with credits. We're mainly using
> Cloudflare-hosted open-weight models — is the standard tier bounded similarly,
> or on a different basis entirely?
>
> **2. Are those limits scoped per account, per gateway, or per API token?** This
> is the one that matters most for us. A per-account ceiling is shared across
> every tenant we serve, so it becomes a fleet-wide capacity limit rather than a
> per-tenant one, and we'd need to design queueing around it from the start.
>
> **3. Is there a path to raising them,** and is it self-serve, a plan tier, or a
> conversation? If it's a conversation, we'd like to start it early rather than
> at the point where we're hitting the wall.
>
> **4. Do concurrency and requests-per-minute limit independently?** Our
> workload is bursty per tenant but staggered across tenants, so we'd rather
> optimise against whichever is actually binding than guess.
>
> Thanks,

---

## Recording the answer

Write the reply into this file under `## Answer (YYYY-MM-DD)`, then update:

- **Outstanding Questions** in the plan — resolve the Phase 3 blocking item.
- **U10** — add per-model queueing to the scheduler's scope if the cap is
  per-account and low.
- **KTD11** — feed the measured ceiling into the capacity arithmetic alongside
  the concurrency bound.
