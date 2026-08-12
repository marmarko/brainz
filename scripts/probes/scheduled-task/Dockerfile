# Probe-only image. Build with THIS DIRECTORY as the context, not the repo root:
#
#   docker build -t brainz-probe scripts/probes/scheduled-task/
#
# The repo-root .dockerignore excludes `scripts/` and `*.md` from the fleet image
# build context, so a root-context build would not see this probe at all. Using
# the probe directory as the context also keeps the image to one file.
#
# The probe has zero dependencies, so there is no install step and no lockfile.

FROM oven/bun:1.3-alpine

WORKDIR /app
COPY serve.ts ./serve.ts

# Where the append-only log lives. MOUNT A VOLUME HERE.
# Without a volume the filesystem is ephemeral: a restart erases the evidence and
# an unattended call that DID happen reads as "never fired" — a false FAIL, which
# is exactly as expensive as a false pass. Set PROBE_LOG_DURABLE=1 once mounted.
ENV PROBE_LOG_PATH=/data/probe-log.jsonl
VOLUME ["/data"]

# Platforms inject PORT; 8787 is the local default.
ENV PORT=8787
EXPOSE 8787

# PROBE_MCP_TOKEN and PROBE_ADMIN_TOKEN are deliberately NOT defaulted here.
# The server refuses to start without them rather than minting its own, because a
# silently rotated token breaks the connector URL and looks like a failed probe.

CMD ["bun", "run", "serve.ts"]
