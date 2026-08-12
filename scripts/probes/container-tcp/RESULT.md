# Container raw-TCP probe — RESULT

> **This file is committed to a PUBLIC repository.**
> Record measurements, verdicts and dates. Do **not** paste connection strings, roles,
> passwords, Neon endpoint hostnames or account ids. The probe's output is already redacted —
> hostnames appear only as a `host#<fingerprint>` token, error strings included. The raw
> `result-<origin>-<timestamp>.json` stays gitignored and local.

**Settles:** Assumption 4
**Question:** can a deployed Cloudflare Container open unrestricted raw outbound TCP to Neon on
5432 — and if not, does the Postgres wire protocol survive over a WebSocket on 443?
**Blocking for:** KTD2's rationale (pooled TCP, prepared statements, the per-tenant
`postgres.js` connection LRU, no Hyperdrive slot); the 128 MB question before U6.

---

## Status

| | |
|---|---|
| Status | `NOT YET RUN` → replace with `ANSWERED` / `INCONCLUSIVE — RE-RUN NEEDED` |
| Run by | |
| Date run (UTC) | |
| Calibration (`--local`) run first? | yes / no — **if no, nothing below is trustworthy**. It exits 50 by design; that is not a failure. |
| Calibration `wouldBeVerdict` | (the calibration's own line: what the same evidence would have meant from a container) |
| Calibration `ws.*` stages passed? | yes / no — **if no, a `(c)` here means nothing**; the probe will refuse to issue one |
| **`origin corroborated`** | **true / false — if false, THIS RUN IS VOID. It was not shown to have happened on Cloudflare, and no row below may be copied into the plan.** |
| Cloudflare colo | (from the report's `cloudflare colo` line — must not be blank on a container run) |
| `driver saw` line | `scheme=… host=… cf-ray=…` — the driver's own evidence. `cf-ray=false` voids the run. |
| Instance type | `standard-1` (or whatever `wrangler.toml` said on the day) |
| Container image Bun version | |
| Neon `server_version` | |
| Probe exit code | 0 / 10 / 20 / 30 / 40 / 50 |
| Flags used | e.g. `bun run probe:container-tcp` (defaults) |
| Port dialled | must be `5432` for Assumption 4 as written |

> **Do not record the `PROBE_URL` here.** A `*.workers.dev` subdomain identifies the account.
> The report prints the endpoint as a `host#<fingerprint>` for exactly this reason.

---

## THE DECISION

> Fill this in last, in one sentence, and make it a decision rather than a summary.
> Then update **Assumption 4** and, if needed, **KTD2** in the plan to match, and delete
> Assumption 4's "inferred rather than confirmed" language.

**Verdict:** one of

`A_RAW_TCP_OK` (0) · `B_WEBSOCKET_ONLY` (10) · `C_BOTH_BLOCKED` (20) — the three that settle
anything.

`INCONCLUSIVE_ORIGIN_UNVERIFIED` · `INCONCLUSIVE_NO_BASELINE_EGRESS` ·
`INCONCLUSIVE_TCP_REACHABLE` · `INCONCLUSIVE_WS_OPEN` · `INCONCLUSIVE_PEER_UNVERIFIED` ·
`INCONCLUSIVE_CONTROL_ABSENT` · `INCONCLUSIVE_CONTROL_SUSPECT` ·
`INCONCLUSIVE_WS_CLIENT_UNPROVEN` · `INCONCLUSIVE_PRECONDITION` (all 30) — **the plan does not
branch on any of these.** Record which one, and what the report said was missing.

`CALIBRATION_ONLY` (50) — a `--local` run. Never the answer, whatever its `wouldBeVerdict` says.

**Because:**

**Assumption 4 now reads:**

**KTD2 changes / does not change because:**

**The 128 MB question is / is not reopened because:**

---

## The three-way fork

*Exactly one row should be marked, and only if the verdict was one of the three conclusive
ones. If the verdict was any `INCONCLUSIVE_*` or `CALIBRATION_ONLY`, mark **none** of them,
write the verdict name and what was missing, and leave the plan unbranched. A blank fork table
with a named inconclusive is a complete, correct result — it is the answer "we do not know yet,
here is precisely what we did not observe".*

| | Outcome | Observed? | Consequence |
|---|---|---|---|
| **(a)** | raw TCP on 5432 carried a full Postgres session, with a verified peer and a control that showed the battery can fail | | KTD2 stands as written |
| **(b)** | no raw TCP handshake to 5432 completed at all, and `wss` on 443 carried a full Postgres session | | Containers KEPT, transport changes only |
| **(c)** | both failed while HTTPS from the same container worked, and calibration had proven the `ws.*` arm elsewhere | | Workers + one-shot HTTP driver; pooled TCP, prepared statements and 128 MB headroom forfeited |
| | none of the above | | inconclusive — name it below, do not branch |

---

## Transport table

*Copy from the report's TRANSPORTS block.*

| Transport | channel open | authenticated | peer verified | session semantics |
|---|---|---|---|---|
| (a) raw TCP `:<port dialled>` | | | | |
| (b) Postgres over `wss:443` | | | | |
| one-shot HTTP `:443` (control) | | | *(always false — it authenticates inside Neon, not over the wire from here)* | |

**Negative control** — copy the report's `negative control` line, which is one of three and
never a yes/no:

| | What it means for this run |
|---|---|
| `PASS — authenticated, then failed every session assertion` | The battery was shown able to register a negative. A conclusive verdict is allowed. |
| `DID NOT RUN` | The null check never happened. The probe reports `INCONCLUSIVE_CONTROL_ABSENT`; read `http.select_1` for why (a 4xx, an unreachable host, intercepted TLS) and re-run. **This is not the same as the control behaving.** |
| `SUSPECT` | A channel with no session kept session semantics. The instrument is in doubt and no verdict is usable in either direction. |

**`peer verified`** is the recorded fact behind "SCRAM completed and the server signature
verified". If it is false on the transport that carried the session, the verdict is
`INCONCLUSIVE_PEER_UNVERIFIED` — do not write it up as a pass.

---

## Controls — read these before believing any negative result

| Control | Result | Why it matters |
|---|---|---|
| `control.https_443` — ordinary HTTPS from the container | pass / fail | A fail makes (c) impossible to claim; the verdict must be `INCONCLUSIVE_NO_BASELINE_EGRESS`. |
| `control.tcp_443` — raw TCP handshake on 443 | pass / fail | Pass + 5432 fail = **port filtering**, not a ban on raw sockets. Raise with Cloudflare before accepting (c). |
| `tcp.reachability` — SSLRequest answered with `S` | pass / fail | Distinguishes "a socket opened" from "a real Postgres is there". A TCP accept with no `S` reads as interception or black-holing. |
| `cloudflare_egress_ca_present` + `extra_ca_configured` | true/false + true/false | Presence means Cloudflare's outbound HTTPS interception is active for this container. The image's entrypoint then exports `NODE_EXTRA_CA_CERTS` for it, and `extra_ca_configured` says whether that took effect. **`present=true` with `trusted=false` explains an HTTPS-only failure as a trust-store problem, not a platform denial** — rebuild the image and re-run rather than recording a `(c)`. |
| `origin corroborated` + the `driver saw` line | true / false | Whether this run was shown to have happened inside a deployed Cloudflare Container at all. False voids everything above it. |

---

## Session-semantics detail

*The load-bearing stages. Fill in for whichever transport carried a session.*

| Stage | Result | Proves |
|---|---|---|
| `*.authenticate` — `scram_completed` + `server_signature_verified` | | The far end holds this role's stored key, so it is not a terminator that merely accepted the socket. (A byte-relaying proxy is NOT ruled out — plain SCRAM has no channel binding.) |
| `*.set_local_readback` | | `SET LOCAL` is visible to the next statement — the two share a session |
| `*.same_backend_in_txn` | | The same backend process, not just a connection that answered |
| `*.local_scoped_out` | | The GUC was transaction-scoped — what per-request `hnsw.ef_search` tuning depends on |
| `*.prepared_statement` | | A named prepared statement survives between round trips |
| `*.ef_search_guc` (informational) | | `SET LOCAL hnsw.ef_search` on this transport. Usually `skipped` — the `vector` extension is not installed in a fresh throwaway project. |

---

## Timings

*Not a benchmark — one connection per transport. Recorded because a WebSocket upgrade cost is
an input to how much the per-tenant connection LRU is worth under outcome (b).*

| | ms |
|---|---|
| TCP connect to 5432 | |
| TLS handshake | |
| WebSocket upgrade to `/v2` | |
| SCRAM authenticate (raw TCP) | |
| SCRAM authenticate (WebSocket) | |
| Total run | |

---

## Notes carried by the report

*Paste the `Notes` section verbatim. They are already redacted.*

```
```

---

## Anything surprising

*Free text. Things worth a sentence: a stage that failed and then passed on retry, a colo that
behaved differently, a wake time that was much worse than expected, an error string that
suggested interception.*

---

## What this run does NOT establish

*Pre-filled; extend if something else came up.*

- Stability over time. One run, one instance type, one colo, one date. Cloudflare Containers
  carry no documented commitment about raw outbound TCP, so a pass is a current-state fact.
  **Re-check before U6 ships**, and again before the U13 bake.
- Anything about throughput, connection limits, LRU behaviour under load, or wake latency —
  one connection per transport was opened.
- That `postgres.js` in particular works. The probe proves the wire protocol and the session
  properties `postgres.js` depends on; it carries no driver.
- That no **relaying** proxy sits in the path. SCRAM without channel binding cannot detect a
  byte forwarder — its relayed server signature verifies legitimately. What is ruled out is a
  peer that terminates the connection without holding the role's key.
- Anything about a colo other than the one recorded above, or about any port other than the one
  dialled.

---

## Follow-ups filed

| | |
|---|---|
| Plan lines updated (Assumption 4, KTD2, U1 step 6) | |
| Re-check scheduled before U6 | |
| Cloudflare support thread opened (only if 443 raw TCP worked and 5432 did not) | |
| Probe deleted (`wrangler delete`) and throwaway Neon project removed | |
