# Container raw-TCP probe

**Settles:** Assumption 4 (plan `docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`)
**Question:** can a **deployed Cloudflare Container** open unrestricted raw outbound TCP to
Neon on 5432 — and if not, does the Postgres wire protocol survive over a WebSocket on 443?
**Blocking for:** KTD2's whole rationale (pooled TCP, prepared statements, the per-tenant
`postgres.js` connection LRU, no Hyperdrive slot), and the 128 MB question before U6 is built.

Run it in Phase 0, before U6 exists. Running it after Phases 0–3 would strand real work.

---

## Why this probe exists

Assumption 4 is written down in the plan as *inferred, not confirmed*: "it is inferred from
Containers being a real Linux environment rather than confirmed against Cloudflare's egress
documentation." That inference is doing a lot of work — KTD2 rejects both Workers and
Hyperdrive on its strength.

Cloudflare's own container-egress documentation talks exclusively about **HTTP and HTTPS**
(`enableInternet`, outbound interception handlers, a CA certificate at
`/etc/cloudflare/certs/`), and says nothing about raw sockets to non-HTTP ports. So the
question is genuinely open in both directions, and it is cheap to settle.

**The trap this probe is built to avoid** is a two-way answer. There are three outcomes, and
the middle one costs almost nothing while the last one costs a runtime rewrite:

| | what happened | what it costs |
|---|---|---|
| **(a)** | raw TCP on 5432 works | nothing — KTD2 stands as written |
| **(b)** | raw TCP fails, **but** the Postgres protocol over `wss` on 443 works | **Containers are KEPT.** Session and transaction semantics survive, so `SET LOCAL hnsw.ef_search`, prepared statements and the per-tenant LRU all survive. Only the transport changes. |
| **(c)** | both fail | Workers + the one-shot HTTP driver. Pooled TCP, prepared statements and the 128 MB headroom are genuinely forfeited; self-hosted rerank (KTD4) goes out of reach; consolidation stays on Containers anyway, leaving a split runtime. |

A naive probe collapses (b) into (c) — the plan already had to correct that confusion once.
So this probe tests **both transports independently**, and reports which of (a)/(b)/(c) it
observed, or refuses to answer.

---

## What this probe can and cannot prove

**It can prove:**

- Whether a raw outbound TCP socket to port 5432 opens from inside a deployed container, and
  whether a *real Postgres* is on the other end (the SSL negotiation is answered with `S`).
- Whether a full Postgres session authenticates over each transport — and, **on the raw TCP
  arm**, with mutual SCRAM including verification of the **server's** signature. That rules out
  a terminator which merely accepted the socket: the far end has to hold this role's stored
  key. The facts (`auth_method`, `scram_started`, `server_signature_verified`,
  `peer_verification_reason`) are recorded on the authenticate stage.

  **On the WebSocket arm there is no such proof, and the report says so rather than implying
  otherwise.** Neon's wire proxy (`wss://<host>/v2`) terminates TLS itself and then asks for
  `AuthenticationCleartextPassword`; it offers no SASL mechanism at all. Neon documents this as
  deliberate — SCRAM's PBKDF2 is specified to cost ~100ms of CPU, which does not fit a
  serverless budget — and `@neondatabase/serverless` reflects it from the other side with its
  default `pipelineConnect: "password"`. So that transport records
  `peer_verification_reason: cleartext_auth_no_server_signature`, `peerVerified: false`, and the
  peer-verification gate is scoped per transport: **(a) still requires a verified SCRAM server
  signature; (b) turns on session semantics instead.** Requiring a signature the endpoint cannot
  produce would not raise the bar — it would make (b) unreachable against real Neon, turning a
  KEEP-Containers answer into an inconclusive.

  What does *not* change: a far end that challenges for **no** credential at all
  (`no_authentication_requested`) is refused on every transport, because that is precisely the
  terminator shape. And a cleartext password is only ever sent when the caller's transport
  policy asks for it **and** the transport reports itself encrypted; the raw TCP arm asks for
  SCRAM only, so being offered cleartext on 5432 is still a failure and still a finding.
- Whether **session semantics** survive: `SET LOCAL` read back inside an explicit transaction,
  the same backend pid across statements in that transaction, the GUC scoped out after
  `COMMIT`, and a named prepared statement usable between round trips. This — not the
  handshake — is the property KTD2 rests on.
- Whether raw TCP works on 443 but not 5432, which is port filtering rather than a blanket ban
  and is worth a support conversation before accepting the expensive branch.

**It cannot prove:**

- That the behaviour is stable. It is one run, on one instance type, in one colo, on one date.
  Cloudflare Containers carry no documented commitment about raw egress, so a pass is a
  *current-state* fact, not a guarantee. Record the date and colo in `RESULT.md` and re-check
  before U6 ships.
- That there is no **relaying** proxy in the path, on the raw TCP arm. SCRAM without channel
  binding cannot detect one: a byte forwarder passes the exchange upstream and the returned
  signature verifies legitimately. Channel binding is the only mechanism that would catch it,
  and it is deliberately not used. What *is* ruled out there is a peer that *terminates* the
  connection without holding the role's key.
- **Peer identity at all, on the WebSocket arm.** That endpoint offers no mechanism with mutual
  proof (see above), so a `(b)` verdict cannot claim what `(a)` claims. What stands behind the
  peer on that leg is the runtime's TLS certificate validation of the `wss` endpoint, plus the
  session battery — `SET LOCAL` nonce readback, one backend pid across an explicit transaction,
  the GUC scoped out after `COMMIT`, and a prepared statement surviving a round trip — every one
  of which Neon's one-shot HTTP endpoint fails on the same run. That contrast rules out a thing
  that merely accepted a channel. It does not identify the thing on the other end.
- That `postgres.js` specifically will work. It proves the wire protocol and session semantics
  work; `postgres.js` uses protocol-level named statements where this probe uses SQL-level
  `PREPARE`/`EXECUTE`. Those are the same underlying property — a named statement persisting
  in backend session state between round trips — so if one survives, so does the other. The
  probe carries no driver on purpose (see "Design constraints" below).
- Anything about throughput, connection limits, LRU behaviour under load, or wake latency.
  It opens one connection per transport.
- Anything at all, if you run it with `--local`. That mode measures **your laptop**, always
  reports the verdict `CALIBRATION_ONLY`, and always exits 50.

---

## The one shortcut that would invalidate everything: `wrangler dev`

Containers need a Workers Paid plan, and the first `wrangler deploy` on Apple Silicon builds
the image under amd64 emulation. Both make it tempting to "just see it work first" with
`bunx wrangler dev`, which runs the identical image in **local Docker on your machine** and
answers on `http://localhost:8787`. That container opens raw TCP to 5432 from your laptop's
Docker bridge, passes every stage, and — before this was fixed — stamped `origin: 'container'`
and a verdict of `A_RAW_TCP_OK` on the result.

A probe that certifies Assumption 4 from a laptop is worse than no probe, because the whole
KTD2 rationale rests on the answer. So a container run must now **show** where it ran:

| Evidence | Who observes it | Why a local run cannot produce it |
|---|---|---|
| a Cloudflare `cf` object on the incoming request | the Worker | absent under a plain `wrangler dev` |
| a colo | the Worker (`request.cf.colo`) | there is no colo on a laptop |
| a `cf-ray` header on the **request** | the Worker | added by Cloudflare's edge |
| a `cf-ray` header on the **response** | **the driver on your machine** | a local dev server does not emit one |
| `https` scheme and a public, non-loopback host | **the driver** | `wrangler dev` serves `http://localhost` |

The last two matter most: they are the only checks that do not depend on believing the report.
The driver may only ever **downgrade** a verdict on this evidence, never upgrade one, and it
records what the container claimed in `driver.containerVerdict` so the artifact shows both the
claim and the refusal. Missing any of them gives `INCONCLUSIVE_ORIGIN_UNVERIFIED` (exit 30).

Running under `wrangler dev --remote` does execute on Cloudflare and will satisfy these checks;
it is a preview deployment rather than the deployed Worker, so note it in `RESULT.md` if you
take that route.

---

## Prerequisites

- A Cloudflare account on a **Workers Paid** plan. Containers are not available on the free
  plan.
- Docker running locally. `wrangler deploy` builds the image and pushes it.
- `bunx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the environment).
- A **throwaway** Neon project. Do not point this at anything that matters — the probe runs
  `SET LOCAL`, `PREPARE`, `BEGIN`/`COMMIT` and (harmlessly) leaves nothing behind, but a
  throwaway is one click and this is a public repo.
- On an Apple Silicon Mac the first `wrangler deploy` is slow: Containers run `linux/amd64`,
  so the image is built under emulation.

---

## Environment variables

**Set as Worker secrets** (never in a file — this repo is public):

| Variable | Where | What |
|---|---|---|
| `PROBE_DATABASE_URL` | `wrangler secret put` | The **DIRECT** (non-`-pooler`) Neon connection string. |
| `PROBE_AUTH_TOKEN` | `wrangler secret put` | Any random string. Without it the Worker refuses **every** request — its `*.workers.dev` URL is public and this endpoint runs SQL. Set it with `printf %s '<token>' \| wrangler secret put ...` or at the interactive prompt: `echo` appends a newline, and the mismatch that causes is the most common 401. |
| `PROBE_ALLOW_POOLER` | `wrangler secret put` (optional) | `"1"` to allow a `-pooler` endpoint. Either this or the per-call flag enables it. |
| `PROBE_ALLOW_NONSTANDARD_PORT` | `wrangler secret put` (optional) | `"1"` to allow a DSN whose port is not 5432. Either this or the per-call flag enables it. |

**Set in your shell** for the driver (`bun run probe:container-tcp`):

| Variable | Mode | What |
|---|---|---|
| `PROBE_URL` | verdict | `https://brainz-probe-container-tcp.<your-subdomain>.workers.dev` — must be `https` and a public host, see the `wrangler dev` section above. |
| `PROBE_AUTH_TOKEN` | verdict | The same random string you gave `wrangler secret put`. |
| `PROBE_DATABASE_URL` | `--local` | The direct Neon connection string, for calibration. |
| `PROBE_TLS_INSECURE` | `--local` only | `1` to skip TLS certificate verification — only if a corporate MITM proxy sits between your laptop and the internet. It is **not** accepted over the wire: the container reads it from its own environment only, so nobody can disable the certificate check on the run that settles the question. |
| `PROBE_ALLOW_POOLER` | either | `1`. Forwarded to the container per call, so the shell value works in verdict mode too — as does the Worker secret above; either one enables it. See below. |
| `PROBE_ALLOW_NONSTANDARD_PORT` | either | `1`. Same forwarding. See "the port is part of the question" below. |

Per-call knobs (`--timeout`, `--allow-pooler`, `--allow-nonstandard-port`) are sent in the
request body and forwarded by the Worker, so they take effect in **both** modes.

### The port is part of the question

Assumption 4 is a claim about raw outbound TCP to **5432**. Every port in this probe is
DSN-derived, so a DSN naming some other port would produce a true measurement of the wrong
thing — and would also collapse the `control.tcp_443` arm if it happened to name 443. The probe
refuses a non-5432 DSN (`INCONCLUSIVE_PRECONDITION`) unless you set
`PROBE_ALLOW_NONSTANDARD_PORT=1`, which is the right thing to do when you are deliberately
testing port filtering. Every verdict string then names the port that was actually dialled, and
the run says out loud that Assumption 4 as written is not settled by it.

### Do not use a `-pooler` connection string

Neon's dashboard hands out the pooled endpoint by default, and it is the wrong one here.
PgBouncer transaction pooling breaks `SET LOCAL` readback and standalone `PREPARE`/`EXECUTE`
**by design**, so the session battery would fail on a perfectly working raw TCP connection and
this probe would report (b) or (c) when the true answer is (a). The probe refuses a
`-pooler` host for exactly that reason.

KTD2's "pooled TCP" means the client-side `postgres.js` pool, not PgBouncer. Use the direct
endpoint (the host **without** `-pooler`).

---

## How to run

### 1. Calibrate on your laptop first — this step is not optional

```bash
export PROBE_DATABASE_URL='postgresql://<role>:<password>@<direct-host>/<db>'
bun run probe:container-tcp -- --local
```

This runs the **identical** probe code against the **same** Neon project from your machine.
It settles nothing about Cloudflare, always reports `CALIBRATION_ONLY`, and always **exits
50** — a calibration can never be mistaken for the answer by a script or by a reader. The
report still carries `wouldBeVerdict`: what the same evidence would have meant from a
container.

What calibration buys you is twofold:

1. It removes the most expensive failure mode. If the container run later fails, calibration
   having passed is what makes that failure attributable to the platform rather than to this
   probe's wire implementation.
2. It writes `result-calibration-receipt.json` (gitignored) recording whether this probe's
   hand-rolled **WebSocket** client was ever seen carrying a session. The driver requires that
   receipt before it will let a container run claim `(c)` — see rule 5 below.

Expect every `tcp.*` stage to pass. The `ws.*` and `http.*` stages should also pass against a
real Neon host; if `ws.*` does not pass here, fix that before reading anything into a `(c)`.

### 2. Deploy

Deploy first, then set the secrets. `wrangler secret put` against a Worker that does not exist
yet prompts to create one — fine interactively, a failure in CI.

```bash
cd /path/to/brainz
bunx wrangler deploy                        -c scripts/probes/container-tcp/wrangler.toml
bunx wrangler secret put PROBE_DATABASE_URL -c scripts/probes/container-tcp/wrangler.toml
bunx wrangler secret put PROBE_AUTH_TOKEN   -c scripts/probes/container-tcp/wrangler.toml
```

Wrangler prints the deployed URL. That is your `PROBE_URL`. Until `PROBE_AUTH_TOKEN` is set the
Worker answers 503 to everything, on purpose.

### 3. Get the verdict

```bash
export PROBE_URL='https://brainz-probe-container-tcp.<subdomain>.workers.dev'
export PROBE_AUTH_TOKEN='<the same random string>'
bun run probe:container-tcp
```

The first call after a deploy wakes a cold container **and** a cold Neon compute. Stage
deadlines default to 15 s and the whole-run ceiling is derived from them, but if you see
`INCONCLUSIVE_TCP_REACHABLE` on the first call, retry — and raise the deadline if it repeats:

```bash
bun run probe:container-tcp -- --timeout=30000
```

`bunx wrangler tail -c scripts/probes/container-tcp/wrangler.toml` shows the container's stdout
if it never starts.

### 4. Record it

Fill in `RESULT.md` in this directory. That file is the durable answer; the terminal output
scrolls away. The raw JSON is written to `result-<origin>-<timestamp>.json`, which is
gitignored — copy the redacted summary into `RESULT.md`, not the raw file.

### 5. Tear down

```bash
bunx wrangler delete -c scripts/probes/container-tcp/wrangler.toml --name brainz-probe-container-tcp
```

`-c` is not optional: without it, wrangler resolves against the repo-root `wrangler.toml`, which
is the real fleet.

Then delete the throwaway Neon project. Leaving the Worker deployed leaves a public endpoint
that holds a database credential.

---

## Reading the output

### Verdicts

| Verdict | Exit code | Meaning |
|---|---|---|
| `A_RAW_TCP_OK` | 0 | (a). Assumption 4 holds. KTD2 unchanged. |
| `B_WEBSOCKET_ONLY` | 10 | (b). Containers kept; transport changes to `@neondatabase/serverless` `Pool`/`Client` over WebSocket. **Peer identity is NOT cryptographically verified at the Postgres layer on this transport** — Neon's wire proxy asks for a cleartext password inside its own TLS and offers no SASL. (b) is carried by session semantics plus the negative control, not by a server signature. Do not quote it as equivalent to (a). |
| `C_BOTH_BLOCKED` | 20 | (c). The priced no-branch applies. Re-open the 128 MB question. |
| `INCONCLUSIVE_ORIGIN_UNVERIFIED` | 30 | This run could not be shown to have happened on Cloudflare. The likeliest cause is `wrangler dev`. |
| `INCONCLUSIVE_NO_BASELINE_EGRESS` | 30 | Nothing got out, including plain HTTPS. A statement about this run, not about Cloudflare. |
| `INCONCLUSIVE_TCP_REACHABLE` | 30 | A raw socket to the Postgres port opened, but no session came out of it. Leaning (a); (b) and (c) are both forbidden here. |
| `INCONCLUSIVE_WS_OPEN` | 30 | The WebSocket upgraded but the session did not complete. Leaning (b). |
| `INCONCLUSIVE_PEER_UNVERIFIED` | 30 | A transport carried a full session, but the authentication on it was not one this probe accepts *for that transport*. On raw TCP that means no verified SCRAM server signature (Neon does offer SCRAM there, so its absence is the finding). On the WebSocket leg a cleartext password is accepted, so landing here means something else — most likely `no_authentication_requested`: the far end challenged for nothing. Read `peer_verification_reason` on the authenticate stage. |
| `INCONCLUSIVE_CONTROL_ABSENT` | 30 | A transport passed, but the negative control never ran — the battery was never shown able to fail. |
| `INCONCLUSIVE_CONTROL_SUSPECT` | 30 | The negative control kept per-session state (read back the `SET LOCAL` nonce, or ran a prepared statement from an earlier round trip). The instrument is in doubt; no verdict is usable in either direction. |
| `INCONCLUSIVE_WS_CLIENT_UNPROVEN` | 30 | (c) was indicated, but this probe's own WebSocket client has never been observed working anywhere. |
| `INCONCLUSIVE_PRECONDITION` | 30 | The probe refused to run — bad DSN, a `-pooler` endpoint, or a port that is not 5432. |
| `CALIBRATION_ONLY` | 50 | A `--local` run. Never a verdict, whatever the evidence. Read `wouldBeVerdict`. |
| *(no report)* | 40 | The driver could not run at all: missing env var, unreachable endpoint, or a response that was not a report from this probe. |

**Do not branch the plan on any `INCONCLUSIVE_*`.** That is the point of them existing.

### The rules that make this trustworthy in both directions

The governing rule, from which the rest follow: **absence of evidence is never evidence of
success.** A missing signal, a swallowed error, an unreachable control or a degraded instrument
produces a named `INCONCLUSIVE_*` with a non-zero exit code — never a pass, and never a
decisive fail either.

1. **A handshake is never the answer.** The verdict reads `sessionSemantics`, which requires
   `SET LOCAL` readback, same-backend continuity, transaction scoping and a surviving prepared
   statement. A half-open socket, a transparent proxy or a silently re-established connection
   would all pass a handshake check and fail this.
2. **The run must prove where it happened.** `origin: 'container'` is a claim the container
   writes about itself. A conclusive verdict additionally requires the Worker to have seen a
   Cloudflare `cf` object, a colo and an inbound `cf-ray`, *and* the driver to have seen a
   `cf-ray` on the response it received over `https` from a public host. See the `wrangler dev`
   section above.
3. **Reachability gates nothing.** The throwaway reachability probe is diagnostic only; the
   real transport always opens its own socket. And because (b) and (c) both assert that raw TCP
   did *not* work, neither may be issued once a handshake to the Postgres port has completed —
   even if the WebSocket arm sailed through. That case is `INCONCLUSIVE_TCP_REACHABLE`, and one
   lost packet is enough to cause it, so re-run before reading anything into it.
4. **The peer must authenticate itself to us as far as the transport allows — and the report
   must say how far that is.** `auth_method`, `scram_started`, `server_signature_verified` and
   `peer_verification_reason` are recorded as facts on the authenticate stage. The wire client
   refuses an `AuthenticationOk` that arrives mid-SASL without a verifiable SASLFinal (the one
   message a peer that cannot complete SCRAM is unable to forge), refuses a mid-exchange
   downgrade from SASL to cleartext, and refuses a cleartext request on any transport that did
   not ask for it or that does not encrypt what it sends.

   The gate is then **per transport**, because `peerVerified` comes from SCRAM and Neon's
   WebSocket proxy has no SCRAM to give:

   | | (a) raw TCP `:5432` | (b) `wss:443` |
   |---|---|---|
   | What Neon offers | SCRAM-SHA-256 | cleartext password inside the `wss` TLS; no SASL |
   | Accepted by the probe | SCRAM only — cleartext is a refused downgrade | cleartext, over an encrypted transport |
   | `peerVerified` | must be `true` | `false`, reason `cleartext_auth_no_server_signature` |
   | What the verdict rests on | verified server signature **+** session semantics | session semantics **+** the negative control |
   | Always fatal | `no_authentication_requested` | `no_authentication_requested` |

   This is a real weakening of what (b) asserts, and it is stated in the verdict text, in the
   run notes and in the transports table rather than left for a reader to infer. The
   alternative was worse: requiring a signature that endpoint cannot produce made (b)
   unreachable against real Neon, so a container with raw TCP blocked would have reported
   `INCONCLUSIVE_PEER_UNVERIFIED` instead of the branch on which Containers are **kept**.
5. **The instrument must be shown able to fail, and (c) needs its own control.** The one-shot
   HTTP driver runs the identical battery as a negative control. It must authenticate and then
   fail the two assertions that can only hold on a real session: the `SET LOCAL` nonce readback
   and the prepared statement. (It is *not* required to land on a different backend pid — Neon
   keeps warm backends, so two one-shot requests genuinely can reach the same one; requiring
   that would make the control flap on a true negative.) If it never authenticated, the null
   check did not happen and a passing transport reports `INCONCLUSIVE_CONTROL_ABSENT`. If
   either of those two assertions *passes*, the run is `INCONCLUSIVE_CONTROL_SUSPECT`. Its
   per-assertion results are carried in the report (`negativeControlAssertions`) so the claim is
   checkable rather than asserted.

   This control matters more on the WebSocket leg than anywhere else: with no server signature
   available there, the contrast between "the same battery passed on `wss` and failed on the
   one-shot HTTP endpoint, using the same credential against the same project" is the *whole*
   argument that the far end held a real session rather than merely accepting a channel.

   And because a rejected WebSocket upgrade (`EWSUPGRADE`) is byte-identical to a bug in this
   probe's own handshake, `(c)` also requires a calibration receipt showing the WebSocket arm
   working somewhere — `INCONCLUSIVE_WS_CLIENT_UNPROVEN` otherwise.
6. **(c) requires a working egress control.** Both transports failing is only reported as (c)
   when ordinary HTTPS egress from the same container *did* work. Otherwise it is
   `INCONCLUSIVE_NO_BASELINE_EGRESS` — a config or credential problem, not an architecture
   finding.

---

## What each outcome means for the plan

**(a) `A_RAW_TCP_OK`** — Mark Assumption 4 verified in the plan with the date and colo. KTD2
needs no change. `docs/porting-hazards.md` and the real-substrate CI workflow proceed as
written.

**(b) `B_WEBSOCKET_ONLY`** — Keep Containers. Change the transport, not the runtime:
`@neondatabase/serverless`'s `Pool`/`Client` over WebSocket, **not** the `neon()` HTTP
function. Update Assumption 4's line to record the transport change, note that opening a
connection now costs a WebSocket upgrade (which makes the per-tenant LRU *more* valuable, not
less), and leave KTD2's rejections of Workers and Hyperdrive standing. The 128 MB question
does **not** reopen.

**(c) `C_BOTH_BLOCKED`** — Take the priced no-branch: Workers plus Neon's HTTP driver. Pooled
TCP, prepared statements and the 128 MB headroom are forfeited. Re-open the 128 MB question
before U6 is built, and expect a split runtime because consolidation cycles still belong on
Containers. This is the expensive branch, so it is also the one with the most preconditions —
the probe will only issue it once all of these hold. Check them yourself before acting:

- `control.https_443` passed (otherwise it is `INCONCLUSIVE_NO_BASELINE_EGRESS`).
- No raw TCP handshake to the Postgres port completed at any point in the run (otherwise
  `INCONCLUSIVE_TCP_REACHABLE`).
- A calibration receipt exists showing the `ws.*` arm working against this same Neon project,
  so the WebSocket failure is Cloudflare's and not ours (otherwise
  `INCONCLUSIVE_WS_CLIENT_UNPROVEN`).
- `control.tcp_443`: if raw TCP to 443 succeeded while the Postgres port did not, this is port
  filtering, not a ban on raw sockets, and it is worth raising with Cloudflare first.

---

## Escalation when the result is inconclusive

Calibration passing on your laptop and the container failing at the same stage is the
interesting case. If you need to rule out this probe's own wire implementation entirely, add
the real drivers **inside the image only** — never to the repo's `package.json`:

```dockerfile
# scripts/probes/container-tcp/Dockerfile — escalation only, do not commit
RUN bun add postgres @neondatabase/serverless
```

- `postgres` (postgres.js) for the raw TCP path — the driver KTD2 actually names.
- `@neondatabase/serverless` for the WebSocket path: use `Pool` or `Client`, **not** the
  `neon()` tagged-template function. `neonConfig.useSecureWebSocket` defaults to `true`, which
  is the `wss://<host>/v2` transport this probe already speaks by hand.

This is documented rather than shipped because the calibration run covers the same risk at
zero dependency cost, and because a probe that pulls from a package registry can fail for
reasons that have nothing to do with the question.

---

## Blast radius and cleanup

- **Cloudflare:** one Worker, one Durable Object class, one container instance
  (`standard-1`, `max_instances = 1`, `sleepAfter = "2m"`). Nothing touches the `brainz-fleet`
  Worker or the repo-root `wrangler.toml`. Delete with `wrangler delete -c
  scripts/probes/container-tcp/wrangler.toml --name brainz-probe-container-tcp` — always with
  `-c`, or wrangler resolves against the fleet's root config.
- **Neon:** no DDL, no writes, no rows. `SET LOCAL` and `PREPARE` are session-scoped and gone
  when the connection closes. The optional `hnsw.ef_search` check only runs if the `vector`
  extension is already installed; it never creates it.
- **This repo:** `result-*.json` (including `result-calibration-receipt.json`) is gitignored.
  `RESULT.md` is committed and must stay redacted — the probe's own output already replaces the
  Neon hostname with a fingerprint, in error strings too, and the probe endpoint's own host is
  fingerprinted the same way because a `*.workers.dev` subdomain identifies the account. A
  credential shorter than three characters cannot be pattern-redacted without shredding the
  report; the run says so out loud in its notes rather than emitting it silently.

---

## Design constraints this probe honours

- **No new dependencies.** `@cloudflare/containers` and `wrangler` were already
  devDependencies; nothing was added. The Postgres protocol, SCRAM-SHA-256 and base64 are
  implemented here over Bun and Node built-ins.
- **One protocol implementation, two transports.** Using a different driver per transport
  would mean a difference in outcome could be a difference between drivers. The same bytes go
  over both channels, so the difference is the transport.
- **Nothing credential-shaped is ever emitted.** The connection string, role, password and
  hostname are replaced before any string enters the report — including inside error messages,
  which is where an endpoint id would otherwise leak into a public repo via `RESULT.md`.
- **Every wait is bounded**, including the DNS lookup. Filtered egress usually presents as a
  silent SYN drop, not a refusal, so an unbounded probe would hang and report nothing — which
  reads, to whoever ran it, exactly like a failure. The whole-run ceiling inside the container
  is derived from the stage deadline rather than fixed, so raising `--timeout` cannot turn a
  fully-blocked run into a 504 with no report at all.
- **Fail closed, in both directions.** No `PROBE_AUTH_TOKEN`, no service. No corroborated
  origin, no verdict. No demonstrated null result, no pass.
- **Cloudflare's egress CA is trusted, not merely noticed.** When
  `/etc/cloudflare/certs/cloudflare-containers-ca.crt` exists, the image's entrypoint exports
  `NODE_EXTRA_CA_CERTS` for it. Detecting interception and then failing every HTTPS candidate on
  certificate validation would report a misconfiguration as a platform denial. The report
  records both `cloudflare_egress_ca_present` and whether it took effect
  (`extra_ca_configured`).

---

## Files

| File | What |
|---|---|
| `probe.ts` | The driver. `bun run probe:container-tcp` (verdict) or `-- --local` (calibration). |
| `driver-gate.ts` | What the driver establishes for itself: endpoint shape, Cloudflare's `cf-ray`, report validation, the calibration receipt. May downgrade a verdict, never upgrade one. |
| `worker.ts` | The Worker + container Durable Object. Authenticates, injects the DSN, forwards to the container. Opens no connection itself. |
| `wrangler.toml` | Throwaway deployment config. Separate Worker from the fleet. |
| `Dockerfile` / `.dockerignore` | The throwaway image. No dependency install step. |
| `container/server.ts` | The container entrypoint. `GET /health`, `POST /probe`. |
| `container/run.ts` | Stage orchestration, redaction, report assembly. |
| `container/transports.ts` | The three byte channels plus the two reachability probes. |
| `container/pg-wire.ts` | The Postgres v3 protocol, transport-agnostic. Owns the per-transport `AuthPolicy` — SCRAM-only by default, cleartext password only where a caller asks for it on an encrypted transport. |
| `container/scram.ts` | SCRAM-SHA-256 with server-signature verification. Raw TCP arm only; Neon's WebSocket proxy offers no SASL. |
| `container/battery.ts` | The session-semantics battery, run identically on all three channels. |
| `container/report.ts` | Report types, the redactor, the attestation shape, `PeerVerificationReason`, the negative-control classifier, and the verdict rule. |
| `auth-transport.test.ts` | `bun test` — the per-transport auth rules against a scripted in-memory backend (cleartext accepted on `wss`, refused on raw TCP *before the credential is transmitted*, downgrade and unencrypted-transport refusals), credential containment, the negative-control discrimination coupling, and the verdict gate. Lives outside `container/` so it stays out of the image. |
| `RESULT.md` | The durable answer. Fill it in; it is committed. |

## Sources

- Cloudflare Containers overview and configuration — <https://developers.cloudflare.com/containers/>
- Container class API (`enableInternet`, `sleepAfter`, `defaultPort`) — <https://developers.cloudflare.com/containers/container-package/>
- Container egress, `enableInternet`, HTTPS interception and the CA at `/etc/cloudflare/certs/` — <https://github.com/cloudflare/containers/blob/main/docs/egress.md>
- Cloudflare Containers beta limitations — <https://developers.cloudflare.com/containers/beta-info/>
- Workers TCP sockets, and the note that outbound TCP is blocked on port 25 and to Cloudflare IP ranges — <https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>

Why the WebSocket leg authenticates with a cleartext password rather than SCRAM:

- Neon, *Quicker serverless Postgres connections* — states they moved to "simple password auth
  (which is still protected by TLS encryption)" because SCRAM-SHA-256 "is [specifically
  intended] to take about 100ms of CPU time", which does not fit a serverless CPU budget, and
  that they "generate and support only random passwords" as the compensating control —
  <https://neon.com/blog/quicker-serverless-postgres>
- `@neondatabase/serverless` `CONFIG.md` — `pipelineConnect` defaults to `"password"` and
  pipelines "the first three messages to the database (startup, authentication and first
  query)", which "will only work if you've configured cleartext password authentication";
  `forceDisablePgSSL` defaults to `true` because the WebSocket already carries TLS —
  <https://github.com/neondatabase/serverless/blob/main/CONFIG.md>
- Postgres protocol message formats — `AuthenticationCleartextPassword` is `Byte1('R')` +
  `Int32(8)` + `Int32(3)`; the response is `PasswordMessage` (`Byte1('p')`, length, the password
  as a C string) — <https://www.postgresql.org/docs/current/protocol-message-formats.html>
