# syntax=docker/dockerfile:1

# The throwaway probe container. THROWAWAY — delete the Worker after use.
#
# Build context is this directory (wrangler resolves `image = "./Dockerfile"`
# relative to the config file), so `container/` is the whole payload.
#
# NO DEPENDENCIES, ON PURPOSE
# ---------------------------
# There is no `bun install` step and no lockfile copy. The probe speaks the
# Postgres v3 wire protocol itself over Bun and Node built-ins, which is what
# lets ONE implementation run over BOTH transports under test — raw TCP on 5432
# and a WebSocket on 443. Had a driver been used for each, a difference in
# outcome could have been a difference between drivers rather than between
# transports, and attributing that difference is the entire job.
#
# It also means this image cannot fail to build because a registry was down
# while someone was trying to settle an architectural question.
#
# Cloudflare Containers run linux/amd64. Wrangler handles the platform flag
# during `wrangler deploy`; if you build by hand, pass it:
#   docker build --platform linux/amd64 -t brainz-probe-container-tcp .

# Pinned to the same Bun as the fleet image, so the runtime being measured is
# the runtime that will ship.
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --chown=bun:bun container ./container

# Non-root. The probe holds a live connection string in memory for the duration
# of one request; there is no reason for the process that holds it to own
# anything on disk.
USER bun

EXPOSE 8080

# Cloudflare mounts its egress-interception CA at container start when outbound
# HTTPS interception is active. The probe used to merely RECORD that the file
# existed, which meant an intercepted container failed every HTTPS candidate
# (the generic control, the WebSocket, the one-shot HTTP control) on
# certificate validation and reported it as platform denial with no way out.
# Trusting it here is the remedy; the report still records both the CA's
# presence and whether this took effect (`extra_ca_configured`).
#
# It has to happen in the entrypoint rather than as an `ENV`: the file is
# mounted at start, and a value pointing at a missing file is worse than none.
CMD ["sh", "-c", "CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt; if [ -r \"$CA\" ]; then export NODE_EXTRA_CA_CERTS=\"$CA\"; fi; exec bun run container/server.ts"]
