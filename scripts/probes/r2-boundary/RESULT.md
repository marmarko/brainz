# R2 storage-boundary probe — RESULT

> **This file is committed to a PUBLIC repository.**
> Record measurements, verdicts and dates. Do **not** paste account ids, API tokens, access
> keys, endpoint hostnames or bucket names. The probe's summary block is pre-redacted; the
> raw `result-<runId>.json` stays gitignored and local.

**Settles:** R9 · R10 · Gap Register #15
**Question:** is bucket-per-tenant, or prefix-scoped temporary credentials, viable for R2 at
30,000 tenants?
**Blocking for:** Phase 1 (U2's storage accessor), R10's blast-radius entry, U16's
attestation wording.

---

## Status

| | |
|---|---|
| Status | `NOT YET RUN` → replace with `ANSWERED` / `INCONCLUSIVE — RE-RUN NEEDED` |
| Run by | |
| Date run | |
| Probe run id | |
| Probe exit code | |
| `--self-test` passed first? | yes / no — **if no, the run below is not trustworthy** |
| Flags used | e.g. `bun run probe:r2` (defaults) |

---

## THE DECISION

> Fill this in last, in one sentence, and make it a decision rather than a summary.
> Then update R9 in the plan to match, and delete R9's "provisional" language.

**Chosen option:** `A. bucket-per-tenant` / `B. prefix-scoped temporary credentials` / `neither — re-run`

**Because:**

**R9 now reads:** (the corrected sentence that replaces the provisional downgrade)

**R10's register entry for the object-storage credential now reads:**

**U16's attestation reports the R2 boundary as:** `structural` / `convention-enforced`

---

## Option B — prefix-scoped temporary credentials

*The option that needs no quota answer. Its whole viability rests on whether the scope
actually holds, not on whether minting succeeds.*

| | |
|---|---|
| **Verdict** | `PASS` / `PASS_WITH_CAVEAT` / `FAIL` / `INCONCLUSIVE` |
| Positive control (credential reads its OWN prefix) | passed / **failed → verdict is INCONCLUSIVE, not FAIL** |
| Permission control (credential writes its OWN prefix) | passed / failed |

### Scope matrix — API mint

| Cell | Expected | Observed | HTTP | Side-effect check |
|---|---|---|---|---|
| read own prefix | allow | | | — |
| write own prefix | allow | | | — |
| read other tenant's prefix | deny | | | object confirmed present beforehand |
| write into other tenant's prefix | deny | | | did the object land? |
| delete other tenant's object | deny | | | did the object survive? |
| list other tenant's prefix | deny | | | keys returned: |
| list bucket unscoped | deny | | | keys outside scope: |
| read a different bucket | deny | | | object confirmed present beforehand |

### Scope matrix — local (JWT) mint

| Cell | Expected | Observed | HTTP | Side-effect check |
|---|---|---|---|---|
| read own prefix | allow | | | — |
| write own prefix | allow | | | — |
| read other tenant's prefix | deny | | | |
| write into other tenant's prefix | deny | | | |
| delete other tenant's object | deny | | | |
| list other tenant's prefix | deny | | | |
| list bucket unscoped | deny | | | |
| read a different bucket | deny | | | |

> A local-mint failure means the claim set could not be authenticated. Record it as
> **UNVERIFIED**, never as "local minting does not work" — Cloudflare documents it, and the
> claim set here is transcribed from their example.

### Mint rate — does a credential mint per tenant at request rate?

| Measurement | Value |
|---|---|
| Shortest TTL accepted | s |
| TTL ladder result (60 / 300 / 900 / 3600) | |
| API mint latency p50 / p95 / max | ms / ms / ms |
| API mints throttled (sequential) | |
| API mint burst: succeeded / concurrent, achieved rate | / , /s |
| Local mint rate (in-process, no API call) | /s |
| Expiry verified? (`--verify-expiry`) | ran / skipped — result: |

**Request-path consequence:** (is minting on the request path viable as-is, or is a
per-tenant credential cache with a shorter TTL required?)

---

## Option A — bucket-per-tenant

*Viability here is an operations question, and half of it is not answerable by any API.*

| | |
|---|---|
| **Verdict** | `NOT_OBSERVED` (expected default) / `FAIL` / `INCONCLUSIVE` |
| Buckets on the account before the run | (exact / lower bound) |
| Buckets created by this run without a quota rejection | |
| **Proven headroom** | ≥ of 30,000 target ( %) |
| Quota ceiling observed? | no — not observable by API / yes, at |

### The quota answer (only Cloudflare can give this)

| | |
|---|---|
| Starting bucket quota on this account | |
| How the answer was obtained | dashboard / support ticket / account team / limit-increase form |
| Increase requested on (date) | |
| Answer received on (date) | |
| Ceiling granted | |
| Link / ticket ref (safe to record) | |

> Cloudflare documents 1,000,000 buckets per account, but accounts start lower. Until this
> section is filled in, Option A is **not** cleared for 30,000 tenants regardless of what the
> probe measured.

### Operational envelope (measured)

| Measurement | via REST | via S3 |
|---|---|---|
| Creates succeeded / attempted | | |
| Create latency p50 / p95 / max (ms) | | |
| **Create → first usable write** p50 / p95 (ms) | | |
| Buckets that never accepted a write in the timeout | | |
| Burst: concurrent tried / succeeded / throttled | | |
| Achieved creates per second | | |
| First throttle at request # / `Retry-After` | | |

**Do the two create paths share a rate budget?** yes / no / unclear —

**U15 warm-pool sizing input:** pool size implied by create-to-first-usable-write p95 =
, refill rate =

### Ramp (if run)

| | |
|---|---|
| Target / created / terminated as | / / |
| Terminal error verbatim | |

---

## Notes, surprises and follow-ups

- REST calls this run spent (documented budget is 1,200 per 5 minutes, account-wide):
- Anything that contradicted the plan's assumptions:
- Cleanup statement from the run (buckets/objects removed, anything left behind):
- Follow-up TODOs filed:

## If the answer was INCONCLUSIVE

| | |
|---|---|
| Which control failed | positive / permission / setup / mint |
| Raw error (redacted of account identifiers) | |
| Next action | |

> `INCONCLUSIVE` is not a "no". Do not take an architectural no-branch on it.
