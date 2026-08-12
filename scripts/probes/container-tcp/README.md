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
- Whether a full Postgres session authenticates over each transport, with mutual SCRAM —
  including verifying the **server's** signature, which is what rules out a transparent proxy
  that merely accepted the socket.
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
- That `postgres.js` specifically will work. It proves the wire protocol and session semantics
  work; `postgres.js` uses protocol-level named statements where this probe uses SQL-level
  `PREPARE`/`EXECUTE`. Those are the same underlying property — a named statement persisting
  in backend session state between round trips — so if one survives, so does the other. The
  probe carries no driver on purpose (see "Design constraints" below).
- Anything about throughput, connection limits, LRU behaviour under load, or wake latency.
  It opens one connection per transport.
- Anything at all, if you run it with `--local`. That mode measures **your laptop**.

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
| `PROBE_AUTH_TOKEN` | `wrangler secret put` | Any random string. Without it the Worker refuses **every** request — its `*.workers.dev` URL is public and this endpoint runs SQL. |
| `PROBE_ALLOW_POOLER` | `wrangler secret put` (optional) | `"1"` to run against a `-pooler` endpoint anyway. See the warning below. |

**Set in your shell** for the driver (`bun run probe:container-tcp`):

| Variable | Mode | What |
|---|---|---|
| `PROBE_URL` | verdict | `https://brainz-probe-container-tcp.<your-subdomain>.workers.dev` |
| `PROBE_AUTH_TOKEN` | verdict | The same random string you gave `wrangler secret put`. |
| `PROBE_DATABASE_URL` | `--local` | The direct Neon connection string, for calibration. |
| `PROBE_TLS_INSECURE` | `--local` (optional) | `1` to skip TLS certificate verification — only if a corporate MITM proxy sits between your laptop and the internet. Never set this for the container run. |
| `PROBE_ALLOW_POOLER` | either (optional) | `1`. See below. |

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
It settles nothing about Cloudflare. What it does is remove the single most expensive failure
mode: if the container run later fails, calibration having passed is what makes that failure
attributable to the platform rather than to this probe's wire implementation. Skip it and a
red container result is ambiguous — and the ambiguous branch is the one that costs a runtime
rewrite.

Expect every `tcp.*` stage to pass. The `ws.*` and `http.*` stages should also pass against a
real Neon host.

### 2. Deploy

```bash
cd /path/to/brainz
bunx wrangler secret put PROBE_DATABASE_URL -c scripts/probes/container-tcp/wrangler.toml
bunx wrangler secret put PROBE_AUTH_TOKEN   -c scripts/probes/container-tcp/wrangler.toml
bunx wrangler deploy                        -c scripts/probes/container-tcp/wrangler.toml
```

Wrangler prints the deployed URL. That is your `PROBE_URL`.

### 3. Get the verdict

```bash
export PROBE_URL='https://brainz-probe-container-tcp.<subdomain>.workers.dev'
export PROBE_AUTH_TOKEN='<the same random string>'
bun run probe:container-tcp
```

The first call after a deploy wakes a cold container and can take a while. **If it times out,
retry once** before reading anything into it. `bunx wrangler tail -c
scripts/probes/container-tcp/wrangler.toml` shows the container's stdout if it never starts.

### 4. Record it

Fill in `RESULT.md` in this directory. That file is the durable answer; the terminal output
scrolls away. The raw JSON is written to `result-<origin>-<timestamp>.json`, which is
gitignored — copy the redacted summary into `RESULT.md`, not the raw file.

### 5. Tear down

```bash
bunx wrangler delete --name brainz-probe-container-tcp
```

Then delete the throwaway Neon project. Leaving the Worker deployed leaves a public endpoint
that holds a database credential.

---

## Reading the output

### Verdicts

| Verdict | Exit code | Meaning |
|---|---|---|
| `A_RAW_TCP_OK` | 0 | (a). Assumption 4 holds. KTD2 unchanged. |
| `B_WEBSOCKET_ONLY` | 10 | (b). Containers kept; transport changes to `@neondatabase/serverless` `Pool`/`Client` over WebSocket. |
| `C_BOTH_BLOCKED` | 20 | (c). The priced no-branch applies. Re-open the 128 MB question. |
| `INCONCLUSIVE_NO_BASELINE_EGRESS` | 30 | Nothing got out, including plain HTTPS. A statement about this run, not about Cloudflare. |
| `INCONCLUSIVE_TCP_REACHABLE` | 30 | 5432 was reachable and a real Postgres answered, but the session did not complete. Leaning (a). |
| `INCONCLUSIVE_WS_OPEN` | 30 | The WebSocket upgraded but the session did not complete. Leaning (b). |
| `INCONCLUSIVE_PRECONDITION` | 30 | The probe refused to run — bad DSN, or a `-pooler` endpoint. |

**Do not branch the plan on any `INCONCLUSIVE_*`.** That is the point of them existing.

### The four rules that make this trustworthy in both directions

1. **A handshake is never the answer.** The verdict reads `sessionSemantics`, which requires
   `SET LOCAL` readback, same-backend continuity, transaction scoping and a surviving prepared
   statement. A half-open socket, a transparent proxy or a silently re-established connection
   would all pass a handshake check and fail this.
2. **(c) requires a working control.** Both transports failing is only reported as (c) when
   ordinary HTTPS egress from the same container *did* work. Otherwise it is
   `INCONCLUSIVE_NO_BASELINE_EGRESS` — a config or credential problem, not an architecture
   finding.
3. **Reachability is measured separately from the session.** If the TCP handshake to 5432
   completes and a real Postgres answers the SSL negotiation, egress is not the blocker, and
   any later failure reports `INCONCLUSIVE_TCP_REACHABLE` rather than forfeiting pooled TCP
   over a bug in this code. The same holds for a WebSocket that upgraded.
4. **The one-shot HTTP driver runs the identical battery as a negative control.** It should
   authenticate and then fail every session assertion. Seeing it fail that way is what proves
   the WebSocket transport is a real session and not the HTTP function wearing a different
   name. If HTTP ever *passes* the session battery, the run is flagged as suspect.

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
Containers. Before accepting this, check the `control.tcp_443` stage: if raw TCP to 443
succeeded while 5432 did not, this is port filtering and worth raising with Cloudflare first.

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
  Worker or the repo-root `wrangler.toml`. Delete with `wrangler delete --name
  brainz-probe-container-tcp`.
- **Neon:** no DDL, no writes, no rows. `SET LOCAL` and `PREPARE` are session-scoped and gone
  when the connection closes. The optional `hnsw.ef_search` check only runs if the `vector`
  extension is already installed; it never creates it.
- **This repo:** `result-*.json` is gitignored. `RESULT.md` is committed and must stay
  redacted — the probe's own output already replaces the hostname with a fingerprint, in error
  strings too.

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
- **Every wait is bounded.** Filtered egress usually presents as a silent SYN drop, not a
  refusal, so an unbounded probe would hang and report nothing — which reads, to whoever ran
  it, exactly like a failure.
- **Fail closed.** No `PROBE_AUTH_TOKEN`, no service.

---

## Files

| File | What |
|---|---|
| `probe.ts` | The driver. `bun run probe:container-tcp` (verdict) or `-- --local` (calibration). |
| `worker.ts` | The Worker + container Durable Object. Authenticates, injects the DSN, forwards to the container. Opens no connection itself. |
| `wrangler.toml` | Throwaway deployment config. Separate Worker from the fleet. |
| `Dockerfile` / `.dockerignore` | The throwaway image. No dependency install step. |
| `container/server.ts` | The container entrypoint. `GET /health`, `POST /probe`. |
| `container/run.ts` | Stage orchestration, redaction, report assembly. |
| `container/transports.ts` | The three byte channels plus the two reachability probes. |
| `container/pg-wire.ts` | The Postgres v3 protocol, transport-agnostic. |
| `container/scram.ts` | SCRAM-SHA-256 with server-signature verification. |
| `container/battery.ts` | The session-semantics battery, run identically on all three channels. |
| `container/report.ts` | Report types, the redactor, and the verdict rule. |
| `RESULT.md` | The durable answer. Fill it in; it is committed. |

## Sources

- Cloudflare Containers overview and configuration — <https://developers.cloudflare.com/containers/>
- Container class API (`enableInternet`, `sleepAfter`, `defaultPort`) — <https://developers.cloudflare.com/containers/container-package/>
- Container egress, `enableInternet`, HTTPS interception and the CA at `/etc/cloudflare/certs/` — <https://github.com/cloudflare/containers/blob/main/docs/egress.md>
- Cloudflare Containers beta limitations — <https://developers.cloudflare.com/containers/beta-info/>
- Workers TCP sockets, and the note that outbound TCP is blocked on port 25 and to Cloudflare IP ranges — <https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>
