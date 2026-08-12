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

**It cannot prove:**

- **The account's bucket quota.** No R2 API exposes it. Creating buckets successfully proves
  headroom only up to the number created — succeeding on three buckets on a fresh account
  proves nothing about thirty thousand. The probe therefore reports `NOT_OBSERVED` and states
  the proven headroom as a floor, and only reports a ceiling if the ramp leg actually
  *receives* a quota rejection.
- **How an increase is requested.** That is a process answer only Cloudflare can give. The
  probe prints the escalation link; `RESULT.md` has a field for the date you asked and the
  answer you got. Getting that in writing is part of settling this question, not an optional
  extra.
- **Anything about a mint mode that failed to authenticate.** A failed local mint is reported
  `INCONCLUSIVE`, never `FAIL` — see "Reading the output".

---

## Environment variables

Everything is read from the environment. **This repo is public: no account id, key, bucket
name or endpoint may ever be committed.** Put these in `.env` (already gitignored) or export
them in your shell.

| Variable | Required | What it is |
|---|---|---|
| `R2_ACCOUNT_ID` | yes | Cloudflare account id (R2 dashboard, right-hand sidebar). |
| `R2_API_TOKEN` | yes | The **token value** of an R2 API token. Used as `Authorization: Bearer` for bucket management and credential minting. |
| `R2_ACCESS_KEY_ID` | yes | The same token's **Access Key ID**. Also sent as `parentAccessKeyId` when minting. |
| `R2_SECRET_ACCESS_KEY` | yes | The same token's **Secret Access Key**. |
| `R2_JURISDICTION` | no | `eu` or `fedramp`. Sets the `cf-r2-jurisdiction` header and the endpoint host. |
| `R2_S3_ENDPOINT` | no | Override the S3 host (default `<account>.r2.cloudflarestorage.com`). |
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
denies every request and looks exactly like perfect isolation. `--self-test` checks, offline:
the signer against AWS's published SigV4 test vector; the local minter against Cloudflare's
published derivation; the error classifier (a 429 must never be read as a quota ceiling); and
**every branch of the scope-verdict logic** — including that an all-denied matrix caused by a
broken signer yields `INCONCLUSIVE` rather than `PASS`, and that an enumeration leak yields
`PASS_WITH_CAVEAT` rather than `FAIL`. A live run only ever exercises whichever branch it
happens to land in, so those branches are pinned here instead. If `--self-test` fails, no
result from this probe is trustworthy.

### Answering the quota question harder

The default run does not hunt for a ceiling. To push:

```bash
# Cross the ~1,000 mark that fresh accounts are commonly seeded at.
bun run probe:r2 --legs=inventory --ramp=1200 --ramp-rps=4 --ramp-max-seconds=900
```

Sizing note: the R2 REST API is limited to **1,200 requests per five minutes, account-wide,
across all R2 REST operations**. A 1,200-bucket ramp plus its cleanup is ~2,400 REST calls —
two full budget windows, ~10 minutes minimum, and it competes with anything else on the
account. `--ramp-rps` paces it; throttling is retried, not treated as a ceiling.

Use `--create-via=s3` to run the ramp through the S3 `CreateBucket` path instead. Whether the
two paths share a budget is one of the things the default run measures.

### Other useful flags

`--legs=inventory,latency,ratelimit,tempcreds,ramp` (or `all`) · `--burst=N` concurrent
creates in the rate leg · `--create-via=rest|s3|both` · `--mint-samples=N` / `--mint-burst=N`
· `--ttl=N` requested credential TTL · `--verify-expiry` (re-tests after the TTL elapses;
adds a sleep, capped by `--max-expiry-wait`) · `--out=PATH` · `--no-write`. Run
`bun run probe:r2 --help` for the full list.

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
| `RATE_LIMITED` | A throughput observation. Never a viability answer. |
| `NOT_OBSERVED` | The thing is not observable by this probe at all — the bucket quota. Escalate; do not infer. |

### Exit codes

`0` answered, no blocker · `1` a hard `FAIL` on either option · `2` usage or config error ·
`3` either option ran and came back `INCONCLUSIVE` — deliberately distinct from `1`, so a
cron or CI caller can tell "answered no" from "didn't answer". An option whose legs were not
selected is `SKIPPED`, which does not affect the exit code.

### The three rules that make a result trustworthy in both directions

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
   be believed. The report says explicitly whether the object landed or survived.

Every failure carries Cloudflare's own status, error code and message verbatim, so the
probe's classification can be overruled by a human reading the same evidence.

---

## What each outcome means for the plan

| Outcome | Consequence |
|---|---|
| **B `PASS`** (scope holds) | Take Option B. R9's R2 boundary becomes structural; the quota question stops being blocking and Option A's escalation is no longer on Phase 1's critical path. U16 may report R2 as *enforced*. |
| **B `PASS`, local minting also verified** | Strongest result. Minting leaves the R2 REST budget entirely, so per-request minting is a non-question and no credential cache is needed on the request path. |
| **B `PASS`, only API minting verified** | Still take B, but the measured mint rate is a request-path ceiling. Mitigation: a per-tenant credential cache with a TTL shorter than the credential's own. Note it against U2. |
| **B `PASS_WITH_CAVEAT`** (enumerable) | Object access is fenced but key names leak across prefixes. Key names are content. Either accept with a documented U2 rule that every list passes the tenant prefix, or prefer Option A, which has no such failure mode. |
| **B `FAIL`** | A tenant credential reached another tenant's data. B is not an isolation boundary as configured. Fall back to A — and A's quota escalation becomes urgent. |
| **B `INCONCLUSIVE`** | **Do not branch.** Fix the cause (usually credentials or permissions), re-run. Escalating to Cloudflare support with the raw errors is cheaper than a wrong architectural decision. |
| **A `NOT_OBSERVED`** (expected default) | Creates work and the envelope is measured, but headroom is proven only to the floor stated. Request the quota in writing before committing to A. |
| **A `FAIL`** (ceiling observed) | A quota ceiling below target was actually hit. A needs a limit increase in writing before it can be chosen. |
| **Both `PASS`** | Prefer whichever the register prefers: A gives a name-verifiable boundary; B gives a bounded-TTL credential and no quota dependency. R10's blast radius shrinks under B only if the parent credential is not resolvable by the request-path identity — the same rule R11 already applies to connection strings. |

---

## Blast radius and cleanup

A default run creates roughly **130 buckets** and spends roughly **250 R2 REST calls**
against the account-wide 1,200-per-5-minute budget, shared with anything else using R2 on
that account. `--dry-run` prints the exact numbers for your flags first.

**Every bucket the probe creates is deleted before it exits**, including when a leg throws
mid-flight (cleanup runs in a `finally`) — objects first, then the bucket, retrying through
throttling. The final report states in words how many buckets and objects were removed and
whether anything survived.

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
