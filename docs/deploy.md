# Deploying the fleet

The exact commands, in order, from a clean checkout — plus how to tell the
deploy is actually serving, and how to take it down without leaving billable
things behind.

`wrangler.toml` is the configuration and carries the *decisions* (tenant
affinity, `sleepAfter`, the cron, why there is no R2 binding). This file is the
*procedure*. When they disagree, the configuration is right and this file is
stale.

## What this deploys, and what it does not

`wrangler.toml` deploys one Worker and **three** container fleets out of one
image:

| Piece | What it is | Started by |
|---|---|---|
| `brainz-fleet` (Worker) | The router. Classifies the path, admits or rate-limits, resolves the tenant from the bearer, forwards to a container. | Every request to the public origin. |
| `McpFleet` (container) | `src/mcp/serve.ts` — the MCP surface and the OAuth endpoints. | The router, per tenant (and one shared instance for the OAuth flow). |
| `WorkerFleet` (container) | `src/worker/serve.ts` — the scheduler and consolidation loop. | The `[triggers]` cron, via the router's `scheduled` handler. |
| `WebFleet` (container) | `src/web/serve.ts` — signup, login, dashboard, billing, BYOK, erasure, `/admin`. | The router, by path, on one named instance. |

**The web app is here now, and it is here for one reason.** A session cookie is
scoped to an origin. `/authorize` renders consent for a logged-in user, which
means reading the session the login page wrote — and a login page on another host
writes a cookie this origin never receives. So the web app is not merely *also*
deployed; it is deployed on this origin because that is the only arrangement in
which the consent screen has a session to read.

Requests reach it **by path**, not by tenant: its front door is `/signup`, which
runs before any tenant exists. The path table is in `src/mcp/edge.ts` and it is
closed — every path is the web app's, or the OAuth flow's, or a tenant's, or a
`404` the Worker answers itself without waking a container.

| Path | Fleet | Instance |
|---|---|---|
| `/`, `/login`, `/signup`, `/dashboard`, `/connect`, `/password/*`, `/api/*`, `/admin[/…]` | `WebFleet` | `web-singleton` |
| `/.well-known/oauth-*`, `/register`, `/authorize`, `/token` | `McpFleet` | `oauth-flow` |
| `/mcp`, `/openai`, `/revoke`, `/health` | `McpFleet` | the tenant named by the bearer (`401` without one) |
| anything else | none | `404`, no container woken |

`/api/*` and `/password/*` are written out one literal at a time in `edge.ts`
rather than matched as a pattern; `test/mcp/router.test.ts` derives the web app's
own route table out of `src/web/app.ts` and checks the two against each other in
both directions, so the enumeration cannot drift into a dead button. `/admin` is
the one prefix, because the app dispatches it as one and handles its sub-paths
inside `handleAdmin`.

**One web instance, and that is a decision rather than a default.** The web
process is `src/control/secret-file.ts`'s single writer — provisioning banks a
new tenant's connection string through it — so two instances are two divergent
stores of the same tenants' credentials. Sessions are rows in the identity
database, so statelessness is not what pins this to one instance; the writer
assumption is. The accepted ceiling: every signup, login and dashboard render for
the whole deployment is served by one container. See
[Known limits](#known-limits) for what that store does *not* do on this platform.

## Before you start

* **A Workers *Paid* account.** Containers are not on the free plan. The deploy
  fails at the container step, not at the Worker step, so a free-plan account
  gets a Worker that deploys and a fleet that never starts.
* **Docker, running.** `wrangler deploy` builds the image locally and pushes it
  to Cloudflare's registry.
* **A control-plane Postgres** (`control.*`, `src/control/schema.sql`) reachable
  from the container over ordinary outbound TCP.
* **Bun ≥ 1.3** and this checkout.

```bash
git clone <this repository> brainz && cd brainz
bun install
bunx wrangler login          # or export CLOUDFLARE_API_TOKEN
bunx wrangler whoami         # confirm the account you are about to bill
```

## 1. Check the configuration before spending anything

```bash
bun run typecheck
bun test test/fleet/
bunx wrangler deploy --dry-run --outdir /tmp/brainz-dryrun
```

The dry run builds the container image for all three classes and prints the
bindings without creating a single cloud resource. It is the cheapest possible
way to find a broken Dockerfile or a config typo.

**After any `wrangler.toml` change, regenerate the binding types — with the
environment file suppressed:**

```bash
bunx wrangler types --env-file=/dev/null
```

The flag is load-bearing rather than tidy, and for the same reason
`test/fleet/fixture.ts` passes it: without it `wrangler` reads this checkout's
own `.env` and writes every variable name in it into
`worker-configuration.d.ts`, which this public repository commits. Names are not
credentials, but an operator's local inventory is nobody else's business and it
is not a fact about the deployment.

**Architecture matters here.** Cloudflare Containers run `linux/amd64` only, and
a developer machine is probably Apple Silicon. `wrangler` targets amd64 for you;
confirm it rather than trusting it:

```bash
docker image inspect brainz-fleet-mcpfleet:worker --format '{{.Architecture}}/{{.Os}}'
# amd64/linux   ← must say this, on any host
```

If you ever build or push by hand, pass the platform explicitly — an arm64 image
pushes fine and fails to start:

```bash
docker build --platform linux/amd64 -t brainz-fleet .
```

## 2. Deploy once, to learn the origin

The OAuth discovery documents embed an absolute issuer URL and a connector binds
to what it reads, so `BRAINZ_PUBLIC_ORIGIN` has to be the origin this Worker
actually answers on. No custom domain is configured (`workers_dev = true`), and
the workers.dev origin is assigned by the account — so deploy first, read it,
then configure.

```bash
bunx wrangler deploy
# ... Deployed brainz-fleet
#     https://brainz-fleet.<your-subdomain>.workers.dev
```

The fleet does **not** serve yet, and should not: with no secrets set, a
container that starts refuses on its first missing variable and exits non-zero.
That is the designed behaviour (`src/fleet/env.ts`), not a failed deploy.

## 3. Set the secrets

Every value is set with `wrangler secret put`; **nothing credential-shaped goes
in `wrangler.toml`**, which this public repository commits. `src/mcp/router.ts`
forwards these into the containers by name — the manifests are
`MCP_FLEET_VARIABLES`, `WORKER_FLEET_VARIABLES` and `WEB_FLEET_VARIABLES`, and a
variable that is not on one does not reach that container at all.

```bash
# The fleets that serve MCP and run jobs.
bunx wrangler secret put BRAINZ_PUBLIC_ORIGIN            # https://brainz-fleet.<your-subdomain>.workers.dev
bunx wrangler secret put BRAINZ_CONTROL_DATABASE_URL
bunx wrangler secret put BRAINZ_SECRETS_JSON
bunx wrangler secret put BRAINZ_CF_ACCOUNT_ID
bunx wrangler secret put BRAINZ_HOSTED_KEY_CLOUDFLARE

# The web app, which is on this origin too. Without these the WebFleet
# container refuses to start and `/signup` answers 502 through the edge.
bunx wrangler secret put BRAINZ_IDENTITY_DATABASE_URL
bunx wrangler secret put BRAINZ_WEB_ORIGIN               # the SAME origin as BRAINZ_PUBLIC_ORIGIN
bunx wrangler secret put BRAINZ_MCP_URL                  # that origin + /mcp
bunx wrangler secret put BRAINZ_STRIPE_WEBHOOK_SECRET
bunx wrangler secret put BRAINZ_NEON_API_KEY
bunx wrangler secret put BRAINZ_NEON_ORG_ID
bunx wrangler secret put BRAINZ_WEB_APP_BASE_URL         # also that origin: it is where consent lives now
```

`BRAINZ_WEB_ORIGIN` and `BRAINZ_PUBLIC_ORIGIN` are the same string, and that is
the point rather than a duplication to tidy away: the web app's same-origin
refusal compares against the first, connectors bind the issuer out of the second,
and a session cookie is only sent to `/authorize` because the two agree.

Five secrets for the model-calling fleets, not six. The embedding seat moved to `@cf/qwen/qwen3-embedding-0.6b`
after this list was first written, so the hosted profile reaches no OpenAI route
and `BRAINZ_HOSTED_KEY_OPENAI` is not set on a hosted deployment. Confirm against
the code rather than this file: `providersReachable()` is pinned by
`test/register/completeness.test.ts`, and it returns `cloudflare`, `google` and
`self-host`.

| Secret | MCP | Worker | Web | Required? | What reads it |
|---|:--:|:--:|:--:|---|---|
| `BRAINZ_CONTROL_DATABASE_URL` | ✓ | ✓ | ✓ | yes | `compose.ts:openControlPlane`; the worker opens a second handle for lease renewal (hazard H4). |
| `BRAINZ_SECRETS_JSON` | ✓ | ✓ | ✓ | yes | The image's bootstrap writes it to a file and points `BRAINZ_SECRETS_FILE` at it. See [Known limits](#known-limits). |
| `BRAINZ_CF_ACCOUNT_ID` | ✓ | ✓ | — | on the `hosted` profile | `compose.ts:selectFleetTransport` — the Cloudflare seats bill through `…/accounts/{id}/ai`. Not needed by `self-host`. |
| `BRAINZ_HOSTED_KEY_CLOUDFLARE` | ✓ | ✓ | — | on the `hosted` profile | The pooled credential for eight of the nine model seats. |
| `BRAINZ_HOSTED_KEY_OPENAI` | ✓ | ✓ | — | **no** — self-host only | No hosted route reaches OpenAI since the embedding seat moved to Cloudflare. Setting it on a hosted deployment does nothing. |
| `BRAINZ_HOSTED_KEY_GOOGLE` | ✓ | ✓ | — | self-host only | A direct Google relationship. No hosted route reads it. |
| `BRAINZ_HOSTED_KEY_SELF_HOST` | ✓ | ✓ | — | self-host only | A local/self-hosted inference endpoint's credential. |
| `BRAINZ_ROUTING_PROFILE` | ✓ | ✓ | — | no (`hosted`) | Which routing table (`src/ai/routing.ts`). |
| `BRAINZ_PUBLIC_ORIGIN` | ✓ | — | — | yes | The OAuth issuer. A batch process publishes no issuer, so it does not travel to the worker fleet. |
| `BRAINZ_OAUTH_REDIRECT_URIS` | ✓ | — | — | no (empty) | Dynamic-registration allowlist. Empty refuses every registration, which is the fail-closed default. |
| `BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR` | ✓ | — | — | no (`0`) | Same allowlist, rate half. |
| `BRAINZ_WEB_APP_BASE_URL` | ✓ | — | — | no | Where a consent screen sends a user. |
| `BRAINZ_WORKER_CONCURRENCY` | — | ✓ | — | no (`4`) | Jobs one instance runs at once. |
| `BRAINZ_WORKER_TICK_MS` | — | ✓ | — | no (`60000`) | The loop's period once the instance is awake. |
| `BRAINZ_IDENTITY_DATABASE_URL` | — | — | ✓ | yes | `compose.ts:openIdentityStore` — accounts, password digests, sessions. The one database the other two fleets deliberately cannot reach. |
| `BRAINZ_WEB_ORIGIN` | — | — | ✓ | yes | The same-origin refusal's reference value. Wrong, and the CSRF check compares against a host nobody uses. |
| `BRAINZ_MCP_URL` | — | — | ✓ | yes | What `/connect` hands the user to paste into their client. |
| `BRAINZ_STRIPE_WEBHOOK_SECRET` | — | — | ✓ | yes | The billing webhook's signature. Required by the process even with no billing vendor configured: a webhook route that cannot verify is a route that accepts, so it fails closed at start. With a value that verifies nothing, every delivery is refused `400` — which is the correct state for a deployment that sells nothing yet. |
| `BRAINZ_STRIPE_API_BASE` / `_SECRET_KEY` / `_PRICE_ID` | — | — | ✓ | all three or none | Checkout. A partial trio refuses at start rather than reaching the network with an empty credential and reporting it as a vendor outage. Unset, `/api/billing/checkout` answers that no vendor is configured. |
| `BRAINZ_NEON_API_KEY` | — | — | ✓ | unless `BRAINZ_POOL_TARGET` > 0 | The substrate a signup provisions onto. With neither this nor a warm pool the process refuses to start, because every signup it could serve would answer `503`. |
| `BRAINZ_NEON_ORG_ID` | — | — | ✓ | in practice, yes | Which organisation the project is created in. Omitted, projects land on whoever's personal account minted the key, bill there, and are invisible in the list every other operator reads. |
| `BRAINZ_NEON_REGION_ID` / `_PG_VERSION` / `_API_BASE` | — | — | ✓ | no | Where the project lands, which Postgres, and (for tests) which endpoint. |
| `BRAINZ_NEON_SUSPEND_TIMEOUT` | — | — | ✓ | account-dependent | Only takes `vendor-default`, which sends no suspend interval. A free-plan Neon account answers `412 modifying the suspend interval is not permitted` and creates nothing, so if the first live signup fails that way, this is the escape hatch. |
| `BRAINZ_POOL_TARGET` | — | — | ✓ | no (`0`) | `0` provisions synchronously on signup. Above zero, signups claim from a warm pool. |
| `BRAINZ_TENANT_ID_PREFIX` | — | — | ✓ | no | A marker on tenant ids this deployment mints (a canary, an internal fixture). |
| `BRAINZ_ADMIN_CREDENTIAL` | — | — | ✓ | no | Unset means `/admin` answers `404` — an admin surface whose credential is unset is one open to everybody. |

Absent from **every** manifest, so do not bother setting them here:
`BRAINZ_SECRETS_FILE` (the image chooses the path — setting it is ignored, with a
note on stderr), and any R2 credential (nothing under `src/` reads one yet,
because `createTenantObjectStore` has no production credential minter; see the
`NO R2 BINDING` block in `wrangler.toml`). The identity database and the billing
and substrate credentials reach the **web fleet only** — the MCP fleet parses
attacker-supplied content, so a credential it cannot use is a credential a
compromise there cannot leak. `test/fleet/router-env.test.ts` asserts that in both
directions.

Check what is set — the command prints names, never values:

```bash
bunx wrangler secret list
```

## 4. Deploy again

```bash
bunx wrangler deploy
```

`wrangler secret put` already published a new Worker version, so this step is
about the *containers*: a running instance built its `envVars` when its Durable
Object was constructed and keeps them until it is replaced. A fresh deploy
replaces them. If you change a secret later, expect the change to reach an
instance when it next starts — which for the MCP and web fleets is up to
`sleepAfter` (15m) after they go idle.

**And a deploy only replaces an instance if the image actually changed.** An
unchanged image gives the platform no reason to replace anything, so a secret
that "must take effect now" needs a new image version — which is what
`ARG FLEET_CONFIG_EPOCH` in the `Dockerfile` is for. It is consumed as a `LABEL`,
so bumping it changes the image config and therefore the digest; an `ARG` no
layer reads changes nothing and replaces nothing, which is a particularly quiet
way to spend an hour debugging a value you can see in `wrangler secret list`.
Bump it in the same commit as the secrets that need it:

```
ARG FLEET_CONFIG_EPOCH=2      # ← bump, commit, then deploy
```

Observed on 2026-08-17: the OAuth allowlist stayed empty through two deploys
while seven instances kept serving the environment they booted with.

## 5. Verify that it serves

"Deployed successfully" is a statement about an upload. These four checks are
statements about the fleet.

```bash
ORIGIN=https://brainz-fleet.<your-subdomain>.workers.dev
```

**1 — the origin is up and refuses correctly.** `/health` is served *inside* the
MCP container, but the edge authenticates before it routes, so an unauthenticated
request never reaches the container and answers `401 {"error":"unauthorized"}`.
That 401 is the pass: it proves the Worker is live and fail-closed. It does
**not** prove a container booted — check 3 is what proves that, and this check
was written believing otherwise.

```bash
curl -si "$ORIGIN/health" | head -1        # HTTP/2 401 — the edge, refusing
```

Do not "fix" this by exempting `/health` from auth. An unauthenticated liveness
route on a public origin in front of scale-to-zero containers billed per 10ms is
a free way for anyone to wake every instance you have. The platform's own
readiness probe reaches `pingEndpoint` inside the Durable Object and never
crosses this edge.

**2 — the configuration actually arrived.** This is the check that would have
caught the failure this runbook exists to prevent: the discovery document echoes
`BRAINZ_PUBLIC_ORIGIN`, so it can only be right if the secret reached the
container. A fleet with no configuration cannot answer it at all, and a fleet
with the *wrong* origin answers it wrongly — which a connector will reject days
later, at the token endpoint, as an issuer mismatch.

```bash
curl -s "$ORIGIN/.well-known/oauth-protected-resource" | grep -o "$ORIGIN"
```

**3 — the whole stack, with a real credential.** A tenant's bearer resolves
through the secret store, the connection accessor dials that tenant's database,
and dispatch answers. Nothing in this path can be satisfied from process memory.

```bash
curl -s "$ORIGIN/mcp" \
  -H "authorization: Bearer $A_TENANT_BEARER" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"recall","arguments":{"query":"anything at all"}}}'
```

A `result` with no `isError` is the deploy working end to end. `unauthorized`
means the bearer is not in `BRAINZ_SECRETS_JSON`; `instance_unavailable` (502)
means the container refused to start — read its log for the variable it named.

**5 — the web app, which is the check the whole third fleet exists for.** It
answers no bearer and no discovery document; it answers HTML to a browser. A
`404` here means the path table did not classify it, a `502` means the container
refused to start (read its log for the variable it named), and a `401` means the
request was routed to the MCP fleet instead.

```bash
curl -si "$ORIGIN/signup" | head -1        # HTTP/2 200
curl -s  "$ORIGIN/signup" | grep -o '<form' | head -1
```

**4 — the worker fleet, which no request will ever prove for you.** The MCP
fleet can be perfectly healthy while no consolidation cycle ever runs; that is
precisely why the cron exists. Wait for the next half hour, or fire it by hand,
then read the log:

```bash
bunx wrangler tail --format pretty        # in one terminal
# the wake arrives as a scheduled invocation; the container logs
# {"event":"listening","service":"worker",...} and then its ticks
```

Do not accept a green cron history as evidence on its own — see
`wakeWorkerFleet` in `src/mcp/router.ts` for why a failed wake is reported as a
failed invocation rather than swallowed, and check that the *container* logged
`listening` with `"service":"worker"`.

## Tearing it down

**`wrangler delete` removes the Worker and leaves the container application and
every R2 bucket standing, still billable.** An earlier probe in this repository
left 18 orphaned buckets and a running container application behind exactly that
way. Delete in this order and then *list* to confirm, because the failure mode is
a resource nobody is looking at.

```bash
# 1. The container applications — one per Container class, and they outlive the Worker.
bunx wrangler containers list
bunx wrangler containers delete <id>          # McpFleet
bunx wrangler containers delete <id>          # WorkerFleet
bunx wrangler containers delete <id>          # WebFleet

# 2. The images in Cloudflare's managed registry (storage is billed).
bunx wrangler containers images list
bunx wrangler containers images delete <image>

# 3. The Worker itself. This also removes its secrets and the cron trigger.
bunx wrangler delete

# 4. Any R2 buckets — nothing above touches these, and this config binds none,
#    so anything here was created by hand or by a probe.
bunx wrangler r2 bucket list
bunx wrangler r2 bucket delete <bucket>

# 5. Confirm. Each of these should come back empty.
bunx wrangler containers list
bunx wrangler containers images list
bunx wrangler r2 bucket list
```

Outside Cloudflare, the tenant Neon projects and the control-plane database are
still there, and deleting the fleet does not touch them. That is deliberate — a
brain outliving its serving infrastructure is the correct direction — but it
means "I deleted the deploy" is not "I stopped paying".

## Known limits

**The secret store is a snapshot, and it is small.** `BRAINZ_SECRETS_JSON` is
one Workers secret, capped at 5 KB. A tenant entry — namespace, connection
string, bearer grant — is roughly 290 bytes of compact JSON, so the store holds
somewhere around 15 to 17 tenants before the secret is refused. That is the
alpha's ceiling, not the design's: `src/control/secret-file.ts` is one
implementation of a `SecretBackend` port and the managed store replaces it
without changing anything above that line.

**And now that the web app is deployed here, the store is not shared with
it — which is sharper than it sounds.** `secret-file.ts` assumes one writer (the
web process) and readers on the same volume. Cloudflare Containers have no shared
volume, and each container gets a fresh copy of `BRAINZ_SECRETS_JSON` written to
its own temporary file at start. So a signup served by the web fleet provisions a
real Neon project, banks the tenant's connection string into **that container's
own copy**, and:

* the MCP fleet cannot see it — that tenant's bearer resolves to nothing, and
  every tool call answers `unauthorized`;
* the web instance itself loses it when it is replaced or sleeps out
  (`sleepAfter` 15m), so even the process that wrote it forgets.

The tenant's brain is real and its rows are safe — the Neon project and the
control-plane row both survive. What is lost is the credential that reaches it.
Until the managed secret store lands, a signup is only half-complete until an
operator adds that tenant's entry to `BRAINZ_SECRETS_JSON` by hand, re-runs
`wrangler secret put`, and redeploys with a bumped `FLEET_CONFIG_EPOCH`. That is
a chore at alpha volume and it is not a design; it is the first thing the managed
store fixes, and it is the single strongest argument for landing it before any
real signup.

**Two ports are in-memory inside the MCP fleet** (`src/mcp/serve.ts` says so in
its own header): the OAuth authorization store and the access log. With more
than one MCP instance, a code minted on one cannot be redeemed on another. Under
tenant affinity a single tenant's flow stays on one instance, and the OAuth flow
is pinned to a single named instance for the same reason — but a restart mid-flow
still loses it.
