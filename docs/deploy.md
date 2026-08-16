# Deploying the fleet

The exact commands, in order, from a clean checkout — plus how to tell the
deploy is actually serving, and how to take it down without leaving billable
things behind.

`wrangler.toml` is the configuration and carries the *decisions* (tenant
affinity, `sleepAfter`, the cron, why there is no R2 binding). This file is the
*procedure*. When they disagree, the configuration is right and this file is
stale.

## What this deploys, and what it does not

`wrangler.toml` deploys one Worker and **two** container fleets out of one image:

| Piece | What it is | Started by |
|---|---|---|
| `brainz-fleet` (Worker) | The router. Resolves the tenant from the bearer, admits or rate-limits, forwards to a container. | Every request to the public origin. |
| `McpFleet` (container) | `src/mcp/serve.ts` — the MCP surface and the OAuth endpoints. | The router, per tenant. |
| `WorkerFleet` (container) | `src/worker/serve.ts` — the scheduler and consolidation loop. | The `[triggers]` cron, via the router's `scheduled` handler. |

**The web app is not here.** `src/web/serve.ts` — signup, billing, BYOK,
erasure — is a third process with its own configuration
(`BRAINZ_IDENTITY_DATABASE_URL`, the Stripe secrets, `BRAINZ_WEB_ORIGIN`) and no
Container class in this config. It runs wherever you host it, and the one thing
it must share with these fleets is the secret store — see
[Known limits](#known-limits) before you assume that works by itself.

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

The dry run builds both container images and prints the bindings without
creating a single cloud resource. It is the cheapest possible way to find a
broken Dockerfile or a config typo.

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
`MCP_FLEET_VARIABLES` and `WORKER_FLEET_VARIABLES`, and a variable that is not on
one does not reach a container at all.

```bash
bunx wrangler secret put BRAINZ_PUBLIC_ORIGIN            # https://brainz-fleet.<your-subdomain>.workers.dev
bunx wrangler secret put BRAINZ_CONTROL_DATABASE_URL
bunx wrangler secret put BRAINZ_SECRETS_JSON
bunx wrangler secret put BRAINZ_CF_ACCOUNT_ID
bunx wrangler secret put BRAINZ_HOSTED_KEY_CLOUDFLARE
bunx wrangler secret put BRAINZ_HOSTED_KEY_OPENAI
```

| Secret | MCP | Worker | Required? | What reads it |
|---|:--:|:--:|---|---|
| `BRAINZ_CONTROL_DATABASE_URL` | ✓ | ✓ | yes | `compose.ts:openControlPlane`; the worker opens a second handle for lease renewal (hazard H4). |
| `BRAINZ_SECRETS_JSON` | ✓ | ✓ | yes | The image's bootstrap writes it to a file and points `BRAINZ_SECRETS_FILE` at it. See [Known limits](#known-limits). |
| `BRAINZ_CF_ACCOUNT_ID` | ✓ | ✓ | on the `hosted` profile | `compose.ts:selectFleetTransport` — the Cloudflare seats bill through `…/accounts/{id}/ai`. Not needed by `self-host`. |
| `BRAINZ_HOSTED_KEY_CLOUDFLARE` | ✓ | ✓ | on the `hosted` profile | The pooled credential for eight of the nine model seats. |
| `BRAINZ_HOSTED_KEY_OPENAI` | ✓ | ✓ | for embeddings | The embedding seat, which did not move to Unified Billing. |
| `BRAINZ_HOSTED_KEY_GOOGLE` | ✓ | ✓ | self-host only | A direct Google relationship. No hosted route reads it. |
| `BRAINZ_HOSTED_KEY_SELF_HOST` | ✓ | ✓ | self-host only | A local/self-hosted inference endpoint's credential. |
| `BRAINZ_ROUTING_PROFILE` | ✓ | ✓ | no (`hosted`) | Which routing table (`src/ai/routing.ts`). |
| `BRAINZ_PUBLIC_ORIGIN` | ✓ | — | yes | The OAuth issuer. A batch process publishes no issuer, so it does not travel to the worker fleet. |
| `BRAINZ_OAUTH_REDIRECT_URIS` | ✓ | — | no (empty) | Dynamic-registration allowlist. Empty refuses every registration, which is the fail-closed default. |
| `BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR` | ✓ | — | no (`0`) | Same allowlist, rate half. |
| `BRAINZ_WEB_APP_BASE_URL` | ✓ | — | no | Where a consent screen sends a user. |
| `BRAINZ_WORKER_CONCURRENCY` | — | ✓ | no (`4`) | Jobs one instance runs at once. |
| `BRAINZ_WORKER_TICK_MS` | — | ✓ | no (`60000`) | The loop's period once the instance is awake. |

Deliberately absent from both manifests, so do not bother setting them here:
`BRAINZ_IDENTITY_DATABASE_URL` and the Stripe secrets (the web process's),
`BRAINZ_SECRETS_FILE` (the image chooses the path — setting it is ignored, with a
note on stderr), and any Neon or R2 credential (nothing in either fleet reads
one; see the `NO R2 BINDING` block in `wrangler.toml`).

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
instance when it next starts — which for the MCP fleet is up to `sleepAfter`
(15m) after it goes idle.

## 5. Verify that it serves

"Deployed successfully" is a statement about an upload. These four checks are
statements about the fleet.

```bash
ORIGIN=https://brainz-fleet.<your-subdomain>.workers.dev
```

**1 — the container starts and answers.** Not the Worker: `/health` is served
inside the MCP container, so a 200 here proves an instance booted, bound :8080
and was reached through the Durable Object.

```bash
curl -si "$ORIGIN/health" | head -1        # HTTP/2 200
```

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

**It is also not shared with the web app.** `secret-file.ts` assumes one writer
(the web process) and readers on the same volume. Cloudflare Containers have no
shared volume and the web app is not deployed here, so a tenant provisioned
after you set the secret is invisible to the fleet until you re-run
`wrangler secret put BRAINZ_SECRETS_JSON` and the instances restart. For an
alpha with a handful of tenants that is a chore; it is not a design, and it is
the first thing the managed store fixes.

**Two ports are in-memory inside the MCP fleet** (`src/mcp/serve.ts` says so in
its own header): the OAuth authorization store and the access log. With more
than one MCP instance, a code minted on one cannot be redeemed on another. Under
tenant affinity a single tenant's flow stays on one instance, and the OAuth flow
is pinned to a single named instance for the same reason — but a restart mid-flow
still loses it.
