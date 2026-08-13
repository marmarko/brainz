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
| Status | **ANSWERED** |
| Run by | Claude Opus 5, at the founder's direction |
| Date run | 2026-08-13T00:10Z |
| Probe run id | `msqrimmqgsa` |
| Probe exit code | **0** — answered |
| `--self-test` passed first? | **yes** — 71/71 |
| Flags used | `bun run probe:r2` (defaults) |
| Cells reported `unattributable` | **none among gating cells.** The only `unattributable` entries are the two `read_other_prefix_dotdot` traversal cells, which are advisory by construction — the URL layer rewrites `..` before the request leaves the process, so a denial there was never evidence. They do not gate the verdict. |

---

## THE DECISION

> Fill this in last, in one sentence, and make it a decision rather than a summary.
> Then update R9 in the plan to match, and delete R9's "provisional" language.

**Chosen option: `B. prefix-scoped temporary credentials`.**

**Because:** it fences access at the platform without bucket-per-user, and it needs no quota
answer at all — which retires the one question only Cloudflare could have answered. It was
verified in **both** mint modes: a credential scoped to tenant-a's prefix met an attributable
`403` on every cross-tenant read, write, delete, list and cross-bucket access, with parent-side
checks confirming no side effect, while its positive and permission controls both passed. Option
A remains viable but unproven — no ceiling was hit, but no R2 API exposes the account quota, so
the 30,000-tenant target could only be established by Cloudflare in writing.

**R9 now reads:** the R2 boundary is **platform-enforced, conditional on correct prefix
derivation** — not "convention-enforced", and not unqualified "structural" either. The
conditional is load-bearing and is not a hedge: R2 matches `prefixes` **literally**, so a
credential scoped to `tenant-a` successfully read `tenant-abc/` in this run. The platform does
not enforce a boundary at the prefix separator; it enforces the string you gave it. With a
correctly terminated prefix the boundary holds at the platform; with a missing `/` it silently
does not.

**R10's register entry for the object-storage credential now reads:** the request path holds a
**per-tenant credential with a bounded TTL**, not a fleet-wide object credential. The parent
credential still exists and still unlocks every prefix — so this is a real reduction in blast
radius **only if the parent key is not resolvable by the request-path identity**, which is
exactly the rule R11 already applies to connection strings. Same boundary, second store.

**U16's attestation reports the R2 boundary as:** `structural` — scoped to the mint modes
actually verified here (api, local) and no wider, and carrying the derivation condition above.

---

## Option B — prefix-scoped temporary credentials

*The option that needs no quota answer. Its whole viability rests on whether the scope
actually holds, not on whether minting succeeds.*

| | |
|---|---|
| **Verdict** | **PASS** |
| Which mint mode(s) were actually verified | **both** (api and local) |
| Caveat(s) recorded, verbatim | none emitted. The conditional that matters is the prefix-derivation finding below, which the probe reports separately as `literal_prefix_match_sibling_reachable`. |
| Positive control (credential reads its OWN prefix) | **passed** (HTTP 200) |
| Permission control (credential writes its OWN prefix) | **passed** (HTTP 200) |
| TTL the matrix was minted at | **900s** — deliberately not the shortest accepted (60s), so the credential could not expire mid-matrix and be misread as a denial. TTL ladder: 60s / 300s / 900s / 3600s all accepted. |

> **A cell that is `unattributable` is not a denial.** If any cross-tenant cell reads
> `unattributable`, the verdict is `INCONCLUSIVE` and the boundary that cell tests was never
> exercised. Do not record it as "denied". Re-run.

### Scope matrix — API mint

| Cell | Expected | Observed | HTTP | Attempts | Side-effect check |
|---|---|---|---|---|---|
| read own prefix | allow | | | | — |
| write own prefix | allow | | | | — |
| read other tenant's prefix | deny | | | | object corroborated present on a 404? |
| write into other tenant's prefix | deny | | | | did the object land? could the check be run? |
| list other tenant's prefix | deny | | | | keys returned: |
| list bucket unscoped | deny | | | | keys outside scope: |
| read a different bucket | deny | | | | object corroborated present on a 404? |
| delete other tenant's object | deny | | | | did the object survive? could the check be run? |

### Scope matrix — local (JWT) mint

| Cell | Expected | Observed | HTTP | Attempts | Side-effect check |
|---|---|---|---|---|---|
| read own prefix | allow | | | | — |
| write own prefix | allow | | | | — |
| read other tenant's prefix | deny | | | | |
| write into other tenant's prefix | deny | | | | |
| list other tenant's prefix | deny | | | | |
| list bucket unscoped | deny | | | | |
| read a different bucket | deny | | | | |
| delete other tenant's object | deny | | | | |

> A local-mint failure means the claim set could not be authenticated. Record it as
> **UNVERIFIED**, never as "local minting does not work" — Cloudflare documents it, and the
> claim set here is transcribed from their example.
>
> A local mint that *authenticates but is not fenced* is a different finding: the probe
> reports `local_claim_set_suspect` and keeps the API mint's result. Record it, and do not
> mint locally until it is explained.

### Traversal probes (advisory — a denial here is not evidence, only a success is)

| Cell | Observed | What it means |
|---|---|---|
| `read_other_prefix_dotdot` (`tenant-a/../tenant-b/…`) | **unattributable** (both mint modes) — request never sent | Expected `unattributable`: every HTTP client resolves `..` out of the path, so this key cannot be sent as written. Not a gap in the boundary — it degenerates into the plain cross-tenant read above. |
| `read_other_prefix_encoded_traversal` (double-encoded) | **denied_404_obscured** (both mint modes) — key treated literally, no second percent-decode | A 404 means R2 treated the key literally: no second percent-decode, no traversal. A **2xx is a real cross-tenant read** and fails the option. |

### Prefix derivation — is `prefixes` matched literally?

*The hazard U2 actually hits: derive a prefix from a tenant id, drop the trailing `/`, and ask
whether `tenant-a` also reaches `tenant-abc/`.*

| | |
|---|---|
| Finding | **`literal_prefix_match_sibling_reachable`** — a credential scoped to `tenant-a` (no trailing slash) read `bare_prefix_read_sibling` at **HTTP 200**, and the response body *was the sibling tenant's fixture*. |
| Consequence for U2's key-derivation guard | **It stays a REQUIRED control, not defence in depth.** Verbatim from the probe: *"R2 matches `prefixes` LITERALLY: a credential scoped to `tenant-a` reached `tenant-abc/`. U2 MUST terminate every derived prefix with '/', the platform does NOT catch a missing terminator."* This is the single most consequential line in this file: tenant `alice` would read `alice2`'s objects, silently, with a credential the platform considers correctly scoped. |

> A `B PASS` **does not** on its own license downgrading U2's key-derivation guard. Only the
> `prefix_is_component_aware` finding does, and even then the terminator should be normalised
> explicitly rather than relying on an undocumented matching shape.

### Mint rate — does a credential mint per tenant at request rate?

| Measurement | Value |
|---|---|
| Shortest TTL accepted | **60s** |
| TTL ladder result (60 / 300 / 900 / 3600) | **all four accepted** |
| API mints succeeded / attempted (sequential) | **20 / 20** (0 throttled, 0 other failures) |
| API mint latency p50 / p95 | **190ms / 261ms** |
| API mints throttled / failed for other reasons | / (a run where most mints failed is not a clean latency figure) |
| API mint burst: succeeded / concurrent, achieved rate | / , /s |
| Local mint rate (in-process, no API call) | /s — **only quotable if the local credential authenticated**; otherwise this measures crypto throughput, not a mint path |
| Expiry verified? (`--verify-expiry`) | ran / skipped — result: `true` denied after TTL / `false` **still worked after TTL** / `null` not adjudicated |

**Request-path consequence:** (is minting on the request path viable as-is, or is a
per-tenant credential cache with a shorter TTL required?)

---

## Option A — bucket-per-tenant

*Viability here is an operations question, and half of it is not answerable by any API.*

| | |
|---|---|
| **Verdict** | `NOT_OBSERVED` (expected default) / `FAIL` (corroborated ceiling) / `INCONCLUSIVE` (no bucket created, or an uncorroborated quota rejection) |
| Buckets on the account before the run | (exact / lower bound / **not read** — if not read, no account-wide ceiling number can be stated) |
| Buckets created by this run without a quota rejection | |
| **Proven headroom** | ≥ of 30,000 target ( %) |
| Quota ceiling observed? | no — not observable by API / yes, at |
| If yes: did it repeat on re-attempt with fresh names? | yes (→ `FAIL`) / no (→ `INCONCLUSIVE`, not a ceiling) |
| Vendor's wording, verbatim | (read it: a per-bucket, plan or org limit can be worded like an account ceiling) |

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

- **REST calls this run spent:** 256 REST + 255 S3, against a documented budget of 1,200 per
  5 minutes account-wide. No throttling observed at any point, including a 30-way concurrent
  mint burst that completed at 72/s.

- **What contradicted the plan's assumptions — three things.**

  1. **R2 matches `prefixes` literally.** See the derivation section above. This is the finding
     to carry forward: adopting Option B makes the boundary platform-enforced *conditional on
     our own derivation being correct*, which is a weaker and more honest claim than "the
     platform enforces it". R9 must say so, and U2's guard must not be downgraded on the
     strength of a `PASS`.

  2. **The bucket-ceiling premise R9 was originally built on was already known false** (R2
     documents 1,000,000 per account). This run adds that the *account quota is not exposed by
     any R2 API at all* — proven headroom here is ≥148 buckets, and nothing short of Cloudflare
     in writing can establish the 30,000-tenant figure. Since Option B passes and needs no quota
     answer, that question stops being blocking rather than being resolved.

  3. **Local (JWT) minting authenticates and is correctly fenced.** It runs in-process at
     ~12,400/s and spends none of the REST budget, so per-request minting is a non-question. Had
     only the API mint verified, the measured mint rate would have been a hard ceiling on the
     request path and a per-tenant credential cache would have been required.

- **Follow-up TODOs filed:**
  - R9 / R10 / U16 wording per THE DECISION above — left for the plan's owner rather than
    edited mid-execution.
  - **U2 must terminate every derived prefix with `/`, and the guard test must assert the
    sibling case specifically** (`tenant-a` must not reach `tenant-abc/`). A guard that only
    tests `tenant-a` vs `tenant-b` would pass while the real hazard is live.
  - The parent R2 credential must not be resolvable by the request-path identity — the same
    rule R11 applies to connection strings, now applying to a second store.

## If the answer was INCONCLUSIVE (exit 3)

| | |
|---|---|
| Which control or cell failed | positive / permission / setup / mint (throttled?) / **unattributable cells** / quota uncorroborated |
| If unattributable: which cells, and why | (transport / 429 / 5xx / expired credential / uncorroborated 404 / side-effect check unavailable) |
| Raw error (redacted of account identifiers) | |
| Next action | |

> `INCONCLUSIVE` is not a "no". Do not take an architectural no-branch on it.
>
> In particular, an `unattributable` cell means the probe **did not get to ask** that
> question — not that the answer was "denied". A run whose cross-tenant cells were all
> unattributable has issued zero successful cross-tenant requests and proves nothing in
> either direction. Re-run it, ideally with `--legs=tempcreds` on a quiet account.

## Cleanup

| | |
|---|---|
| Cleanup statement from the run | *"Cleanup complete: 132 bucket(s) and 16 object(s) created by this run were deleted. Nothing was left behind."* — true of run `msqrimmqgsa`, and verified against the account afterwards. |
| Buckets left behind | **none, after a manual sweep.** The account was checked directly rather than taking the statement on trust, and 18 buckets were found from an **earlier, aborted run** (`msqrfwlelvh`) that was killed by a 2-minute command timeout before it reached its own cleanup. Those were deleted by hand, matching on that run id only. Final state: zero buckets on the account. |

> **Operational lesson, worth carrying into any future probe run.** A probe's cleanup can only
> run if the probe finishes. This one is well behaved on its own exit path and said so
> accurately — but an interrupted run leaves resources behind and reports nothing at all,
> because it never got to report. **Always verify against the vendor, not against the run's own
> statement**, and remember that a killed run has no exit code to tell you it failed. Long
> probes belong in the background from the start.
