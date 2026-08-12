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
| Calibration (`--local`) passed first? | yes / no — **if no, nothing below is trustworthy** |
| Cloudflare colo | (from the report's `cloudflare colo` line) |
| Instance type | `standard-1` (or whatever `wrangler.toml` said on the day) |
| Container image Bun version | |
| Neon `server_version` | |
| Probe exit code | |
| Flags used | e.g. `bun run probe:container-tcp` (defaults) |

---

## THE DECISION

> Fill this in last, in one sentence, and make it a decision rather than a summary.
> Then update **Assumption 4** and, if needed, **KTD2** in the plan to match, and delete
> Assumption 4's "inferred rather than confirmed" language.

**Verdict:** `A_RAW_TCP_OK` / `B_WEBSOCKET_ONLY` / `C_BOTH_BLOCKED` / `INCONCLUSIVE_*`

**Because:**

**Assumption 4 now reads:**

**KTD2 changes / does not change because:**

**The 128 MB question is / is not reopened because:**

---

## The three-way fork

*Exactly one row should be marked. If none can be, the verdict is inconclusive and the plan
does not branch.*

| | Outcome | Observed? | Consequence |
|---|---|---|---|
| **(a)** | raw TCP on 5432 carried a full Postgres session | | KTD2 stands as written |
| **(b)** | raw TCP failed, `wss` on 443 carried a full Postgres session | | Containers KEPT, transport changes only |
| **(c)** | both failed, while HTTPS from the same container worked | | Workers + one-shot HTTP driver; pooled TCP, prepared statements and 128 MB headroom forfeited |

---

## Transport table

*Copy from the report's TRANSPORTS block.*

| Transport | channel open | authenticated | session semantics |
|---|---|---|---|
| (a) raw TCP `:5432` | | | |
| (b) Postgres over `wss:443` | | | |
| one-shot HTTP `:443` (control) | | | |

**The control behaved as expected** (authenticated, then failed every session assertion):
yes / no — *if no, the whole run is suspect; the battery may not be measuring what it claims.*

---

## Controls — read these before believing any negative result

| Control | Result | Why it matters |
|---|---|---|
| `control.https_443` — ordinary HTTPS from the container | pass / fail | A fail makes (c) impossible to claim; the verdict must be `INCONCLUSIVE_NO_BASELINE_EGRESS`. |
| `control.tcp_443` — raw TCP handshake on 443 | pass / fail | Pass + 5432 fail = **port filtering**, not a ban on raw sockets. Raise with Cloudflare before accepting (c). |
| `tcp.reachability` — SSLRequest answered with `S` | pass / fail | Distinguishes "a socket opened" from "a real Postgres is there". A TCP accept with no `S` reads as interception or black-holing. |
| `cloudflare_egress_ca_present` | true / false | Presence means Cloudflare's outbound HTTPS interception is active for this container, which changes how the HTTPS control should be read. |

---

## Session-semantics detail

*The load-bearing stages. Fill in for whichever transport carried a session.*

| Stage | Result | Proves |
|---|---|---|
| `*.authenticate` (server signature verified) | | The far end really is this Postgres, not a proxy that accepted the socket |
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

---

## Follow-ups filed

| | |
|---|---|
| Plan lines updated (Assumption 4, KTD2, U1 step 6) | |
| Re-check scheduled before U6 | |
| Cloudflare support thread opened (only if 443 raw TCP worked and 5432 did not) | |
| Probe deleted (`wrangler delete`) and throwaway Neon project removed | |
