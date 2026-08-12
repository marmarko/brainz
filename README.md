# brainz

A personal AI brain you can actually set up.

brainz ingests your mail, calendar, documents and chat history, consolidates them
into durable knowledge, and serves that knowledge to the agents you already use —
Claude Desktop, Claude Code, and later ChatGPT — over stateless MCP.

The bar it is built against: **a non-technical user reaches a working brain with
account signup and OAuth consent.** No CLI, no API keys, no daemons, no
setup questions.

> **Status: pre-alpha.** The repo is public from its first commit because the
> server core is AGPL-3.0 and always will be. Nothing here is usable yet. The
> roadmap it is being built against lives in
> [`docs/plans/`](docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md).

## Why this exists

The hard part of a personal brain is not storing things — it is retrieval
accuracy, unattended upkeep, and being reachable from the tools you already have
open. Systems that get that right tend to demand a technical operator: a CLI to
install, a git repo to point at, a daemon to keep alive, your own model keys.
That excludes almost everyone.

brainz keeps the accuracy work and removes the operator.

## Shape

- **One database per user.** Each brain is its own Postgres project — its own
  branch, database and role. The connection string is the isolation receipt.
- **Retrieval, not just storage.** Vector + full-text + graph recall fused with
  RRF, alias resolution, dedup, token budgeting, and a cross-encoder rerank.
  Accuracy floors are enforced in CI, not asserted in a README.
- **Consolidation runs itself.** Extraction, enrichment, salience, contradiction
  detection and summarization run on a schedule against a spend cap, with no
  user operation once a source is connected.
- **Stateless MCP is the only surface.** No proprietary client. If your agent
  speaks MCP, it can use your brain.
- **Your data leaves by the front door.** Export is slug-nested markdown, byte
  identical to the self-host import format.

## Licence

[AGPL-3.0-only](LICENSE). The server core is open from the first commit and stays
open; network use counts as distribution, which is the point. A hosted option
will exist for people who do not want to run infrastructure — it runs this same
code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/) — sign off
your commits with `git commit -s`.

## Repository map

| Path | What lives there |
|---|---|
| `src/mcp/` | The MCP surface — tools, envelope, OAuth, dispatch |
| `src/core/` | Write path, retrieval stack, consolidation, media |
| `src/worker/` | Typed job runner and the scheduled fleets |
| `src/control/` | Control plane, tenant provisioning, secret store |
| `src/ai/` | The single model gateway: routing, metering, pricing, keys |
| `upstream/` | `concepts.jsonl` — the capability ledger CI enforces |
| `docs/` | Plans, research, and the porting-hazard ledger |
| `scripts/probes/` | Throwaway probes that settle load-bearing assumptions |
| `test/hazards/` | One skipped test per unguarded hazard, with its reason |

## The hazard ledger

`docs/porting-hazards.md` records failure modes that are invisible in
development and only appear on a real user's brain — the kind that present as
"our ranking is mediocre" rather than as an error. Each one ships as a **skipped
test naming its reason**, so `bun test` prints the count of hazards that are
known and not yet guarded. That number should go down, and it should never be
zero by accident.
