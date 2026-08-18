# syntax=docker/dockerfile:1

# The fleet image (U1 step 6).
#
# One image, three fleets. The MCP fleet, the worker fleet and the web app
# differ by *entrypoint*, not by image: same dependency closure, same source
# tree, same base layers, so a security update lands on all three at once and
# they can never drift onto different Bun or library versions. Cloudflare
# Containers sets the entrypoint per Container class (`entrypoint` on the class,
# see wrangler.toml), which is what makes one image serving three fleets
# practical rather than a packaging trick.
#
# The deployed runtime is a Phase 0 deliverable, not an assumption: U6's
# connector connection, U9's week of polling and U13's two-week bake all verify
# against a continuously running fleet, and U6's OAuth discovery metadata binds
# absolute issuer URLs to its public origin.
#
# The entrypoints exist and serve. `src/mcp/serve.ts` binds the MCP surface;
# `src/worker/serve.ts` binds the worker fleet's readiness route and runs the
# scheduler/runner loop. Both print one `{"event":"listening",…}` line to stdout
# after the socket is bound, which is how a supervisor, a test harness or a human
# reading the container log learns the same fact from the same place.
#
# The rule this file now depends on: **CMD must name a module that listens.** It
# previously named `src/mcp/server.ts`, which only exports a factory — run
# directly it evaluated some definitions and exited 0 with an empty stdout and
# nothing on :8080, and the platform read that as a healthy start.
# `test/fleet/image.test.ts` parses this CMD and the entrypoint on each Container
# class and refuses a file that is not one of the serving entrypoints.
#
# THE SECOND RULE, AND WHY THE COMMAND NOW HAS A SCRIPT IN FRONT OF IT
# --------------------------------------------------------------------
# `src/fleet/compose.ts` requires `BRAINZ_SECRETS_FILE` and
# `src/control/secret-file.ts` reads a JSON file: every tenant's connection
# string and bearer grant. That leaves exactly two ways to get one into a
# container, and both of the obvious ones are wrong:
#
#   * COPY it into the image. A credential in a build artefact — as durable as a
#     commit, pushed to a registry, and harder to notice.
#   * Take the path from configuration. Then the deployment can point the fleet
#     at a file *in* the image, which is the first mistake wearing a second hat,
#     and a wrong path silently yields an empty store rather than an error: a
#     fleet that answers `not_found` for every brain it holds.
#
# So the content arrives as a secret (`BRAINZ_SECRETS_JSON`, set with
# `wrangler secret put`, forwarded by `src/mcp/router.ts`) and this image writes
# it to a path **it** chooses, fresh per start, 0600, outside /app — then drops
# the variable and hands over with `exec`. The image cannot contain the store
# because nothing copies one; the deployment cannot name the path because the
# bootstrap overrides it. Neither half can come from the other, which is what
# makes the wrong path unavailable rather than merely discouraged.
#
# AND THAT WAS NOT ENOUGH, WHICH IS WHY THE DEFAULT BACKEND IS NO LONGER A FILE
# ----------------------------------------------------------------------------
# The two limits below were written here as honest caveats and then observed
# live, as a stranger signing up and reaching `{"error":"invalid_grant"}`:
#
#   * It is a **snapshot**. A tenant provisioned after the secret was set is
#     invisible to a running instance until the secret is re-put and the instance
#     restarts. The web process is the only writer (see `secret-file.ts`), and it
#     does not run in this container — on Cloudflare Containers there is no
#     shared volume for it to write through. So the MCP fleet could not resolve
#     a tenant the web fleet had provisioned seconds earlier, and the only copy
#     of that tenant's credential lived in a container's temporary directory.
#   * A Workers secret is capped at 5 KB, so the store was bounded at roughly a
#     dozen tenants.
#
# `src/control/secret-pg.ts` is the durable backend that removes both at once:
# the same `SecretBackend` port, over the control-plane database both fleets
# already hold, with every value sealed under a key that never enters that
# database. It is the default (`BRAINZ_SECRET_BACKEND` unset ⇒ `postgres`), and
# `BRAINZ_SECRETS_JSON` is demoted to a one-time bootstrap seed — imported once
# per blob, never able to overwrite a durable entry, deletable afterwards.
#
# The file backend stays for the self-hoster with a real volume, chosen by name
# (`BRAINZ_SECRET_BACKEND=file`) and never fallen back into: a deployment that
# silently downgraded to a per-container store because a variable was missing is
# the incident above, rediscovered in production.
#
# Build for Cloudflare Containers, which runs linux/amd64 only:
#   docker build --platform linux/amd64 -t brainz-fleet .

# Pinned, never `latest`: the fleet holds tenant connection strings, and a base
# image that changes under us is a supply-chain change nobody reviewed. Digest
# pinning is the next tightening step once the image is in a registry.
ARG BUN_VERSION=1.3.14

# Bumped to force a new container image version, which is the only mechanism
# that replaces running instances. A `wrangler secret put` publishes a new
# Worker version, but a Container's `envVars` are built when its Durable Object
# is constructed and are kept for the life of the instance -- so a config change
# reaches a warm instance only when it is replaced, and an unchanged image gives
# the platform no reason to replace one. Observed 2026-08-17: the OAuth
# allowlist stayed empty through two deploys while seven instances kept serving
# the environment they booted with. Bump this whenever a config change has to
# reach the fleet at all.
#
# **It is necessary and it is NOT sufficient, which the wording here used to get
# wrong.** Bumping does not make a change "take effect now": it makes the change
# eligible to take effect, and a warm instance still serves its old environment
# until it next starts -- i.e. after `sleepAfter` of idle. Measured on
# 2026-08-17 for 2 -> 3: digests moved and `wrangler containers list` cycled
# through `provisioning` within two minutes, and `/authorize` kept answering the
# pre-deploy `401` for another nineteen. Worse, checking keeps the old instance
# alive, because `sleepAfter` runs from the last request. `docs/deploy.md` §4
# carries the timings and the paths that share the instance.
#
# 1 -> 2: the web fleet joined the deployment. Every warm MCP instance is holding
# an environment built before `BRAINZ_WEB_APP_BASE_URL` was set — the value that
# tells the consent screen where to send a user — and a container's `envVars` are
# built when its Durable Object is constructed and kept for the instance's life.
# Without this bump the new secrets publish a Worker version, the running
# instances keep the environment they booted with, and the next reader spends an
# hour debugging a value they can see in `wrangler secret list`.
#
# 2 -> 3: `BRAINZ_IDENTITY_DATABASE_URL` joined the MCP fleet's manifest, which
# is what makes the browser leg of `/authorize` able to resolve a session at all.
# The secret was already set on the Worker — only the manifest changed — so
# nothing about this is visible in `wrangler secret list`, and every warm MCP
# instance is holding an `envVars` built without it. Unbumped, the deploy would
# publish a new Worker version, the running instances would keep serving the
# consent screen a `401`, and the change would look like it did not work.
# 3 -> 4: BRAINZ_NEON_SUSPEND_TIMEOUT=vendor-default, plus the region and pg
# version, joined the deployment. Without the first, every signup on a free-plan
# Neon organisation answers 412 and creates nothing -- `src/web/serve.ts`
# documents that exact refusal, and the shipped default is the one a free plan
# cannot use. Observed live 2026-08-17 as `provisioning_unavailable` 503 on a
# fresh signup while the canary tenant, whose credentials predated the store,
# kept working perfectly.
#
# 4 -> 5: the secret store moved off the per-container file and onto the control
# plane (`BRAINZ_SECRET_BACKEND` defaults to `postgres`,
# `BRAINZ_SECRET_ENCRYPTION_KEY` joins every manifest). Both are new variables,
# so every warm instance is holding an `envVars` built without them: unbumped,
# the deploy publishes a new Worker version and the running fleets keep resolving
# tenants out of the snapshot they booted with — which is the bug this change
# exists to end, still happening after the fix shipped.
#
# 5 -> 6: no configuration changed. This bump exists to REPLACE every running
# instance, which is the only way to ask the question the durable store was
# built to answer: a tenant provisioned by a container that no longer exists
# must still resolve. The store is only durable if it outlives its writer, and
# the writer is only gone once the platform has replaced it — so the epoch is
# the instrument here rather than a side effect. A bump whose whole purpose is
# instance replacement is a legitimate use of this knob; nothing else moves.
# 6 -> 7: the Pipedream credentials joined the web fleet's manifest and the
# worker fleet gained the ingest_pull and import handlers. Both are invisible to
# a warm instance -- the first is a manifest change (nothing to re-put, so
# `wrangler secret list` looks identical), the second is code inside the image.
# 7 -> 8: the OAuth authorization store moved out of one container's memory and
# into the control plane (`src/control/oauth-store.sql`). Pure code, so nothing
# to re-put and nothing a warm instance would ever notice -- and a warm instance
# is exactly what must not survive this one: an instance still running epoch 7
# keeps serving clients, codes, refresh tokens and revocations out of its own
# `Map`, which is the defect. Deploy this with the deterministic reload
# (`containers delete` then `deploy`), not by waiting.
# 8 -> 9: the /brain recovery page and the shared language control. Both
# are code inside the image, so a warm web instance keeps serving the dashboard
# of dead buttons until it is replaced.
# 9 -> 10: the connector controls. The dashboard's "Connected accounts" section
# rendered three words and no form, so a warm web instance keeps serving a
# section that describes connecting an account and offers no way to do it. Pure
# code inside the image -- nothing to re-put, nothing a warm instance notices,
# and the whole point of the change is the markup a warm instance keeps not
# sending. Deploy with the deterministic reload (`containers delete` then
# `deploy`) against the web fleet, not by waiting.
# 10 -> 11: reconciliation -- an authorization completed at the vendor becomes a
# connection this brain polls. This one is BOTH halves of the usual reason.
# Code: the web fleet records the connect intent and reconciles on a dashboard
# render, the worker fleet reconciles on its tick and now composes a real
# connector runtime, so a warm instance of either keeps running the version
# where an attached mailbox is invisible. Manifest: `WORKER_FLEET_VARIABLES`
# gained the vendor's four variables, and `selectContainerEnv` copies a manifest
# once, when the Durable Object is constructed -- so the worker container reads
# them only after it is replaced. The secrets themselves were already set, so
# `wrangler secret list` looks identical before and after and there is nothing
# to re-put: exactly the epoch-3 shape recorded in `docs/deploy.md`. Deploy with
# the deterministic reload (`containers delete` then `deploy`) against the
# worker AND web fleets, not by waiting.
# 11 -> 12: the connector panel's own note, which epoch 11 left saying that
# nothing tells the dashboard about an authorization -- the sentence the same
# epoch made false. Pure markup inside the image, so the failure mode is the
# quiet one this epoch counter exists for: a warm web instance keeps serving the
# paragraph that tells a founder not to bother coming back, on the page that now
# adopts their connection when they do. Web fleet only; the worker serves no
# markup. Deterministic reload (`containers delete` then `deploy`).
# 12 -> 13: the disconnect button, which could not reach the vendor at all --
# `deleteExternalUser` sent no `x-pd-environment` and the vendor refused every
# call with `400 Environment missing`, so `/api/connectors DELETE` answered 500
# for every user on every deployment. Code inside the image, so a warm web
# instance keeps serving the version whose disconnect cannot detach a mailbox.
# Web fleet is where the button is; the worker fleet shares the client and is
# rebuilt anyway. Deterministic reload (`containers delete` then `deploy`).
# 13 -> 14: the Pipedream proxy URL shape. Every connector poll asked the
# vendor for a route it does not have and got 404, logged as provider_error --
# eight consecutive failed runs across all three sources, because they share one
# URL builder. Code inside the image, so warm worker instances keep asking the
# wrong route until replaced.
# 14 -> 15: the way back from a dead lane. Epoch 14 fixed the request shape and
# could not take effect: all three of the live brain's connectors had already
# dead-lettered, and a dead lane stands in the cadence's anti-join forever, so
# nothing would ever ask again. Disconnect now clears a dead lane too, and
# `/admin?op=requeue_connector` clears one without costing the user a
# re-authorization. Web fleet carries the operator surface and the disconnect;
# both live in code inside the image, so a warm instance keeps serving the
# version with no way back. Deterministic reload (`containers delete` then
# `deploy`).
# 15 -> 16: the panel calling every running check a failure. `claim` increments
# `attempts` as it sets `running`, so a healthy first pull reads `attempts = 1`
# and rendered as "the last check did not work" for the whole four to five
# minutes a mailbox poll takes, against a five-minute cadence. Web fleet renders
# the panel; code inside the image, so a warm instance keeps alarming its owner
# about a working connector. Deterministic reload (`containers delete` then
# `deploy`).
# 16 -> 17: the retry ladder becomes a property of the job kind. `ingest_pull`
# waits on somebody else's API, so its five attempts at 30s doubling to 15
# minutes burned in under four minutes -- four of the five rungs inside a single
# 30-minute wake window -- and the vendor-route fix of epoch 14 landed on lanes
# that would never ask again. The connector ladder is now twelve attempts from
# one cron period to a six-hour cap, a failure may declare itself terminal so a
# withdrawn grant stops instead of asking for two days, and a dead lane has a
# user-reachable way back. Worker fleet runs the ladder and the classifier; web
# fleet renders the three states and carries the retry submit. Both are code
# inside the image, so warm instances of either keep running the four-minute
# policy. Deterministic reload (`containers delete` then `deploy`) against the
# worker AND web fleets.
# 17 -> 18: three connector fixes at once, and they are the first epoch whose
# whole content is what a failing lane *records*. (a) A first import was sized
# against three times the life it had: `DEFAULT_MAX_ATTEMPT_MS` promised fifteen
# minutes and `WorkerFleet.sleepAfter` gives roughly five, so a long pull was
# killed by the platform mid-attempt and the next wake filed `attempt_timed_out`
# and charged the attempt. The pull now yields on a wall clock and resumes from
# its cursor. (b) Every folder in a Drive was filed as a document that would not
# parse, so `items_failed` -- the number the connector panel shows an operator --
# counted a folder tree that never changes. (c) `auth_expired` was answered by
# two unrelated classifiers, and since it became terminal in epoch 17 a rotated
# fleet credential would have marked every tenant's every lane dead and asked
# each owner to reconnect an account that was working; the fleet's half is now
# `fleet_auth_failed`, retryable. Worker fleet runs all three (the pull, the
# adapter, the classifier); web fleet renders the new cause and its copy. Both
# are code inside the image, so warm instances of either keep the old behaviour.
# Deterministic reload (`containers delete` then `deploy`) against the worker AND
# web fleets.
# 18 -> 19: reverting the long-import yield budget. It sized every slice
# against `processStartedAtMs + 5m - 1m`, captured once at boot and never
# refreshed -- so a worker process older than four minutes had a yield point
# permanently in the past, and the `attemptedItems > 0` floor capped every slice
# at ONE item. Live consequence: zero net new pages after the deploy, against
# pre-deploy runs of 397s writing 54. Its premise was also false: the container
# is not stopped when the 5m window lapses -- a lane was claimed 28 minutes
# after the cron.
# 19 -> 20: Drive is metadata-only. The adapter no longer exports a native
# document or downloads a binary, so no listing carries objects, `PullPage.media`
# and the runner's step 7a are gone, and the cursor is no longer held by a
# storage seam this fleet has never composed. Warm instances keep the old
# adapter, which is the one that wedges: deterministic reload against the worker
# fleet.
# 20 -> 21: independent verification of the metadata-only Drive. Epoch 20 was
# built and deployed by the change's author; this rebuilds the same tree after a
# second pass over its gates, its scope cut and its live behaviour, and forces
# the worker fleet to be replaced again so the run that is watched afterwards is
# one this checkout produced rather than one it inherited.
ARG FLEET_CONFIG_EPOCH=21

# ---------------------------------------------------------------------------
# Stage 1 — dependencies. Isolated so the lockfile is the only cache key, and
# so nothing from the install step (build caches, dev dependencies, git
# metadata) can reach the final image.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS deps

WORKDIR /app

COPY package.json bun.lock ./

# --frozen-lockfile: the build fails rather than silently resolving a different
# dependency tree than the one CI tested. --production drops devDependencies
# (TypeScript, @types/bun) from the runtime layer; Bun executes the .ts sources
# directly, so there is no compile step to miss them.
# The mkdir is a guard, not a fix: Bun 1.3 does create an empty node_modules
# when the production dependency set is empty (verified), but the COPY below
# would fail hard if a future version stopped doing so, and the failure would
# read as a broken Dockerfile rather than an empty dependency set.
RUN bun install --frozen-lockfile --production \
  && mkdir -p /app/node_modules

# ---------------------------------------------------------------------------
# Stage 2 — runtime. Only what a running fleet member needs.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime

WORKDIR /app

# Consumed as a label so the epoch actually reaches the image config. An `ARG`
# no layer reads changes no digest, the platform sees the same image, and
# nothing is replaced — which is the failure this knob exists to fix, so it
# would be a particularly quiet way to get it wrong.
ARG FLEET_CONFIG_EPOCH
LABEL app.brainz.config-epoch="${FLEET_CONFIG_EPOCH}"

ENV NODE_ENV=production \
    PORT=8080

# The oven/bun images ship an unprivileged `bun` user (uid 1000). Ownership is
# set on copy so the running user never needs write access to its own code.
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun LICENSE ./LICENSE

# ---------------------------------------------------------------------------
# The bootstrap every start path runs. See the header for the decision; this is
# the mechanism.
#
# Written here rather than copied from `bin/` deliberately: a script in the tree
# and a Dockerfile that installs it are two artefacts that can drift, and this
# one is small enough that the drift would cost more than the duplication saves.
# `test/fleet/image.test.ts` lifts it back out of this heredoc and *executes* it,
# so it is a control rather than a claim.
#
# root-owned and 0755: the `bun` user runs it and must never be able to rewrite
# the thing that materialises the store it then reads.
# ---------------------------------------------------------------------------
COPY --chmod=0755 <<'FLEET_BOOTSTRAP' /usr/local/bin/fleet-bootstrap
#!/bin/sh
# Materialise the secret store, then hand over. See the Dockerfile header.
set -eu

# What the blob is now: a bootstrap SEED, not the store.
#
# On the `file` backend it is still the whole store, and an absent one is not
# "no tenants yet" — it is a fleet that answers `not_found` for every brain it
# holds, which reads as data loss. So that case still refuses, in the wording
# `src/fleet/env.ts:refuseToStart` uses, so an operator sees one phrase for every
# configuration refusal whichever layer noticed.
#
# On the default `postgres` backend the store is the control-plane database and
# the blob is optional: it is imported once, can never overwrite a durable entry
# (`src/control/secret-pg.ts:importSecretSeed`), and a deployment that has
# already migrated deletes the secret. Refusing here would make the migrated
# state unreachable — the operator would have to keep a stale snapshot set
# forever to satisfy a check about a store this image no longer uses.
if [ -z "${BRAINZ_SECRETS_JSON:-}" ]; then
  if [ "${BRAINZ_SECRET_BACKEND:-postgres}" = "file" ]; then
    printf 'refusing to start: BRAINZ_SECRETS_JSON is required and was not set\n' >&2
    exit 1
  fi
  # Nothing to materialise, and nothing to leave lying around. The fleet reads
  # its store over the network.
  exec "$@"
fi

# Ignored, and said out loud. Silently overriding it would leave an operator who
# mounted a volume wondering why their store is not being read.
if [ -n "${BRAINZ_SECRETS_FILE:-}" ]; then
  printf 'note: BRAINZ_SECRETS_FILE=%s is ignored; this image chooses the path\n' \
    "$BRAINZ_SECRETS_FILE" >&2
fi

# 0600 by construction rather than by a later chmod: the file is never
# momentarily group-readable. `mktemp -d` makes the directory 0700 as well, so
# the path is unguessable and fresh per start — nothing here can be baked.
umask 077
secrets_dir="$(mktemp -d "${TMPDIR:-/tmp}/brainz-secrets.XXXXXX")"
BRAINZ_SECRETS_FILE="$secrets_dir/secrets.json"
export BRAINZ_SECRETS_FILE
# `printf` is a shell builtin here, so the value never becomes an argv anybody
# can read out of /proc.
printf '%s' "$BRAINZ_SECRETS_JSON" > "$BRAINZ_SECRETS_FILE"

# Validate the bytes actually written, not the variable. Malformed JSON would
# otherwise boot green and fail at the first tenant resolve, which surfaces as
# an outage for one user rather than as a bad deploy.
if ! bun -e 'const store = JSON.parse(await Bun.file(Bun.env.BRAINZ_SECRETS_FILE).text()); if (typeof store !== "object" || store === null || Array.isArray(store)) throw new Error("not an object")' 2>/dev/null; then
  rm -rf "$secrets_dir"
  printf 'refusing to start: BRAINZ_SECRETS_JSON is not a JSON object\n' >&2
  exit 1
fi

# The fleet needs the file, never the blob. Left set, every tenant's connection
# string would sit in the environ of the process that parses attacker-supplied
# content, for the life of the instance.
unset BRAINZ_SECRETS_JSON

# `exec`, so the fleet process is the container's own — a wrapper shell would
# swallow the SIGTERM the platform sends on scale-to-zero.
exec "$@"
FLEET_BOOTSTRAP

# Non-root from here down. The MCP fleet parses attacker-supplied content
# (mailbox payloads reach it), so the blast radius of a parser bug should stop
# at a process that owns nothing.
USER bun

EXPOSE 8080

# Readiness is Cloudflare's port poll against the Container class's
# `pingEndpoint`, not a Docker HEALTHCHECK — the platform ignores the latter.

# Default command is the MCP fleet, through the bootstrap. The worker fleet and
# the web fleet run this same image with `entrypoint` overridden on their
# Container classes (see `WorkerFleet` and `WebFleet` in src/mcp/router.ts) — and
# Cloudflare's `entrypoint` *replaces* the container's command rather than adding
# to it, so each override names this same bootstrap. Three explicit argvs, no
# merge semantics to be wrong about.
CMD ["/usr/local/bin/fleet-bootstrap", "bun", "run", "src/mcp/serve.ts"]
