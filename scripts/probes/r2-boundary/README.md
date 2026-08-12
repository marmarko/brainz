# R2 storage-boundary probe

**Settles:** requirement **R9**, requirement **R10**, and **Gap Register #15** of
`docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`.

**Question:** *is bucket-per-tenant, or prefix-scoped temporary credentials, viable for R2 at
target scale (30,000 tenants)?*

**Owner:** founder. **Phase:** 0, blocking for Phase 1 — the answer decides R9's isolation
claim, R10's blast-radius entry, U2's key-derivation guard and U16's attestation wording, so
it belongs *before* U2 builds the storage accessor.

---

## Why this probe exists

R9 downgraded file storage to "prefix-enforced by convention" on the premise that *"R2's
per-account bucket ceiling rules out bucket-per-user at target scale."*

**That premise was false.** R2 documents **1,000,000 buckets per account**
([limits](https://developers.cloudflare.com/r2/platform/limits/)) against a 30,000-tenant
target. No research doc carried the claim — it originated in the plan, and it produced the
fleet-wide object credential in R10's blast radius, U2's path-traversal guard surface and
U16's attestation caveat.

So this probe is **not** "does a bucket exist". Two structural options are live, and it
measures the operational envelope of both:

| | Option A — bucket-per-tenant | Option B — prefix-scoped temporary credentials |
|---|---|---|
| Boundary | one bucket per tenant | one bucket, one short-TTL credential per tenant prefix |
| Needs a quota answer? | **yes** | **no** |
| Open questions | starting quota, create latency, management rate limit | does it mint at request rate, **and does the scope actually hold** |

Either option makes the R2 boundary structural, removes the fleet-wide object credential
from R10's blast radius, and lets U16's attestation report R2 as *enforced* rather than
*conventional*.

---

## What this probe can and cannot prove

Read this before reading any result.

**It can prove:**

- Bucket-create latency, and **create-to-first-usable-write** — a bucket is not useful when
  its create returns, it is useful when it accepts an object. That second number is what
  U15's warm pool is sized by.
- The bucket-management throughput actually enforced, on **both** create paths (Cloudflare
  REST API and the S3 API), measured rather than assumed.
- That a temporary credential scoped to tenant-a's prefix **is denied** every read, write,
  delete, list and cross-bucket access against tenant-b's prefix — or that it is not.
- The rate at which prefix-scoped credentials can be minted, by API call and locally.
- Whether R2 matches `prefixes` **literally** — i.e. whether a credential scoped to
  `tenant-a` (no trailing slash) also reaches `tenant-abc/`. This is the derivation-probe
  leg, and it decides whether U2's key-derivation guard can be downgraded to defence in
  depth or has to stay a required control.

**It cannot prove:**

- **The account's bucket quota.** No R2 API exposes it. Creating buckets successfully proves
  headroom only up to the number created — succeeding on three buckets on a fresh account
  proves nothing about thirty thousand. The probe therefore reports `NOT_OBSERVED` and states
  the proven headroom as a floor, and only reports a ceiling if the ramp leg actually
  *receives* a quota rejection **that repeats when re-attempted**.
- **How an increase is requested.** That is a process answer only Cloudflare can give. The
  probe prints the escalation link; `RESULT.md` has a field for the date you asked and the
  answer you got. Getting that in writing is part of settling this question, not an optional
  extra.
- **Anything about a mint mode that failed to authenticate.** A failed local mint is reported
  `INCONCLUSIVE`, never `FAIL` — see "Reading the output".
- **Anything about a cell it could not attribute.** A transport error, a 429, a 5xx, an
  expired credential or an uncorroborated 404 is reported as `unattributable` and forces
  `INCONCLUSIVE`. That is the point, not a shortcoming: see rule 4 below.
- **Whether a literal `../` key crosses the prefix.** It cannot be asked over HTTP. Every
  HTTP client — this probe, the AWS SDKs, `curl` — resolves `.` / `..` / `%2e%2e` out of the
  path during URL parsing, so `tenant-a/../tenant-b/x` becomes a plain request for
  `tenant-b/x` *before it leaves the process*, which is already the `read_other_prefix` cell.
  The probe detects that its own URL layer rewrote the path and **refuses to send the
  request**, reporting the cell as `unattributable` rather than banking a signature-mismatch
  403 as a denial. The one traversal question that *is* answerable — does R2 percent-decode a
  key a second time before matching? — is asked by the double-encoded cell, which is
  delivered verbatim. The residual traversal risk therefore lives in the *derived prefix*,
  which the derivation probe covers.

---

## Environment variables

Everything is read from the environment. **This repo is public: no account id, key, bucket
name or endpoint may ever be committed.** Put these in `.env` **at the repository root**
(next to `package.json`) or export them in your shell.

> The `.env` location matters. Bun loads `.env` from the directory you run the command in,
> which is the repo root — a `.env` dropped in `scripts/probes/r2-boundary/` is gitignored
> *and* never read, which looks exactly like a missing variable. The probe's "cannot run"
> message says so too.

| Variable | Required | What it is |
|---|---|---|
| `R2_ACCOUNT_ID` | yes | Cloudflare account id (R2 dashboard, right-hand sidebar). |
| `R2_API_TOKEN` | yes | The **token value** of an R2 API token. Used as `Authorization: Bearer` for bucket management and credential minting. |
| `R2_ACCESS_KEY_ID` | yes | The same token's **Access Key ID**. Also sent as `parentAccessKeyId` when minting. |
| `R2_SECRET_ACCESS_KEY` | yes | The same token's **Secret Access Key**. |
| `R2_JURISDICTION` | no | `eu` or `fedramp`. Sets the `cf-r2-jurisdiction` header and the endpoint host. |
| `R2_S3_ENDPOINT` | no | Override the S3 **host** — a bare hostname, not a URL (default `<account>.r2.cloudflarestorage.com`). The dashboard shows it with an `https://` prefix; strip that. The probe rejects a value with a scheme rather than building `https://https://…` and blaming your credentials. |
| `R2_API_BASE` | no | Override the REST base (default `https://api.cloudflare.com/client/v4`). |
| `R2_PROBE_BUCKET_PREFIX` | no | Bucket name prefix. **Must start with `brainz-probe-`** — that prefix is the guard that stops `--cleanup-only` deleting a bucket the probe did not create. |

**Simplest working setup:** create **one** R2 API token with **Admin Read & Write** (R2 →
Manage API tokens → Create API token). The dashboard shows the token value, the Access Key ID
and the Secret Access Key on the same screen; those are your four variables. Admin scope is
needed because the probe creates and deletes buckets. Use a token you are willing to delete
afterwards, on an account whose R2 REST budget you are willing to spend (see "Blast radius").

> Cloudflare documents the Secret Access Key as the SHA-256 hash of the token value, so you
> can derive it with `printf %s "$R2_API_TOKEN" | shasum -a 256` if you lost it. The probe
> deliberately does **not** derive it for you: a wrong secret denies every request, which is
> the one failure mode that could be misread as flawless isolation.

---

## How to run

```bash
# 1. Verify the probe's OWN crypto first. No credentials, no network, free.
bun run probe:r2 --self-test

# 2. See the blast radius before spending anything. Touches nothing.
bun run probe:r2 --dry-run

# 3. The real run. ~130 buckets created and deleted, ~250 R2 REST calls.
bun run probe:r2

# 4. Machine-readable, for the record.
bun run probe:r2 --json > /tmp/r2-probe.json
```

Step 1 is not ceremony. The probe's central risk is that a bug in its own request signing
denies every request and looks exactly like perfect isolation. `--self-test` checks, offline
and with no credentials:

- the signer, against AWS's published SigV4 test vector;
- the local minter, against Cloudflare's published derivation;
- the error classifier — a 429 must never be read as a quota ceiling;
- **the outcome mapping** (`classifyRead` + `cellFrom`): a transport error, a 429, a 5xx, an
  expired credential and a request the URL layer rewrote must each come back
  `unattributable`, and an unattributable cell must satisfy **no** expectation;
- **every branch of the scope-verdict logic**, including the two that this probe's own
  review caught: one transport error on one cross-tenant cell yields `INCONCLUSIVE`, never
  `PASS`; and a demonstrated violation still outranks an unattributable cell elsewhere;
- **the mint-mode fold**: a throttled mint is `INCONCLUSIVE` (never a `RATE_LIMITED` that
  outranks it), a caveat in one mint mode survives a clean result in the other, and a
  local-mode failure does not condemn the API mint;
- **the exit-code contract**, as a table;
- the expiry adjudication, the derivation finding, the CLI's unknown-flag rejection, the
  `R2_S3_ENDPOINT`-as-URL rejection, and that redaction strips account ids, endpoints,
  bucket names and tokens out of a raw vendor error string.

A live run only ever exercises whichever branch it happens to land in, so those branches are
pinned here instead. If `--self-test` fails, no result from this probe is trustworthy — it
exits `4`, distinct from a real `FAIL`.

### Answering the quota question harder

The default run does not hunt for a ceiling. To push:

```bash
# One budget window's worth of ramp, with room left for its own cleanup.
bun run probe:r2 --legs=inventory --ramp=400 --ramp-rps=2 --ramp-max-seconds=900
```

**Sizing note — budget for the cleanup, not just the ramp.** The R2 REST API is limited to
**1,200 requests per five minutes, account-wide, across all R2 REST operations**. Every
bucket the ramp creates costs a second REST call to delete, so a ramp of `N` is `2N` calls,
and the deletes land *after* the ramp has already spent its half. A `--ramp=1200` is
therefore 2,400 calls — two full windows, ten minutes minimum, competing with anything else
on the account, and the likely outcome is a partial cleanup. Keep `2 × ramp` comfortably
under 1,200 per five minutes, or run the ramp knowing you will finish with
`--cleanup-only`. `--cleanup-rps` (default 6/s) paces the deletes; throttling is retried on
both sides, and is never treated as a ceiling.

To hunt higher, run several smaller ramps in separate windows rather than one large one.

Use `--create-via=s3` to run the ramp through the S3 `CreateBucket` path instead. Whether the
two paths share a budget is one of the things the default run measures.

**A quota rejection is corroborated before it is believed.** The classifier that recognises a
quota message is the loosest regex in the probe and it guards the most expensive verdict in
it. When a create is rejected with quota-shaped wording, the ramp waits and re-attempts twice
with fresh bucket names; only a rejection that repeats becomes `A FAIL`. One that does not
repeat is `A INCONCLUSIVE` with Cloudflare's wording quoted verbatim — a per-bucket limit, a
billing gate or an org policy can read like an account ceiling, and none of them means
bucket-per-tenant is unavailable.

### Leg order

Legs run `inventory → latency → tempcreds → ratelimit → ramp`, not in flag order. `tempcreds`
answers the question the probe exists for, and it runs **before** the legs that deliberately
provoke throttling so that its setup is not competing with the account's own exhausted
budget. Its bucket creates and fixture writes retry through throttling and through
bucket-create propagation lag regardless.

### Other useful flags

`--legs=inventory,latency,ratelimit,tempcreds,ramp` (or `all`) · `--burst=N` concurrent
creates in the rate leg · `--create-via=rest|s3|both` · `--mint-samples=N` / `--mint-burst=N`
· `--ttl=N` requested credential TTL · `--verify-expiry` (re-tests after the TTL elapses;
adds a sleep, capped by `--max-expiry-wait`) · `--warm-timeout-ms=N` (also the budget setup
allows for bucket-create propagation lag) · `--cleanup-rps=N` · `--out=PATH` · `--no-write`.
Run `bun run probe:r2 --help` for the full list.

**Unknown flags are refused, not ignored.** `--ramp-max-second=60` exits `2` with an error
rather than silently applying the default — on a tool that creates real buckets, a typo in
`--burst` or `--ramp` must not quietly change the blast radius from what you asked for.

---

## Reading the output

The probe prints one verdict per option, and a JSON report lands at
`result-<runId>.json` in this directory (gitignored — it may contain account identifiers).

### Verdict vocabulary

| Verdict | Means |
|---|---|
| `PASS` | The property was demonstrated. |
| `PASS_WITH_CAVEAT` | The property holds with a named exception (e.g. objects are fenced but the bucket is enumerable). |
| `FAIL` | The property was demonstrated **not** to hold. A real no. |
| `INCONCLUSIVE` | The probe could not tell. **This is not a "no".** Acting on it as if it were is the expensive mistake. |
| `RATE_LIMITED` | A throughput observation. Never a viability answer, and never an answer about *scope* — a throttled mint means the scope matrix did not run, which is reported as `INCONCLUSIVE`. |
| `NOT_OBSERVED` | The thing is not observable by this probe at all — the bucket quota. Escalate; do not infer. |

Per-cell, the scope matrix also reports **`unattributable`**: the request produced no outcome
that can be attributed to access control. It is not a denial, it is not an allow, and it
forces the matrix to `INCONCLUSIVE` naming the cell and the reason. Causes: a transport error
(the request never reached Cloudflare), a 429, a 5xx, a credential that expired mid-matrix, a
404 the parent credential cannot corroborate, a side-effect check that could not be
performed, or a request the URL layer rewrote before sending. Every cell is retried (3
attempts, backing off, honouring `Retry-After`) before it is scored.

### Exit codes

| Code | Means |
|---|---|
| `0` | Answered, no blocker. |
| `1` | A hard `FAIL` on either option: a credential reached another tenant's data, or a corroborated quota ceiling below target. |
| `2` | Usage or config error (bad flag, missing/invalid env). |
| `3` | **Not settled.** Either option came back `INCONCLUSIVE` or `RATE_LIMITED`, or the run crashed mid-flight. Deliberately distinct from `1`, so a cron or CI caller can tell "answered no" from "didn't answer". |
| `4` | The probe's own `--self-test` failed. The instrument is not trustworthy; no result from it is either. |
| `5` | The question was answered, but cleanup left buckets behind. Re-run `--cleanup-only`. |

An option whose legs were not selected is `SKIPPED`, which does not affect the exit code.
`1`, `4` and `5` used to be the same code; a CI caller could not tell "R2 scoping is broken"
from "the self-test is failing" from "three buckets survived".

### The four rules that make a result trustworthy in both directions

1. **A denial only counts after the positive controls pass.** Before any cross-tenant denial
   is read as evidence, the same credential must succeed reading its *own* prefix (positive
   control) and writing to its *own* prefix (permission control). Without the first, a
   signing bug looks like isolation. Without the second, a denied cross-tenant write
   demonstrates the permission level rather than the prefix scope. Missing either yields
   `INCONCLUSIVE`.
2. **A 429 is a rate limit, never a failure of the approach.** It is reported as
   `RATE_LIMITED` with the observed throughput and any `Retry-After`, and the ramp retries
   rather than stopping.
3. **A denied write or delete is verified by reading with the parent credential afterwards.**
   An operation that returns an error but takes effect anyway is the one denial that must not
   be believed. The report says explicitly whether the object landed or survived — and if
   that parent-side check *itself* could not be performed, the cell is `unattributable`
   rather than "no side effect".
4. **Absence of evidence is never evidence of success.** This is the rule the probe's own
   review caught it violating. A `fetch` throw returns status 0; that used to map to an
   outcome which, on a deny-expectation cell, counted as "as expected" — so a single DNS
   blip, TLS reset or VPN flap on a cross-tenant cell produced `PASS` with the reason "every
   cross-tenant read, write, delete, list and cross-bucket read was denied with no side
   effect", having issued **zero successful cross-tenant requests**. Now every unattributable
   outcome forces `INCONCLUSIVE` and names what was missing. The same rule governs the
   throttled mint (the matrix did not run → not settled → exit 3, not exit 0), the TTL
   ladder, the expiry check, and the quota ceiling.

Every failure carries Cloudflare's own status, error code and message verbatim, so the
probe's classification can be overruled by a human reading the same evidence.

---

## What each outcome means for the plan

| Outcome | Exit | Consequence |
|---|---|---|
| **B `PASS`** (scope holds) | 0 | Take Option B. R9's R2 boundary becomes structural; the quota question stops being blocking and Option A's escalation is no longer on Phase 1's critical path. U16 may report R2 as *enforced* — **scoped to the mint mode(s) the run actually verified**, which the paste block names. |
| **B `PASS`, local minting also verified** | 0 | Strongest result. Minting leaves the R2 REST budget entirely, so per-request minting is a non-question and no credential cache is needed on the request path. |
| **B `PASS`, only API minting verified** | 0 | Still take B, but the measured mint rate is a request-path ceiling. Mitigation: a per-tenant credential cache with a TTL shorter than the credential's own. Note it against U2. A local mint that did not authenticate is **UNVERIFIED, not unsupported** — Cloudflare documents it and the claim set here is hand-transcribed. |
| **B `PASS_WITH_CAVEAT`** (enumerable) | 0 | Object access is fenced but key names leak across prefixes. Key names are content. Either accept with a documented U2 rule that every list passes the tenant prefix, or prefer Option A, which has no such failure mode. |
| **B `PASS_WITH_CAVEAT`** (enumeration untested) | 0 | Objects are fenced with attributable denials, but the list cells produced no attributable answer, so whether key names leak is **unknown from this run**. Re-run before relying on the enumeration half. |
| **B `PASS_WITH_CAVEAT`** (`local_claim_set_suspect`) | 0 | The API-minted credential was fenced; the locally-minted JWT credential was **not**. Take B with API minting; do not mint locally on this evidence. Either the transcribed claim set is wrong or R2 does not honour `paths` for JWT-minted credentials — worth a support question, not an architectural no-branch. |
| **B `PASS_WITH_CAVEAT`** (`ttl_not_honoured`) | 0 | Only reachable with `--verify-expiry`. The credential still worked after its TTL elapsed, so R10's "bounded TTL" blast-radius reduction does not hold as written. |
| **B `FAIL`** | 1 | The **API-minted** credential reached another tenant's data. B is not an isolation boundary as configured. Fall back to A — and A's quota escalation becomes urgent. |
| **B `INCONCLUSIVE`** (unattributable cells) | 3 | One or more cross-tenant cells produced no attributable answer after retries — a transport error, a 429, a 5xx, an expired credential, an uncorroborated 404. The boundary those cells test was **not exercised**. Re-run; this is not evidence of isolation and not evidence against it. |
| **B `INCONCLUSIVE`** (mint failed / throttled) | 3 | No credential was obtained, so **zero** cross-tenant requests were issued. A throttled mint is a fact about minting throughput and says nothing about scope. Re-run with `--legs=tempcreds` on a quiet account. |
| **B `INCONCLUSIVE`** (setup failed) | 3 | No bucket or fixture to test against. The message names the likely cause — throttle residue and bucket-create propagation lag before credentials. |
| **B `INCONCLUSIVE`** (controls failed) | 3 | **Do not branch.** The credential could not read or write its own prefix, so every denial is unattributable. Fix the cause, re-run. Escalating to Cloudflare support with the raw errors is cheaper than a wrong architectural decision. |
| **A `NOT_OBSERVED`** (expected default) | 0 | Creates work and the envelope is measured, but headroom is proven only to the floor stated. Request the quota in writing before committing to A. If no create-to-first-usable-write sample was captured, the headline says so — U15's warm pool has no number yet. |
| **A `FAIL`** (ceiling observed and corroborated) | 1 | A quota ceiling below target was hit and repeated on re-attempt. A needs a limit increase in writing before it can be chosen. **Read the quoted vendor message**: the verdict rests on a text classifier. |
| **A `INCONCLUSIVE`** (quota uncorroborated) | 3 | A quota-shaped rejection that did not repeat. Not a ceiling — an unexplained one-off. Re-run the ramp. |
| **A `INCONCLUSIVE`** (no bucket created) | 3 | The likeliest *first-run* outcome, and it usually means the token is scoped **Object** Read & Write instead of **Admin** Read & Write. Nothing about the envelope was measured; this is not a limit. |
| **Both `PASS`** | 0 | Prefer whichever the register prefers: A gives a name-verifiable boundary; B gives a bounded-TTL credential and no quota dependency. R10's blast radius shrinks under B only if the parent credential is not resolvable by the request-path identity — the same rule R11 already applies to connection strings. |

**Whatever the outcome, read the prefix-derivation finding before touching U2's guard.** It is
reported separately and never gates the verdict:
`literal_prefix_match_sibling_reachable` (R2 matches literally — the guard stays a *required*
control), `prefix_is_component_aware` (the platform catches a missing terminator),
`bare_prefix_grants_nothing` (a dropped terminator fails closed), or `inconclusive` (unknown —
keep the guard). A `B PASS` on its own does **not** license downgrading that guard.

---

## Blast radius and cleanup

A default run creates roughly **130 buckets** and spends roughly **250 R2 REST calls**
against the account-wide 1,200-per-5-minute budget, shared with anything else using R2 on
that account. `--dry-run` prints the exact numbers for your flags first.

**Every bucket the probe creates is deleted before it exits**, including when a leg throws
mid-flight (cleanup runs in a `finally`) — objects first, then the bucket, retrying through
throttling and paced by `--cleanup-rps` (default 6/s) so the deletes do not throttle
themselves out of the budget window the run just spent. The final report states in words how
many buckets and objects were removed and whether anything survived.

If anything does survive, the run **exits `5`** and the statement names the count, so a
partial cleanup cannot pass unnoticed behind a green exit code. That is a distinct code from
a `FAIL`, so a CI caller can tell "R2 scoping is broken" from "three buckets need sweeping".

If a run is killed hard (SIGKILL, laptop closed), leftovers are recoverable without any
state file, because every bucket is named `brainz-probe-<runId>-*`:

```bash
bun run probe:r2 --cleanup-only
```

That deletes only buckets carrying the `brainz-probe-` prefix, and refuses anything else.

---

## Design constraints this probe honours

- **No dependencies.** Bun built-ins and `fetch` only. SigV4 and the JWT minter are ~200
  lines of readable code in `sigv4.ts` and `mint.ts`, verified by `--self-test`, rather than
  a black box behind a version range.
- **Nothing outside this directory is modified.** The `probe:r2` script already exists in
  `package.json`.
- **No secrets in the repo.** All credentials come from the environment; `result-*.json` is
  gitignored; the pasteable summary block redacts the account id and endpoint.

## Files

| File | What it is |
|---|---|
| `probe.ts` | Entry point: CLI, legs, verdicts, reporting, cleanup, self-test. |
| `r2-api.ts` | REST + S3 client. Error classification (rate limit vs auth vs quota) lives here. |
| `sigv4.ts` | AWS SigV4 request signing. |
| `mint.ts` | Both credential-mint paths, including the local HS256 JWT derivation. |
| `RESULT.md` | The template to fill in. **Commit this** — it is where the answer lives. |
| `result-*.json` | Raw per-run report. Gitignored. |

## Sources

- R2 limits — <https://developers.cloudflare.com/r2/platform/limits/>
- R2 API tokens — <https://developers.cloudflare.com/r2/api/tokens/>
- Temporary credentials — <https://developers.cloudflare.com/r2/api/s3/temporary-credentials/>
- Local minting example — <https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/>
- Create temporary access credentials (API reference) —
  <https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/>
