# syntax=docker/dockerfile:1

# The fleet image (U1 step 6).
#
# One image, two fleets. The MCP fleet and the worker fleet differ by
# *entrypoint*, not by image: same dependency closure, same source tree, same
# base layers, so a security update lands on both at once and the two can never
# drift onto different Bun or library versions. Cloudflare Containers sets the
# entrypoint per Container class (`entrypoint` on the class, see wrangler.toml),
# which is what makes one image serving two fleets practical rather than a
# packaging trick.
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
# Build for Cloudflare Containers, which runs linux/amd64 only:
#   docker build --platform linux/amd64 -t brainz-fleet .

# Pinned, never `latest`: the fleet holds tenant connection strings, and a base
# image that changes under us is a supply-chain change nobody reviewed. Digest
# pinning is the next tightening step once the image is in a registry.
ARG BUN_VERSION=1.3.14

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

ENV NODE_ENV=production \
    PORT=8080

# The oven/bun images ship an unprivileged `bun` user (uid 1000). Ownership is
# set on copy so the running user never needs write access to its own code.
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun LICENSE ./LICENSE

# Non-root from here down. The MCP fleet parses attacker-supplied content
# (mailbox payloads reach it), so the blast radius of a parser bug should stop
# at a process that owns nothing.
USER bun

EXPOSE 8080

# Readiness is Cloudflare's port poll against the Container class's
# `pingEndpoint`, not a Docker HEALTHCHECK — the platform ignores the latter.

# Default entrypoint is the MCP fleet. The worker fleet runs this same image
# with `entrypoint` overridden on its Container class (see `WorkerFleet` in
# src/mcp/router.ts).
CMD ["bun", "run", "src/mcp/serve.ts"]
