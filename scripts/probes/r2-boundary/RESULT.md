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
| Status | `NOT YET RUN` → replace with `ANSWERED` / `NOT SETTLED — RE-RUN NEEDED` |
| Run by | |
| Date run | |
| Probe run id | |
| Probe exit code | `0` answered · `1` FAIL · `2` usage/config · `3` not settled · `4` self-test failed · `5` cleanup incomplete |
| `--self-test` passed first? | yes / no — **if no, the run below is not trustworthy** |
| Flags used | e.g. `bun run probe:r2` (defaults) |
| Cells reported `unattributable` | none / list them — **any entry here means the verdict is `INCONCLUSIVE`, not a pass** |

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
| Which mint mode(s) were actually verified | api / local / both / **none** — the verdict is only claimable for these |
| Caveat(s) recorded, verbatim | (paste every `caveat:` line from the block — they are what makes the verdict conditional) |
| Positive control (credential reads its OWN prefix) | passed / **failed → verdict is INCONCLUSIVE, not FAIL** / **unattributable → also INCONCLUSIVE** |
| Permission control (credential writes its OWN prefix) | passed / failed / unattributable |
| TTL the matrix was minted at | s (deliberately not the shortest accepted) |

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
| `read_other_prefix_dotdot` (`tenant-a/../tenant-b/…`) | | Expected `unattributable`: every HTTP client resolves `..` out of the path, so this key cannot be sent as written. Not a gap in the boundary — it degenerates into the plain cross-tenant read above. |
| `read_other_prefix_encoded_traversal` (double-encoded) | | A 404 means R2 treated the key literally: no second percent-decode, no traversal. A **2xx is a real cross-tenant read** and fails the option. |

### Prefix derivation — is `prefixes` matched literally?

*The hazard U2 actually hits: derive a prefix from a tenant id, drop the trailing `/`, and ask
whether `tenant-a` also reaches `tenant-abc/`.*

| | |
|---|---|
| Finding | `literal_prefix_match_sibling_reachable` / `prefix_is_component_aware` / `bare_prefix_grants_nothing` / `inconclusive` |
| Consequence for U2's key-derivation guard | (paste the probe's sentence — it decides whether the guard stays a **required control** or becomes defence in depth) |

> A `B PASS` **does not** on its own license downgrading U2's key-derivation guard. Only the
> `prefix_is_component_aware` finding does, and even then the terminator should be normalised
> explicitly rather than relying on an undocumented matching shape.

### Mint rate — does a credential mint per tenant at request rate?

| Measurement | Value |
|---|---|
| Shortest TTL accepted | s |
| TTL ladder result (60 / 300 / 900 / 3600) | accepted / rejected / **unattributable** per rung |
| API mints succeeded / attempted (sequential) | / |
| API mint latency p50 / p95 / max | ms / ms / ms — **only meaningful if succeeded > 0** |
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

- REST calls this run spent (documented budget is 1,200 per 5 minutes, account-wide):
- Anything that contradicted the plan's assumptions:
- Follow-up TODOs filed:

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
| Cleanup statement from the run | |
| Buckets left behind | none / (if any, exit code was `5` — re-run `bun run probe:r2 --cleanup-only`) |
