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
| Status | **ANSWERED** |
| Run by | Claude Opus 5, at the founder's direction |
| Date run (UTC) | 2026-08-12T23:40Z |
| Calibration (`--local`) run first? | **yes** — twice: once before the WebSocket fix, once after. Exited 50 both times, by design. |
| Calibration `wouldBeVerdict` | `A_RAW_TCP_OK` |
| Calibration `ws.*` stages passed? | **yes, after a fix.** The first calibration failed `ws.authenticate` — see *Anything surprising*. A `(c)` would have been refused until that was closed. |
| **`origin corroborated`** | **true** |
| Cloudflare colo | **LAX** (the driver's independently-observed `cf-ray` colo also read LAX) |
| `driver saw` line | `scheme=https: host=public cf-ray=true (colo LAX)` |
| Instance type | `standard-1` |
| Container image Bun version | 1.3.14 |
| Neon `server_version` | PostgreSQL 18 (throwaway project, `aws-us-east-1`) |
| Probe exit code | **0** |
| Flags used | `bun run probe:container-tcp -- --timeout=30000` |
| Port dialled | **5432** |

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

> **(a) and (b) do not carry the same assurance, and the write-up must not imply they do.**
> `A_RAW_TCP_OK` includes a verified SCRAM-SHA-256 server signature: the far end demonstrably
> holds this role's stored key. `B_WEBSOCKET_ONLY` does **not** and cannot — Neon's WebSocket
> wire proxy terminates TLS itself and then asks for a cleartext password, offering no SASL
> mechanism at all, so there is no server signature to check on that leg. A (b) run therefore
> reports `peer verified = false` with
> `peer_verification_reason = cleartext_auth_no_server_signature`, and that is the *expected*
> value there, not a failure.
>
> What (b) still establishes: the far end held a real Postgres **session** — `SET LOCAL` nonce
> readback, one backend pid across an explicit transaction, the GUC scoped out after `COMMIT`,
> and a prepared statement surviving a round trip — while Neon's one-shot HTTP endpoint, using
> the same credential against the same project on the same run, failed those same assertions.
> That rules out something that merely accepted a channel. Beyond it, the peer is only as
> trusted as the runtime's TLS certificate validation of the `wss` endpoint. Say this in the
> write-up; do not let (b) be read as (a).

`INCONCLUSIVE_ORIGIN_UNVERIFIED` · `INCONCLUSIVE_NO_BASELINE_EGRESS` ·
`INCONCLUSIVE_TCP_REACHABLE` · `INCONCLUSIVE_WS_OPEN` · `INCONCLUSIVE_PEER_UNVERIFIED` ·
`INCONCLUSIVE_CONTROL_ABSENT` · `INCONCLUSIVE_CONTROL_SUSPECT` ·
`INCONCLUSIVE_WS_CLIENT_UNPROVEN` · `INCONCLUSIVE_PRECONDITION` (all 30) — **the plan does not
branch on any of these.** Record which one, and what the report said was missing.

`CALIBRATION_ONLY` (50) — a `--local` run. Never the answer, whatever its `wouldBeVerdict` says.

**Verdict recorded: `A_RAW_TCP_OK` (exit 0).**

**Because:** a deployed Cloudflare Container in colo LAX opened an unrestricted raw outbound TCP
connection to Neon on 5432, completed TLS 1.3 with a validated certificate, completed
SCRAM-SHA-256 with a **verified server signature**, and then held a real session — `SET LOCAL`
nonce readback, one backend pid across an explicit transaction, the GUC scoped out after
`COMMIT`, and a prepared statement surviving a round trip. The one-shot HTTP control, using the
same credential against the same project in the same run, failed those same assertions, which is
what shows the battery can register a negative rather than passing everything.

**Assumption 4 now reads:** confirmed by measurement rather than inferred. The plan's
"inferred from Containers being a real Linux environment rather than confirmed against
Cloudflare's egress documentation" language is now stale and can be replaced with a reference to
this result — with the standing caveat below that Cloudflare documents no commitment here, so
this is a current-state fact and not a guarantee.

**KTD2 does not change:** it stands as written. Pooled TCP, prepared statements, the per-tenant
`postgres.js` connection LRU, and no Hyperdrive slot are all reachable. The priced no-branch
stays unused.

**The 128 MB question is not reopened:** that question only arises on the Workers fallback, which
this result does not trigger.

---

## The three-way fork

*Exactly one row should be marked, and only if the verdict was one of the three conclusive
ones. If the verdict was any `INCONCLUSIVE_*` or `CALIBRATION_ONLY`, mark **none** of them,
write the verdict name and what was missing, and leave the plan unbranched. A blank fork table
with a named inconclusive is a complete, correct result — it is the answer "we do not know yet,
here is precisely what we did not observe".*

| | Outcome | Observed? | Consequence |
|---|---|---|---|
| **(a)** | raw TCP on 5432 carried a full Postgres session, with a verified peer and a control that showed the battery can fail | **✅ OBSERVED** | KTD2 stands as written |
| **(b)** | no raw TCP handshake to 5432 completed at all, and `wss` on 443 carried a full Postgres session — peer NOT cryptographically verified there (cleartext auth, no server signature), so the session battery plus the discriminating control is what carries it | not reached — but **proven available** as a fallback: the `wss` arm passed its full battery in this same run | Containers KEPT, transport changes only |
| **(c)** | both failed while HTTPS from the same container worked, and calibration had proven the `ws.*` arm elsewhere | no | Workers + one-shot HTTP driver; pooled TCP, prepared statements and 128 MB headroom forfeited |
| | none of the above | no | inconclusive — name it below, do not branch |

---

## Transport table

*Copy from the report's TRANSPORTS block.*

*The report prints a `peer_verification_reason=` line under each row. Copy it — the bare
boolean is not readable on its own.*

| Transport | channel open | authenticated | peer verified | `peer_verification_reason` | session semantics |
|---|---|---|---|---|---|
| (a) raw TCP `:5432` | true | true | **true** | `scram_server_signature_verified` | **true** |
| (b) Postgres over `wss:443` | true | true | false *(expected)* | `cleartext_auth_no_server_signature` | **true** |
| one-shot HTTP `:443` (control) | true | true | false | `one_shot_http_no_wire_auth` | **false** ← the discriminator |

**Negative control** — copy the report's `negative control` line and the `control assertions:`
line beneath it. It is one of three and never a yes/no:

| | What it means for this run |
|---|---|
| `PASS — authenticated, then failed to read back the SET LOCAL nonce and failed to run a prepared statement from an earlier round trip` | The battery was shown able to register a negative. A conclusive verdict is allowed. |
| `DID NOT RUN` | The null check never happened. The probe reports `INCONCLUSIVE_CONTROL_ABSENT`; read `http.select_1` for why (a 4xx, an unreachable host, intercepted TLS) and re-run. **This is not the same as the control behaving.** |
| `SUSPECT` | A channel with no session kept per-session state. The instrument is in doubt and no verdict is usable in either direction. |

> `same_backend=true` on the control is **normal and not suspicious** — Neon keeps warm
> backends, so two one-shot requests can reach the same pid without any session existing. The
> two that must be false are `set_local_readback` and `prepared_statement`.

**Reading `peer verified`.** It is the recorded fact behind "SCRAM completed and the server
signature verified", and its meaning is **per transport**:

- **On raw TCP (a).** Neon's Postgres offers SCRAM-SHA-256 on 5432. `false` there is a real
  absence, the verdict is `INCONCLUSIVE_PEER_UNVERIFIED`, and it must not be written up as a
  pass. Unchanged.
- **On the WebSocket leg (b).** `false` with reason `cleartext_auth_no_server_signature` is the
  *expected* value: that endpoint offers no mechanism that could produce a signature. It does
  **not** block (b), which is gated on session semantics plus the negative control instead.
  Record the caveat from THE DECISION above alongside the verdict.
- **On any transport,** reason `no_authentication_requested` — the far end challenged for
  nothing and went straight to `AuthenticationOk` — is fatal and yields
  `INCONCLUSIVE_PEER_UNVERIFIED`. That one is the serious case: it is how something that merely
  accepted the channel looks.

---

## Controls — read these before believing any negative result

| Control | Result | Why it matters |
|---|---|---|
| `control.https_443` — ordinary HTTPS from the container | **pass** (148ms, HTTP 400 as expected) | A fail makes (c) impossible to claim; the verdict must be `INCONCLUSIVE_NO_BASELINE_EGRESS`. |
| `control.tcp_443` — raw TCP handshake on 443 | **pass** (35ms) | Pass + 5432 fail = **port filtering**, not a ban on raw sockets. Raise with Cloudflare before accepting (c). |
| `tcp.reachability` — SSLRequest answered with `S` | **pass** — replied `S`, so a real Postgres is there | Distinguishes "a socket opened" from "a real Postgres is there". A TCP accept with no `S` reads as interception or black-holing. |
| `cloudflare_egress_ca_present` + `extra_ca_configured` | **false + false** — no outbound HTTPS interception on this container | Presence means Cloudflare's outbound HTTPS interception is active for this container. The image's entrypoint then exports `NODE_EXTRA_CA_CERTS` for it, and `extra_ca_configured` says whether that took effect. **`present=true` with `trusted=false` explains an HTTPS-only failure as a trust-store problem, not a platform denial** — rebuild the image and re-run rather than recording a `(c)`. |
| `origin corroborated` + the `driver saw` line | **true** + `https:` / public host / `cf-ray` present, colo LAX | Whether this run was shown to have happened inside a deployed Cloudflare Container at all. False voids everything above it. |

---

## Session-semantics detail

*The load-bearing stages. Fill in for whichever transport carried a session.*

| Stage | Result | Proves |
|---|---|---|
| `tcp.authenticate` — `auth_method` + `server_signature_verified` + `peer_verification_reason` | | The far end holds this role's stored key, so it is not a terminator that merely accepted the socket. (A byte-relaying proxy is NOT ruled out — plain SCRAM has no channel binding.) |
| `ws.authenticate` — `auth_method` + `peer_verification_reason` | | Only that the far end **challenged for a credential and accepted it**, over TLS. Expect `auth_method=cleartext-password` and `peer_verification_reason=cleartext_auth_no_server_signature`: Neon's wire proxy offers no SASL, so this stage proves nothing about the peer's identity. On this transport the four rows below, contrasted with the `http.*` control, are what rule out a terminator. |
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
| TCP connect to 5432 | 37 |
| TLS handshake | 39 (TLS 1.3, certificate authorized) |
| WebSocket upgrade to `/v2` | 130 |
| SCRAM authenticate (raw TCP) | 142 |
| cleartext-password authenticate (WebSocket) | 72 |
| Total run | 1943 |

---

## Notes carried by the report

*Pasted verbatim from the report. Already redacted.*

```
- The connection string carries `channel_binding=require`. That is a client-side preference, not
  a server requirement, and neither transport honours it. On the Postgres port this probe
  negotiates plain SCRAM-SHA-256 rather than SCRAM-SHA-256-PLUS. On the WebSocket leg the question
  does not arise at all: Neon's wire proxy asks for a cleartext password and offers no SASL, so
  there is no binding to require. Neither is a finding.
- The one-shot HTTP endpoint answered SELECT 1 over the same credential and then failed both
  assertions that require a session — it did not read back the `SET LOCAL` nonce, and a prepared
  statement created by one request did not exist in the next. That is the control that proves the
  WebSocket transport above is a real session and not the HTTP function wearing a different name.
  It matters more than it used to: the WebSocket leg cannot verify a peer signature (Neon's proxy
  offers none), so this contrast is the whole argument there against a channel that was merely
  accepted.
```

---

## Anything surprising

**Two instrument defects were found by running this, and both had to be fixed before the answer
could be trusted. Neither was a Cloudflare or Neon problem.**

**1. The WebSocket arm could not authenticate, and it silently made `(b)` unreachable.** The first
calibration failed `ws.authenticate` with *"unsupported authentication request 3"*. Request 3 is
`AuthenticationCleartextPassword`: Neon's serverless proxy terminates TLS itself and asks for a
cleartext password, offering no SASL at all. Neon documents why — SCRAM-SHA-256 is deliberately
CPU-expensive (~100ms), which blows a Workers-class budget, so they use password auth inside TLS
and compensate by issuing only random passwords.

The probe implemented SCRAM only, and the earlier hardening pass had gated verdicts (a) *and* (b)
on a verified peer signature. Since that signature cannot exist on Neon's WebSocket leg, **`(b)`
was unreachable against real Neon** — a container with raw TCP blocked would have reported
`INCONCLUSIVE_PEER_UNVERIFIED` rather than the answer that keeps Containers. A guard that is
correct on raw TCP was wrong on WebSocket, because on that leg the load-bearing property is
session semantics, not peer identity. Fixed: cleartext is accepted **only** where the transport
reports itself encrypted and the caller asked for that policy — raw TCP still refuses it as a
genuine downgrade — and `(b)` is now gated on session semantics plus the discriminating control.

**2. The origin gate rejected a genuine deployed run.** The first container run returned
`INCONCLUSIVE_ORIGIN_UNVERIFIED`, refusing itself. It required a `cf-ray` header on the request
*arriving at* the Worker. Cloudflare emits `cf-ray` as a **response** header; a Worker does not
reliably see one inbound. The inbound signal is `request.cf`, which was present, alongside colo
LAX and eight `CLOUDFLARE_*` placement markers in the container's environment.

Dropping that requirement does **not** reopen the false positive it existed to prevent: a
`wrangler dev` run on a laptop still fails the driver's independent half — scheme `http:` not
`https:`, loopback not a public host, and no response `cf-ray` at all. What replaced it is
stronger than what it asserted: when the Worker's `cf.colo` and an inbound ray colo are both
present they must now **agree**. The driver's cross-vantage colo comparison was deliberately left
**non-fatal**, because a request can enter at one edge colo while the container is placed in
another — requiring agreement there would have manufactured a fresh false negative.

**Both defects are the same shape as the ones the adversarial review caught earlier**, and both
were found only by running the probe against real infrastructure. An instrument that has never
been pointed at the real thing has not been shown to work in either direction.

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
- That no **relaying** proxy sits in the path on the raw TCP arm. SCRAM without channel binding
  cannot detect a byte forwarder — its relayed server signature verifies legitimately. What is
  ruled out there is a peer that terminates the connection without holding the role's key.
- **Peer identity at all on the WebSocket arm.** Neon's wire proxy asks for a cleartext password
  inside its own TLS and offers no SASL, so there is no server signature to verify and none is
  claimed. What a `(b)` verdict rules out is a thing that merely accepted a channel — via the
  session battery, contrasted against the one-shot HTTP control on the same run. It does not
  identify the thing on the other end. The remaining assurance there is the runtime's TLS
  certificate validation of the `wss` endpoint, so whatever ships under (b) must not disable it.
- Anything about a colo other than the one recorded above, or about any port other than the one
  dialled.

---

## Follow-ups filed

| | |
|---|---|
| Plan lines updated (Assumption 4, KTD2, U1 step 6) | **not yet** — Assumption 4's "inferred rather than confirmed" wording is now stale and should cite this result. Left for the plan's owner rather than edited mid-execution. |
| Re-check scheduled before U6 | **required.** One run, one colo (LAX), one instance type, one date, and Cloudflare documents no commitment about raw outbound TCP. Re-run before U6 ships and again before the U13 bake. |
| Cloudflare support thread opened (only if 443 raw TCP worked and 5432 did not) | not needed — 5432 worked |
| Probe deleted (`wrangler delete`) and throwaway Neon project removed | yes — both torn down immediately after this result was recorded |
