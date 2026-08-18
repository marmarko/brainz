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

**`wrangler containers list` will show more instances than that, and it is not
the count you decided.** Observed immediately after this deploy: `webfleet` 3
live against `max_instances = 3`, `workerfleet` 7 against 20, `mcpfleet` 7
against 50 — and the worker fleet is addressed by exactly one name
(`worker-singleton`), so 7 cannot be "instances in use". Read it as capacity the
platform provisioned, not as instances serving: a Durable Object id is served by
one container instance, so the name is still what bounds concurrency, and idle
capacity sheds on `sleepAfter`. Do not "fix" a count above one by lowering
`max_instances` to one — that would make the ceiling the mechanism, and it
couples instance replacement at deploy time to a number chosen for a different
reason.

## Before you start

* **A Workers *Paid* account.** Containers are not on the free plan. The deploy
  fails at the container step, not at the Worker step, so a free-plan account
  gets a Worker that deploys and a fleet that never starts.
* **Docker, running.** `wrangler deploy` builds the image locally and pushes it
  to Cloudflare's registry.
* **A control-plane Postgres** (`control.*`, `src/control/schema.sql`) reachable
  from the container over ordinary outbound TCP. It is also the secret store:
  `src/control/secret-store.sql` is applied by the first fleet to start
  (`ensureSecretStoreSchema`, under an advisory lock), so the role in that DSN
  needs to be able to create a table and three domains in the `control` schema —
  once.
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
# What opens the sealed rows in `control.tenant_secret`. Generate it with
# `openssl rand -base64 32`, and keep it somewhere you keep things you cannot
# regenerate: it never enters the database it opens, so losing it loses every
# tenant's credentials. Every fleet needs the SAME one.
bunx wrangler secret put BRAINZ_SECRET_ENCRYPTION_KEY
bunx wrangler secret put BRAINZ_CF_ACCOUNT_ID
bunx wrangler secret put BRAINZ_HOSTED_KEY_CLOUDFLARE

# Only if you are upgrading a deployment that still has tenants inside the old
# snapshot secret. It is imported once and can then be deleted — see
# [Known limits](#known-limits). A fresh deployment sets neither this nor
# BRAINZ_SECRET_BACKEND (which defaults to the durable `postgres` store).
# bunx wrangler secret put BRAINZ_SECRETS_JSON

# The web app, which is on this origin too. Without these the WebFleet
# container refuses to start and `/signup` answers 502 through the edge.
# The identity DSN is the one secret two fleets read: the web app owns it, and
# the MCP fleet needs it because `/authorize` is routed there. See the table.
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
| `BRAINZ_SECRET_ENCRYPTION_KEY` | ✓ | ✓ | ✓ | yes on the default backend; **on MCP, yes on every backend** | AES-256-GCM, 32 bytes, base64. Opens `control.tenant_secret` (`src/control/secret-pg.ts`) and the sealed rows of the durable authorization store (`src/control/oauth-pg.ts`). The same value on all three fleets, or the fleet with the odd one out refuses every tenant. Never stored in the database it opens. The MCP fleet needs it even on `BRAINZ_SECRET_BACKEND=file`, because the two choices are independent — see [Known limits](#known-limits). |
| `BRAINZ_AUTHORIZATION_BACKEND` | ✓ | — | — | no (`postgres`) | `postgres` — the durable OAuth store, and the default — or `memory` for a single-instance self-hoster. **Absent from `MCP_FLEET_VARIABLES` on purpose**, so it does not reach a Cloudflare container at all: the hosted fleet cannot be configured back into a per-container store. An unknown value refuses at start. |
| `BRAINZ_SECRET_BACKEND` | ✓ | ✓ | ✓ | no (`postgres`) | `postgres` — the durable store, and the default — or `file` for a self-hoster with a real volume. An unknown value refuses at start; a missing key on `postgres` refuses at start. There is no fallback. |
| `BRAINZ_SECRETS_JSON` | ✓ | ✓ | ✓ | **no** — migration only | A one-time bootstrap seed. Imported once per blob, never overwrites a durable entry, deletable once `control.secret_seed` has its digest. See [Known limits](#known-limits). |
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
| `BRAINZ_IDENTITY_DATABASE_URL` | ✓ | — | ✓ | yes on web; browser consent needs it on MCP | Accounts, password digests, sessions. On the web fleet via `compose.ts:openIdentityStore`; on the MCP fleet via `serve.ts:sessionResourceOwners`, because `edge.ts` routes `/authorize` to the MCP fleet and the consent screen has to read the session the login page wrote. **This is the deployment's widest credential and two processes hold it** — omit it from the MCP fleet and the browser leg of `/authorize` answers `401`, which is a connector flow no browser can begin. The worker fleet serves no browser and never gets it. |
| `BRAINZ_WEB_ORIGIN` | — | — | ✓ | yes | The same-origin refusal's reference value. Wrong, and the CSRF check compares against a host nobody uses. |
| `BRAINZ_MCP_URL` | — | — | ✓ | yes | What `/connect` hands the user to paste into their client. |
| `BRAINZ_STRIPE_WEBHOOK_SECRET` | — | — | ✓ | yes | The billing webhook's signature. Required by the process even with no billing vendor configured: a webhook route that cannot verify is a route that accepts, so it fails closed at start. With a value that verifies nothing, every delivery is refused `400` — which is the correct state for a deployment that sells nothing yet. |
| `BRAINZ_STRIPE_API_BASE` / `_SECRET_KEY` / `_PRICE_ID` | — | — | ✓ | all three or none | Checkout. A partial trio refuses at start rather than reaching the network with an empty credential and reporting it as a vendor outage. Unset, `/api/billing/checkout` answers that no vendor is configured. |
| `BRAINZ_NEON_API_KEY` | — | — | ✓ | unless `BRAINZ_POOL_TARGET` > 0 | The substrate a signup provisions onto. With neither this nor a warm pool the process refuses to start, because every signup it could serve would answer `503`. |
| `BRAINZ_NEON_ORG_ID` | — | — | ✓ | in practice, yes | Which organisation the project is created in. Omitted, projects land on whoever's personal account minted the key, bill there, and are invisible in the list every other operator reads. |
| `BRAINZ_NEON_REGION_ID` / `_PG_VERSION` / `_API_BASE` | — | — | ✓ | no | Where the project lands, which Postgres, and (for tests) which endpoint. |
| `BRAINZ_NEON_SUSPEND_TIMEOUT` | — | — | ✓ | account-dependent | Only takes `vendor-default`, which sends no suspend interval. A free-plan Neon account answers `412 modifying the suspend interval is not permitted` and creates nothing, so if the first live signup fails that way, this is the escape hatch. |
| `BRAINZ_POOL_TARGET` | — | — | ✓ | no (`0`) | `0` provisions synchronously on signup. Above zero, signups claim from a warm pool. |
| `BRAINZ_TENANT_ID_PREFIX` | — | — | ✓ | no | A marker on tenant ids this **deployment** mints (a canary, an internal fixture). It marks deployments, not tenants within one — two tenants minted by the same deployment carry the same prefix, so it cannot tell a throwaway from a real user's brain. For that, see [Before you delete a tenant](#before-you-delete-a-tenant-whose-brain-is-it). |
| `BRAINZ_ADMIN_CREDENTIAL` | — | — | ✓ | strongly recommended | Unset means `/admin` answers `404` — an admin surface whose credential is unset is one open to everybody. Set it if you intend to grant a tier (below), and set it before you delete anything: without it there is no way to ask which tenants a person owns. |
| `BRAINZ_PIPEDREAM_PROJECT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_ENVIRONMENT` | — | ✓ | ✓ | all four or none | The connector vendor. **None at all is a supported deployment**: `/api/connectors` answers `501 unavailable` and chat exports and folder imports still work. A *partial* set refuses at start naming the missing variable, because a half-configured vendor reaches the network with an empty credential and reports the refusal as a vendor outage. `_ENVIRONMENT` takes only `development` or `production` — they are separate keyspaces at the vendor, and the wrong one attaches every user's mailbox to the wrong project. |
| `BRAINZ_PIPEDREAM_API_BASE` | — | ✓ | ✓ | no | The vendor's API base. Absent takes theirs; setting it is how a test points the process at a double. |

**The connector credential goes to the two fleets that talk to the vendor, and
never to the MCP one.** This paragraph used to read *"to the web fleet and to no
other, including not the worker fleet"*, and gave the reason: a poll resumes from
a cursor kept in the tenant's object prefix, reaching one needs a
`ScopedCredentialMinter`, and `src/` has no production implementation of that
port — so the worker registered the `ingest_pull` handler with its source seam
absent and nothing enqueued one. It promised the four variables would join
`WORKER_FLEET_VARIABLES` on the day the lane could run. That day is here: the
connector's state moved to the control plane, sealed
(`src/control/connector-store.sql`), which every fleet already holds a handle to,
so the worker fleet composes a real connector runtime, reconciles authorizations
on its tick and polls the connections that result.

**The MCP fleet still gets none of them**, and that is now the whole of what this
rule protects: it is the process that parses attacker-supplied content, and it
mints no connect link, reconciles nothing and polls nothing, so a vendor
credential there would be authority it cannot exercise sitting in the widest
surface in the deployment. `test/fleet/router-env.test.ts` asserts all three
directions.

Nothing new to `wrangler secret put`: the four secrets already exist on the
Worker, and which container receives them is decided by the manifests in
`src/mcp/router.ts` rather than by a second `put`.

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
Object was constructed and keeps them until it is replaced. A change reaches an
instance when it next **starts** — which for a warm MCP or web instance is after
`sleepAfter` (15m) of idle, not when the deploy finishes.

**And a deploy only replaces an instance if the image actually changed.** An
unchanged image gives the platform no reason to replace anything, so a secret
that "must take effect now" needs a new image version — which is what
`ARG FLEET_CONFIG_EPOCH` in the `Dockerfile` is for. It is consumed as a `LABEL`,
so bumping it changes the image config and therefore the digest; an `ARG` no
layer reads changes nothing and replaces nothing, which is a particularly quiet
way to spend an hour debugging a value you can see in `wrangler secret list`.
Bump it in the same commit as the secrets that need it:

```
ARG FLEET_CONFIG_EPOCH=3      # ← bump, commit, then deploy
```

Observed on 2026-08-17: the OAuth allowlist stayed empty through two deploys
while seven instances kept serving the environment they booted with.

**A manifest change needs the bump just as much as a secret does, and hides
better.** Epoch 3 added `BRAINZ_IDENTITY_DATABASE_URL` to `MCP_FLEET_VARIABLES`;
the secret itself was already set, so `wrangler secret list` looked identical
before and after and there was nothing to re-put. What changed was which
variables `selectContainerEnv` copies — read once, when the Durable Object is
constructed. Without the bump the browser leg of `/authorize` keeps answering
`401` from warm instances and the deploy looks like it did nothing.

### The bump is necessary and it is NOT sufficient — read this before you conclude a deploy failed

**A moved image digest does not mean a warm instance was replaced, and
`wrangler containers list` cycling through `provisioning` does not either.**
Both say the *application* is on a new version. A running instance is replaced
when it next starts.

Measured on 2026-08-17, epoch 2 → 3:

| Time (UTC) | What was observed |
|---|---|
| 06:03 | `wrangler deploy`: all three image digests move (`06ff5c65…` → `b3056ce9…`) |
| 06:04–06:05 | `wrangler containers list` shows all three cycling `provisioning` → `ready` |
| 06:06, 06:07, 06:08 | `/authorize` still answers `401` — the pre-deploy `envVars` |
| 06:08–06:27 | no request to any path routed to `oauth-flow` |
| 06:27 | `/authorize` answers `302 → /login?next=…`. The new environment is live |

### The deterministic reload: delete the container application, then deploy

Waiting is the *cheap* way to replace a warm instance; it is not a reliable one,
and checking prevents it. When a config or code change has to take effect now:

```bash
bunx wrangler containers list                      # copy the application's ID
bunx wrangler containers delete <application-id>   # destroys the app and its instances
bunx wrangler deploy                               # recreates it, fresh, on the current image
```

The application comes back with a **new ID** — that is how you know it was
recreated rather than rolled. Verified 2026-08-17: a `form-action` fix deployed
at 16:45 was still absent from the consent page's CSP at 16:52 with the
application reporting `active` and its instances reporting `inactive`; deleting
the application (`a03ee893…`) and redeploying produced `a0382de5…`, and the
corrected header was live within three minutes.

What this costs: in-flight OAuth codes and any warm connection LRU, both of
which a client retries through. What it does **not** touch: the tenant
databases, the control plane, or `control.tenant_secret` — every piece of
durable state lives outside the container, which is exactly what makes this
safe to reach for.

Prefer it over a retry loop against the origin. A loop keeps `sleepAfter`
running from its own last request, so it holds the stale instance alive while
showing you the answer you are trying to change.

**The trap is that verifying keeps the old instance alive.** `sleepAfter` is
measured from the last request, and every probe resets it — so a tight
check-and-retry loop against `/authorize` can hold a stale instance up
indefinitely while its operator reads the unchanged answer as "the manifest
change did not work" and starts editing code that was already correct.

So, after a deploy whose point is an environment change:

* Leave **every** path that routes to the instance alone — for `oauth-flow`
  that is `/authorize`, `/register`, `/token` **and** both `/.well-known/…`
  documents, since they share one Durable Object id.
* Wait past `sleepAfter` (15m + margin) from the last such request.
* Then probe **once**.

`wrangler containers instances <ID>` does not settle this either: it lists the
Durable Object names with a `CREATED` timestamp and a `STATE` that read
`inactive` for instances that were demonstrably serving traffic. Treat it as the
id inventory, not as liveness.

## 5. Verify that it serves

"Deployed successfully" is a statement about an upload. These five checks are
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

**4 — the web app, which is the check the whole third fleet exists for.** It
answers no bearer and no discovery document; it answers HTML to a browser. A
`404` here means the path table did not classify it, a `502` means the container
refused to start (read its log for the variable it named), and a `401` means the
request was routed to the MCP fleet instead.

```bash
curl -si "$ORIGIN/signup" | head -1        # HTTP/2 200
curl -s  "$ORIGIN/signup" | grep -o '<form' | head -1
```

**5 — the worker fleet, which no request will ever prove for you.** The MCP
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

## Granting an account the paid tier without a payment

Billing is inert on a deployment with no checkout trio and a webhook secret that
verifies nothing: every account is free forever, and connectors are paid-only for
a reason that is unit economics rather than capability (`connectorGate` in
`src/web/app.ts` states it). The operator's own brain, a canary or a comp
therefore needs a way through that Stripe is not going to provide.

It is an `/admin` operation, so it needs `BRAINZ_ADMIN_CREDENTIAL` set, and it is
a **POST**:

```bash
ORIGIN=https://brainz-fleet.<your-subdomain>.workers.dev
TENANT=t-...                      # from `?op=tenant_directory`; `?op=fleet_status`
                                  # counts tenants and names none of them

curl -sS -X POST \
  -H "Authorization: Bearer $BRAINZ_ADMIN_CREDENTIAL" \
  -H "Origin: $ORIGIN" \
  "$ORIGIN/admin?op=grant_internal_tier&tenant_id=$TENANT"
# {"ok":true,"content":{"tenant_id":"t-…","tier":"internal",
#  "grants":["consolidation_model_phases","connected_accounts"]}}
```

Three things about that command are load-bearing rather than ceremony:

* **POST, not GET.** The surface refuses the two tier operations on any other
  method. The credential is a header, so a browser cannot be tricked into
  presenting it — what a GET would allow is a *link*: a bookmark, a copied URL in
  a ticket, or a shell-history recall issuing a grant, with the tenant id in the
  query string of each.
* **`Origin` must equal `BRAINZ_WEB_ORIGIN`.** The app refuses every
  state-changing request that does not carry it, and a header that is absent is
  not a header that agrees.
* **The tier is `internal`, never `paid`.** `account.subscription` carries a
  CHECK that a paid row names a vendor object, exactly so a comp cannot be
  mistaken for a subscription; the grant honours it by moving the control plane's
  own third value instead. The identity row keeps saying `free`, which is true —
  nobody subscribed.

It grants two things at once, which is why the answer names both: the
consolidation cycle's model phases (`src/control/tier.ts` maps `internal` to
`paid`) and connected accounts (`effectiveTierOf` in `src/control/billing.ts`).

Afterwards it is visible through the same surface — by tenant, and in the fleet's
own counts:

```bash
curl -sS -H "Authorization: Bearer $BRAINZ_ADMIN_CREDENTIAL" \
  "$ORIGIN/admin?op=tenant_status&tenant_id=$TENANT"      # "tier":"internal"
curl -sS -H "Authorization: Bearer $BRAINZ_ADMIN_CREDENTIAL" \
  "$ORIGIN/admin?op=fleet_status"                          # a count under tier "internal"
```

`op=revoke_internal_tier` takes it back, and **only** an `internal` row: a
mistyped tenant id cannot downgrade a paying customer, because nothing would ever
put that back — the webhook writes on a delivery, and a cancelled grant produces
none.

## Before you delete a tenant: whose brain is it?

**Read this before running anything in the next section, and before deleting a
project in the substrate vendor's console.**

A tenant's vendor project name is derived from its tenant id and nothing else. So
in the console — which is the list an operator actually deletes from — a
throwaway and a person's brain are the same string, and a `*`-matched cleanup
deletes both. That has happened on this codebase: a batch delete by tenant-id
prefix took out three test tenants and one real user's brain, and it was
recoverable only because that brain happened to be empty.

`BRAINZ_TENANT_ID_PREFIX` does not save you here and is not meant to. It marks
the tenants a **deployment** mints; the throwaways in that incident were minted
by the same deployment as the brain that mattered, so all four carried the same
prefix. A prefix cannot separate two tenants it gives the same prefix to.

What can is `op=tenant_directory`. It is a read, so a plain GET does it:

```bash
ORIGIN=https://brainz-fleet.<your-subdomain>.workers.dev

curl -sS -H "Authorization: Bearer $BRAINZ_ADMIN_CREDENTIAL" \
  "$ORIGIN/admin?op=tenant_directory" |
  jq -r '.content.tenants[]
         | [ .tenant_id, .state, (.last_activity // "never"),
             (if .owner then "OWNED " + .owner.domain + " " + .owner.digest
              else "unowned" end) ]
         | @tsv'
```

```
t-aaa111  ready  never                     OWNED example.com 72497f475e4f
t-bbb222  ready  2026-08-16T12:00:00.000Z  unowned
```

**Read the last column, not the third one.** In the incident, the brain that was
deleted said `never`. It had been provisioned and not yet used, which is what a
brand-new real account looks like and also what a throwaway looks like — the
activity column cannot tell them apart and neither can the console. The word
`OWNED` is the one that can. This is also why the operation grades nothing and
prints no "safe to delete" verdict: every heuristic such a verdict could be built
from said *disposable* about the row that mattered.

**No address comes back, on purpose.** The response carries the mail domain and
twelve hex characters of a digest, never a mailbox — a response that listed
customer addresses would put them into your shell history, your scrollback and
whatever ticket you pasted the output into. To check a tenant against an address
you already hold, compute the same digest locally and compare:

```bash
EMAIL=someone@example.com
printf '%s' "$EMAIL" | tr 'A-Z' 'a-z' | shasum -a 256 | cut -c1-12
# 72497f475e4f  → matches t-aaa111 above
```

The `tr` is load-bearing: addresses are stored lowercased, so a digest computed
over `Someone@Example.com` matches nothing and reads as "not this tenant" —
a false negative in exactly the direction that deletes somebody's brain.

`total` and `truncated` are in the response body. The listing is capped, so on a
larger fleet check `truncated` before concluding that a tenant is not there; ask
for a page with `&limit=N` (`N` above the cap is clamped to it, not refused). If
the operation answers `400` saying the owner lookup is unavailable, that is
deliberate — it means the identity database could not be reached, and a
directory that cannot see owners refuses rather than reporting every brain as
unowned.

`op=tenant_status&tenant_id=…` still answers the operational detail for one
tenant once you know which one you mean.

## "My mail is not arriving": why one connector stopped

**Start here rather than with the container logs. There is nothing in them.** The
pull handler writes its result to container stdout, and `wrangler tail` captures
the Worker, not the container — so the line exists and nothing outside the
container can read it. The run's own detail is in the tenant's `ingest_log`,
behind a connection string sealed under a Worker secret. Neither is reachable
from a terminal, which is why the answer comes out of the control plane instead:

```bash
curl -sS -H "Authorization: Bearer $BRAINZ_ADMIN_CREDENTIAL" \
  "$ORIGIN/admin?op=connector_status&tenant_id=$TENANT" | jq '.content'
```

```json
{
  "lanes": [
    { "source": "gmail", "state": "due", "attempts": 3, "max_attempts": 5,
      "run_at": "2026-08-17T09:12:00.000Z", "job_failure_code": "handler_error" }
  ],
  "connectors": [
    { "source": "gmail", "last_attempt_at": "2026-08-17T09:04:00.000Z",
      "last_success_at": "2026-08-14T21:00:00.000Z", "run_outcome": "failed",
      "ingest_failure_code": "auth_expired", "job_failure_code": null,
      "cause": "auth_expired", "items_written": 0, "items_failed": 0 }
  ]
}
```

**Read `cause`, not `job_failure_code` on the lane.** The lane's code is the job
queue's own vocabulary and its answer for any handler that threw is
`handler_error` — true, and not the reason anybody is asking. `cause` is the
attempt's own, and it separates the four things that look identical from the
queue:

| `cause` | What happened | Whose problem |
|---|---|---|
| `auth_expired` | the grant was withdrawn or expired | the **user's** — they reconnect, and the dashboard tells them so |
| `rate_limited`, `provider_error` | the provider refused this attempt | nobody's; the ladder retries |
| `budget_exhausted` | the tenant's spend cap stopped the import | the user's, and reconnecting does **not** fix it |
| `tenant_unavailable` | the brain's own database could not be opened | ours — substrate, not connector |
| `handler_error` | the code threw and named nothing | ours, and it is a bug |

`items_failed` on the last attempt is the number that separates "nothing arrived
this week" from "part of the mailbox is missing"; `last_success_at` separates a
connector that broke on Friday from one that has never worked. Neither needs the
tenant's database — the worker banks both at the end of every attempt, which is
also why this answers for a tenant whose compute is suspended or unreachable.

**What is deliberately not here:** which message, which subject, which sender.
`control.connector_health` holds codes, counts and timestamps, and its column
types cannot hold anything else. The per-item record stays in the tenant's own
`ingest_log`, where a provider's id for somebody's mail belongs.

The same facts reach the user in their own words on `/dashboard`, so a support
reply can usually be "look at the panel" rather than a screenshot of this JSON.

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

**And it means the next thing an operator does is open the vendor console and
delete projects by name — which is the step that has already destroyed a real
user's brain once.** Resolve every project you are about to delete to an owner
first: [Before you delete a tenant](#before-you-delete-a-tenant-whose-brain-is-it).
A project whose tenant the directory reports as `OWNED` is somebody's, however
empty and however recently created it looks.

## Known limits

**The secret store used to be a snapshot, and that is fixed.** What follows is
kept because it is the shape of the failure, and because a reader upgrading from
an older deployment needs to recognise it.

`BRAINZ_SECRETS_JSON` was one Workers secret, capped at 5 KB — around 15 to 17
tenants — materialised into each container's own temporary file at start.
`secret-file.ts` assumes one writer and readers on the same volume, and
Cloudflare Containers have no shared volume. So a signup served by the web fleet
provisioned a real Neon project, banked the tenant's connection string into
**that container's own copy**, and:

* the MCP fleet could not see it — that tenant's bearer resolved to nothing,
  `POST /token` answered `{"error":"invalid_grant"}`, and every tool call
  answered `unauthorized`;
* the web instance itself lost it when it was replaced or slept out
  (`sleepAfter` 15m), so even the process that wrote it forgot.

The store is now the control-plane database, which both fleets already reach:
`src/control/secret-pg.ts`, one row per namespace in `control.tenant_secret`,
every value sealed with AES-256-GCM under `BRAINZ_SECRET_ENCRYPTION_KEY` and
bound to the namespace it is stored under. A tenant provisioned by the web fleet
is resolvable by the MCP fleet immediately, with no deploy, no `wrangler secret
put` and no restart, and it survives the loss of every container.
`test/fleet/cross-fleet-secrets.test.ts` drives exactly that across two spawned
fleet processes, and keeps the old failure as a witness beside it.

Two consequences worth knowing:

* **The key is the thing to keep.** It never enters the database it opens, so a
  control-plane dump, backup or leaked DSN yields ciphertext — and losing the key
  loses every tenant's credentials as surely as losing the database would.
  Generate it with `openssl rand -base64 32` and store it wherever you store the
  things you cannot regenerate.
* **`BRAINZ_SECRETS_JSON` is now a bootstrap seed.** The first fleet to start
  imports it once, entry by entry, and it can never overwrite a durable entry or
  resurrect a revoked one. Once
  `SELECT digest FROM control.secret_seed` returns a row, delete the secret:
  `bunx wrangler secret delete BRAINZ_SECRETS_JSON`. Leaving it set is a stale
  copy of every tenant's credentials sitting in three containers' environments.

**A self-hosted deployment with a real volume keeps the file backend**, by name:
`BRAINZ_SECRET_BACKEND=file` plus a `BRAINZ_SECRETS_FILE` on that volume. It is
never fallen back into — a missing variable refuses at start rather than quietly
downgrading to a per-container store.

**The OAuth authorization store used to be in-memory, and that is fixed.** Kept
here because it is the shape of the failure and an operator upgrading needs to
recognise it: `serve.ts` composed `createInMemoryAuthorizationStore()`, so the
registered clients, the authorization codes, the refresh tokens and the
revocation set were `Map`s and a `Set` inside one container. `sleepAfter` is 15
minutes and the whole flow is pinned to one Durable Object, so all of it was lost
every time that instance slept or was replaced. A connector was forgotten between
sessions, an idle one broke after fifteen minutes, and **a grant the user revoked
came back to life** — a security property failing open. Deleting a container
application, which this file recommends, wiped it instantly.

It is now `control.oauth_client`, `oauth_code`, `oauth_refresh`,
`oauth_revocation` and `oauth_registration` in the control plane
(`src/control/oauth-store.sql`, applied by `ensureAuthorizationStoreSchema` under
its own advisory lock by whichever fleet starts first). Two consequences for a
deployment:

* **`BRAINZ_SECRET_ENCRYPTION_KEY` is now required on the MCP fleet even on the
  `file` secret backend.** The two are independent choices: a file-backed
  deployment still has a control plane, so it can hold its OAuth state durably,
  and it needs the same key to seal the client and record bodies. A missing key
  refuses at start rather than downgrading to a `Map`.
  `BRAINZ_AUTHORIZATION_BACKEND=memory` is the opt-out and has to be spoken —
  it is deliberately absent from `MCP_FLEET_VARIABLES`, so the Cloudflare
  deployment cannot be configured back into a per-container store by anybody.
* **The role in `BRAINZ_CONTROL_DATABASE_URL` creates five more tables and five
  more domains**, once, alongside `src/control/secret-store.sql`.

**One port is still in-memory inside the MCP fleet** (`src/mcp/serve.ts` says so
in its own header): the access log. It does not survive a restart, and its
retention policy has a legal half that is not settled.
