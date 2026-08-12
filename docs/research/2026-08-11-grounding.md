# Shared grounding — consumer-grade personal AI brain (derived from gbrain)

Repo: `/Users/marmarko/code/gbrain` (branch `marmarko/railway-deploy`)

**Provenance note.** Five evidence scouts ran; three were read-only and returned findings
inline, so the EVIDENCE sections below *are* the evidence layer. You may spend up to **5
targeted reads** in the repo following the `file:line` pointers below to verify or deepen a
basis. A `direct:` basis must quote a line you actually read — never a guessed citation.

**Conflict flag.** The codebase scan reported "176 MCP operations / 133 CLI commands"; the
MCP scout counted 107 named ops (62 read / 16 write / 26 admin) plus 5 memory verbs ≈ 111,
matching `CLAUDE.md` ("~110 shared operations") and the README ("110 tools"). **Treat ~110
as the number**; 176 is unverified. Schema is at migration v125.

---

## EVIDENCE — Axis 1: Onboarding & source connection

**`gbrain init` decision points (all quoted from the repo):**
- `src/commands/init.ts:115-131` — engine picker fires on file count: `"Found ~${fileCount} .md files. For a brain this size, Supabase gives faster search and remote access ($25/mo)."` → suggests `gbrain init --supabase` or `gbrain init --pglite`.
- `src/commands/init-provider-picker.ts:119` — `"Pick a embedding provider (env-ready providers shown):"`; `:136-139` — `"Choice [1-${ready.length}, default 1]:"` with a 60s timeout.
- `src/commands/init-mode-picker.ts:117-157` — third picker: search mode (conservative / balanced / tokenmax) presented as a **per-query cost matrix @ 10K queries/mo**.
- `src/core/init-embed-check.ts:129` — `"Without it, \`gbrain sync\` imports pages but embeds 0 (search + code graph stay empty)."`; `:131-133` — remediation: `"• Set the key above, then run \`gbrain sync\`. • Or defer embedding entirely: re-run init with --no-embedding."`
- `src/commands/init.ts:495-514` — no key set → `"Set one of: export OPENAI_API_KEY=... OR pick explicitly OR defer: --no-embedding"`.
- `src/commands/init.ts:466-492` — `findEnvKeyTypos` matches user env vars against canonical recipe names, suggests nearest match at edit distance ≤3. (Zero-config effort already exists — it's aimed at people who already have env vars.)

**Prerequisites the install path assumes:**
- `docs/INSTALL.md:31` — postinstall can fail; documented fallback is `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`.
- `docs/INSTALL.md:42` — `"API keys live in ~/.gbrain/config.json (file plane) or env vars"`.
- `src/commands/autopilot.ts:112-149` — requires `which gbrain` on PATH or a compiled binary; falls back to `process.execPath` / `argv[1]`.
- `src/commands/init.ts:142-148` — `--non-interactive` requires `--url <connection_string>` or `GBRAIN_DATABASE_URL`.

**A source must be a git repo:**
- `src/commands/sources.ts:11-12` — `"--path must be a git-initialized repo (files committed, not just present) — #2707"`.
- `src/core/sources-ops.ts:337-348` — no auto-`git init`; fail-fast at add-time; `force: true` opts out.
- `docs/guides/multi-source-brains.md:145-149` — documented fix is `git -C <path> init && git -C <path> add -A && git -C <path> commit -m "initial import"`.
- `src/commands/sources.ts:126` — forms: `--path <path> | --url <https-url> | --clone-dir <path>`; `src/core/sources-ops.ts:370` — URL sources clone to `$GBRAIN_HOME/clones/<id>/`.
- `src/commands/sources.ts:68-71` — source id `"Must be 1-32 lowercase alnum chars with optional interior hyphens"`.
- **There are no OAuth data connectors.** Ingestion is file/git-only. `docs/integrations/` holds Markdown+YAML *recipes* (credential-gateway, embedding-providers, meeting-webhooks, qm-harness, reliability-repair) with health-check types (HTTP probe, env-exists, command, heartbeat-staleness) and heartbeat JSONL at `~/.gbrain/integrations/<id>/heartbeat.jsonl` (`src/commands/integrations.ts`).

**Recurring ingestion must be installed by hand:**
- `src/commands/autopilot.ts:375-376` — `gbrain autopilot --install [--repo <path>]`; `:1369` auto-detects launchd (macOS) / systemd / cron / ephemeral-container; `:1404-1421` writes `com.gbrain.autopilot` plist, logs to `~/.gbrain/autopilot.log`; `:1469-1486` systemd unit `Restart=always, RestartSec=30`.
- `src/commands/autopilot.ts:3-11` — default (Postgres) spawns a `gbrain jobs work` child and submits **one `autopilot-cycle` job per interval**; `:388` default interval **300s**.
- `src/commands/autopilot.ts:394-396` — requires `--repo <path>` or a prior `gbrain sync --repo`.

**Thin-client (remote-only) install already exists but is hidden:**
- `src/commands/init.ts:688-691` — `gbrain init --mcp-only` requires `--issuer-url`, `--mcp-url`, `--oauth-client-id`, `--oauth-client-secret` (or env). No auto-discovery.

---

## EVIDENCE — Axis 2: Isolation & security

**Trust boundary is fail-closed and already load-bearing:**
- `src/core/operations.ts:794-809` — `"FAIL-CLOSED: anything not strictly ctx.remote === false is untrusted."` … `__all__`/`all_sources`: trusted local → `{}` (whole brain); remote → the caller's grant. Explicit `source_id` with a federated grant that excludes it → `permission_denied`.
- `src/core/operations.ts:479-522` — `AuthInfo`: `sourceId?: string` (write authority, from `oauth_clients.source_id`); `allowedSources?: string[]` (read federation, from `oauth_clients.federated_read`).
- `src/commands/serve-http.ts:2062-2064` — the HTTP path hardcodes `remote: true` and passes `sourceId: tokenSourceId`.

**Write-fencing within a source:**
- `src/core/oauth-provider.ts:39-62` — `bound_slug_prefixes` entries must be non-empty slug prefixes (e.g. `"emp-alice/"`), with an explicit segment-boundary requirement so `"${p}"` can't silently cover sibling namespaces like `"${p}-2/..."`.
- `src/core/pglite-schema.ts:36-50` — `oauth_clients` carries `federated_read TEXT[] NOT NULL DEFAULT '{}'`, `bound_slug_prefixes TEXT[] NULL`, `source_id TEXT`.

**The gaps, stated in the repo's own words:**
- `SECURITY.md:163-173` — `"OAuth and source scoping enforce isolation on the serve --http path only. Raw Postgres reachability bypasses both: a container that shares Docker's default bridge network with the brain's Postgres can open a direct DB session without any token and read every source."`
- `src/core/pglite-schema.ts:1-5` — `"Differences from Postgres: - No RLS block (no role system in embedded PGLite)"`.
- `src/core/postgres-engine.ts` — RLS scope binding is **opt-in via `GBRAIN_RLS_SCOPE_BINDING=1`**, described as `"defense-in-depth layer 2"` behind the app layer.
- `src/core/source-config-redact.ts:13-40` — `webhook_secret` is redacted **on output only**; the original is stored plain in the `sources.config` JSONB.
- `TODOS.md` (P2) — `"Two spots in src/core/think/index.ts don't yet [have] isolation."`

**Hardening that does exist:**
- `SECURITY.md:145-153` — `gbrain serve --http` binds `127.0.0.1` by default; remote needs explicit `--bind 0.0.0.0`.
- `SECURITY.md:175-189` — CORS is default-deny; no `Access-Control-Allow-Origin` unless an allowlist matches.
- `src/commands/serve-http.ts:2016-2020` — request payloads redacted by default in `mcp_request_log` + SSE feed; `--log-full-params` is the operator escape hatch.
- `src/cli.ts` — file ops are `localOnly`: `"files list and files url MCP ops are localOnly (paths live on the host filesystem)"`.

---

## EVIDENCE — Axis 3: Cost & runtime

**Four always-on processes today (none serverless):**
- `deploy/railway/Dockerfile` + `entrypoint.sh` dispatch on `GBRAIN_ROLE`: **web** = `gbrain serve --http` (MCP + OAuth + admin SSE), **worker** = `gbrain jobs work` (minion supervisor), **autopilot** = bash loop that clones the brain repo over an SSH deploy key, runs the cycle, commits+pushes, sleeps, repeats.
- Per the deploy README's reasoning: serverless is a poor fit even with stateless MCP because `serve-http.ts` holds **in-memory session maps, rate limiters, and SSE state**.
- Autopilot polls every **300s**; the dream/synthesis loop is nightly and self-scheduling. Recent commits: `66121287 fix(deploy): wall-clock ceiling on the nightly synthesis run`, `9c7a7bb1 fix(deploy): dream scheduler busy-looped under dash`.

**Spend guards exist and are hard-fail:**
- `src/core/budget/budget-tracker.ts` — `BudgetExhausted` thrown when cumulative spend passes `maxCostUsd`; **hard-fails on unknown pricing when capped**; `spend.posture` switches to informational-only; local providers (ollama, llama-server) always $0; best-effort audit JSONL at `~/.gbrain/audit/budget-YYYY-Www.jsonl`. Tracked via `AsyncLocalStorage<BudgetTracker>` so every gateway call auto-records.
- `docs/operations/spend-controls.md` — the cost-gate / off-switch surface.

**The cost incident that produced those guards:**
- `docs/incidents/2026-05-20-lsd-cost-explosion.md` — a single brainstorm run on a 13,690-page brain cost **$50.71 against a $0.96 estimate (53×)**. Far-set selection pulled **1,985 pages instead of 12** (infinite prefix cardinality) generating 15,868 ideas; no mid-run circuit breaker; the judge LLM received all ideas at once and overflowed context; unpaired UTF-16 surrogates crashed JSON serialization.

**DB pressure is a known constraint:**
- `src/core/db-pacer.ts` — caps in-flight writes via an EWMA-driven cooperative sleep; the CLAUDE.md pace-mode table gives `maxConcurrency` 4/8/16 for gentle/balanced/aggressive, default **off**.
- Naive `embed --stale` / large `sync` saturates a PgBouncer transaction-mode pooler and starves the minion supervisor's lock renewals → `lock-renewal-failed` → dead jobs. Lock refresh runs every ~30s against a 5-min TTL.
- `GBRAIN_SYNC_STALL_ABORT_SECONDS` default 900 — progress-aware stall watchdog.

**PGLite is not viable for hosted:**
- Exclusive file lock; can't be shared across MCP clients. `CHANGELOG.md` v0.42.41.0 shipped automatic WAL repair (ported `pg_resetwal`) after unclean shutdowns tore the write-ahead log → `RuntimeError: Aborted()`.

---

## EVIDENCE — Axis 4: MCP surface & transport

- **SDK pin:** `@modelcontextprotocol/sdk@1.29.0` (`src/mcp/server.ts:1-2`, `package.json`).
- **Transports:** stdio (`StdioServerTransport`, `src/mcp/server.ts:87`); HTTP (`StreamableHTTPServerTransport`, `src/commands/serve-http.ts:22`); a legacy bearer-token Bun HTTP server (`src/mcp/http-transport.ts:271`).
- **Statelessness:** no session store in the MCP layer — every request is parsed fresh from the JSON-RPC body and context is built per-call (`src/mcp/dispatch.ts:34-102`). *But* `serve-http.ts` holds in-memory rate limiters and SSE state, so the process is not stateless.
- **Auth:** OAuth 2.1 via `mcpAuthRouter` (client_credentials + authorization_code) at `src/commands/serve-http.ts:24`; scope enforcement via `hasScope()` at `:32`. Legacy path: `"Every request must include Authorization: Bearer <token>"` (`src/mcp/http-transport.ts:10`), tokens validated by SHA-256 hash lookup in `access_tokens` (`:212-218`).
- **Two-layer fail-closed tool filtering:** ListTools advertises the filtered set (`src/mcp/server.ts:36`); `dispatchToolCall` gets an `allowedOps` allowlist and hidden ops return `unknown_tool` (`src/mcp/server.ts:82`, `dispatch.ts:96-97`).
- **Surfaces:** full ≈ 111 ops; `--surface verbs` = exactly 5 frozen ops (`src/mcp/surface.ts:56`).
- **The 5 MEMORY_VERBS v1** (all return `protocol_version: 1`, `src/core/verbs.ts:29`):
  - `recall(query?, entity?, budget_tokens?, since?, session_id?, limit?)` → `{facts[], results[], total, budget_tokens?, search_degraded?}`
  - `remember(fact, provenance, ttl?, entity?, kind?, visibility?)` → `{id, status: inserted|duplicate|superseded, entity_slug, valid_until, degraded_dedup?}`
  - `entity(name)` → `{found, latency_ms, card?, suggestions?}` — **p99 < 100ms promise, CI-gated on 20K pages**
  - `synthesize(question, since?, until?)` → `{answer, sources[], gaps[], cost{model, input_tokens, output_tokens, usd_estimate}}` — **marked EXPENSIVE, makes LLM calls**
  - `forget(id, reason?)` → `{id, expired, reason}` — idempotent, audit trail kept, never deleted
- **Uniform error contract:** `invalid_params | provenance_required | not_found | scope_denied | unavailable | internal`, each carrying `message` + `suggestion` (a fix-hint aimed at agents) + optional `detail`.

---

## EVIDENCE — Axis 5: Consumer surface & recipes

- **A briefing is a synthesized narrative, not search results.** `README.md:26-62` shows the actual output shape: *"Alice runs engineering at Acme (a series-B fintech). You last spoke on April 22… Three things are still open from that conversation… Heads up: nothing's been added to the brain about Alice or Acme since April 22, six weeks ago."*
- `skills/briefing/SKILL.md:1-20` — `tools: [search, query, get_page, list_pages, get_timeline]`, `mutating: false`; `:58-74` sections = today's meetings w/ participant context, active deals, time-sensitive threads, last-24h changes, people in play, stale alerts.
- `skills/reports/SKILL.md:31-48` — reports save to `reports/{category}/{YYYY-MM-DD-HHMM}.md` with frontmatter; keyword routing (`"morning"` → `morning-briefing`).
- `skills/cron-scheduler/SKILL.md:1-43` — **max 1 job per 5-minute slot** (`:05,:10,…,:50`), **quiet hours 11PM–8AM local**, results to `reports/{job-name}/{date}.md`.
- `src/core/advisor/run.ts:21-32` — 9 deterministic collectors (version, migration, schema-pack, stalled jobs, usage shape, setup smells, uninstalled brain pack, uninstalled bundled, chronicle). `src/commands/advisor.ts:54-72` — `gbrain advisor --json` exits 0 clean / 1 warn / 2 critical; `--apply <id>` is local-only and confirms first.
- **A GUI exists but is operator-facing:** `admin/src/App.tsx:10-62` — React SPA with pages `login | dashboard | agents | log | calibration | jobs`, OAuth magic-link, "Sign out everywhere."
- `skills/RESOLVER.md` — 45+ skills routed by trigger phrase; `signal-detector` and `brain-ops` are marked always-on (every message).
- **Stated audience is an agent, not a person:** `README.md:78-95` — *"GBrain is designed to be installed and operated by an AI agent. The fastest path is to have your agent do it for you."* Clients listed: Claude Code, Codex, Cursor, Windsurf, Claude Desktop, Perplexity.
- Scale proof: `README.md` cites a production deployment at **146,646 pages, 24,585 people, 5,339 companies, 66 cron jobs**; `docs/GBRAIN_SKILLPACK.md:1-14` cites 14,700+ files, 40+ skills, 20+ cron jobs.

---

## BACKGROUND — codebase context (informative, not directive)

Three install routes exist; the shortest is `bun install -g github:garrytan/gbrain` then
`gbrain init --pglite` (~2 s, zero-config local brain). ~7 init prompts, all with working
defaults. Keys live in `~/.gbrain/config.json` or env (env > file > defaults). **No managed-key
path exists — BYO only.** `gbrain dream` runs a 6-phase cycle (lint → extract → patterns →
synthesize → enrich → conversation-facts) and commits the brain repo. Engine factory swaps
PGLite ↔ Postgres with no code change. Multi-source within one brain DB; `mounts` for
cross-brain. Schema-pack system swaps entity taxonomies without code changes.

Reusable as-is: stdio+HTTP MCP with OAuth, thin-client remote routing, engine swap, dream
cycle, Railway 3-role topology, integration recipes w/ health checks, schema packs, budget
tracker, contract-first ops (CLI+MCP+HTTP all generated from `src/core/operations.ts`).

Would be new: consumer onboarding narrative, OAuth data connectors, managed API keys,
per-consumer infra isolation, billing/usage, one-click hosted signup, consumer GUI.

## BACKGROUND — institutional learnings

1. **Silent fallbacks are deadly.** v0.29 thin-client reflexively opened an empty PGLite and returned zero results instead of failing loudly. Explicit routing + pinpoint errors is the contract.
2. **Cost guards are load-bearing** (see the $50.71 incident). Estimate before running; refuse over budget; test on large brains before GA; chunk judge calls to bound per-call tokens.
3. **Don't defer credential validation to first use** — v0.42.66.0 moved the embedding-key check into `init` (free config check + 1-token test embed, 5s timeout) after users imported everything into an un-embeddable brain.
4. **Multi-tenancy needs DB-level isolation, not UI-level.** The `bound_slug_prefixes` write-fence + `federated_read` pattern works but is complex and must be front-loaded; per-consumer brains are simpler.
5. **Health checks with auto-remediation are mandatory for zero-config** — `skills/smoke-test/` runs 8 checks with check → fix → re-test, extensible via `~/.gbrain/smoke-tests.d/*.sh`; exit code = count of unfixed failures.
6. **Compute/DB split is non-negotiable for hosted**; environment-level shared variables solve credential rotation in one place.

## BACKGROUND — external research (2026)

**MCP spec 2026-07-28 (latest revision).** MCP is now genuinely stateless: the
`initialize`/`initialized` handshake and session IDs are **retired**; each request carries
protocol version + client identity + capabilities standalone, explicitly enabling deployment
"behind a plain round-robin load balancer without shared storage." Tool/method routing moved
into `Mcp-Method` / `Mcp-Name` **HTTP headers** so gateways can route without parsing JSON.
**Dynamic Client Registration is deprecated in favor of Client ID Metadata Documents (CIMD)**
— build against CIMD. OAuth hardening: `iss` (RFC 9207) validation closes an authorization-server
mix-up hole; `application_type` at registration fixes desktop/CLI localhost-redirect rejection.
Legacy HTTP+SSE is deprecated with a ~1-year offramp. **gbrain pins SDK 1.29.0 — verify whether
it speaks this revision.**

**Client constraints.** Claude Desktop/Code: Custom Connectors UI only (a remote server in
`claude_desktop_config.json` is ignored); supports `oauth_dcr`, `oauth_cimd`,
`oauth_anthropic_creds`, `custom_connection`, `static_headers`; Pro/Max/Team/Enterprise only.
**ChatGPT: without Developer Mode, servers lacking exact `search`/`fetch` tools (single query
string in, `{results:[{id,…}]}` out) are rejected.** ChatGPT Work (July 9 2026) — admins approve
custom MCP connectors per workspace, write actions off by default, and **tool definitions freeze
at approval time** (server-side tool changes need a manual admin re-scan). No protocol tool cap,
but real ceilings exist (Cursor hard-caps at 40) and each tool costs ~550–1,400 tokens of system
prompt just for name+schema — this is the argument for the 5-verb surface over ~110 ops.

**Prior art.** Rewind→Limitless: acquired by Meta Dec 5 2025, Pendant sales killed and desktop
app sunset Dec 19 2025 — consumer capture-everything memory is acquisition/shutdown-prone.
Mem0/OpenMemory: 53.5k stars, $24M raised, free self-hosted MCP server + paid cloud
(`mcp.mem0.ai/mcp`) — classic open-core. Zep: pivoted *away* from self-host-first — Graphiti
stays Apache-2.0, platform is now credit-based SaaS ($25–$475/mo). Letta: Pro $20/mo +
$0.10/active-agent/mo (usage-metered, not seat-metered). Cognee $35/$200. Khoj, Onyx (ex-Danswer,
40+ connectors — closest prior art for many-source ingestion), Elroy (CLI-only, the trap gbrain
is escaping).

**Dreaming is now table stakes, not differentiation.** Anthropic shipped "Dreams" for Managed
Agents (May 6 2026); OpenAI shipped "Dreaming V3" for ChatGPT (June 2 2026, third iteration);
Mem0 shipped "Dream" (background consolidation). All three use the sleep-cycle metaphor.
Agent-memory market cited at $6.27B (2026) → $28.45B (2030 proj.).

**Connector economics.** Nango (OSS, 900+ APIs, built-in MCP server, per-user white-label auth)
$0 → $50/mo + $1/connection → $500/mo Growth. Composio $650/mo for 10 linked accounts then
$65/account. Arcade.dev ~112 integrations, self-host option, OAuth 2.1. **None are priced for a
$10–20/mo consumer product at per-user OAuth fan-out** — connector cost-per-user is a real
unit-economics risk.

**Gateways / BYOK.** Vercel AI Gateway passes provider pricing through at zero markup; BYOK bills
the user's provider directly with no gateway fee. OpenRouter takes 5.5% on purchased credits +
5% on BYOK volume over 1M req/mo. LiteLLM and Portkey are self-hostable. Convergent pattern:
hosted-credit tiers need per-user rate/spend caps at the gateway; BYOK sidesteps abuse economics
by making the user's own provider account the blast radius.

**Open-core precedent.** Supabase / PostHog / Cal.com / Plausible all split "self-host free,
cloud convenience paid," commonly AGPL or open-core-with-proprietary-add-ons. PostHog's free
cloud tier (1M events, 5K recordings) is a calibration point for a generous-but-bounded consumer
free tier.

**Hard external constraints.**
1. **Google restricted-scope OAuth + CASA.** Any consumer app reading Gmail beyond narrow scopes needs a Google-empanelled assessor's CASA Tier 2/3 assessment, **re-certified every 12 months**. One source cited "$500+/yr" — treat as unconfirmed and budget a wider range plus multi-week timeline. This is a genuine go/no-go gate on a zero-config Gmail connector.
2. MCP spec churn: DCR→CIMD and the HTTP+SSE sunset clock mean building on the wrong flow creates near-term rework.
3. ChatGPT's `search`/`fetch` name lock-in; Enterprise's approval-time tool freeze means adding ops needs a re-publish flow.
4. Connector vendor pricing is built for B2B tenant counts, not consumer OAuth fan-out.
5. Category mortality risk is recent and real (Rewind/Limitless, Dec 2025).

## BACKGROUND — Cloudflare as a candidate substrate (user-requested research, 2026)

**Verdict.** Cloudflare can credibly deliver "separate DB + separate filesystem per user,
scale-to-zero, agent-only access" for the index layer (D1-per-user or DO-per-user — both
provisionable by API at signup, both genuinely billed to zero when idle) and the file layer (R2,
egress-free). It fits the interactive MCP surface well and the nightly cycle very well. It breaks
where the product wants Postgres-grade capability in one engine.

**Per-tenant isolation options, and the limit that decides each:**

| Option | Boundary | Deciding limit |
|---|---|---|
| **D1-per-user** | Separate SQLite file/user, own backups + PITR | 10 GB/DB hard (no resize); **1 TB per-account default** (raisable) — bites ~10k users; jurisdiction locked at creation |
| **DO-per-user (SQLite-backed)** | Separate single-threaded actor, own PITR | 10 GB/object; **no account storage cap on Paid**; must use Hibernation API or duration billing spikes ~10× |
| **Workers for Platforms** | Isolated *code* per tenant | Wrong axis — all users run identical code over different data; adds $25/mo + per-script fees for no isolation gain |
| **External Postgres via Hyperdrive** | Whatever the origin provides | Hyperdrive is a pooler/cache, not a DB; isolation is entirely on you at origin; forfeits scale-to-zero |

**Numbers (official docs unless marked):**
- **D1** — 50,000 DBs/account (Paid); 10 GB/DB hard cap, no resize; 1 TB/account default; $5/mo min, includes 25 B rows read + 50 M written + 5 GB storage, then $0.001/M read, $1.00/M write, **$0.75/GB-mo**. Programmatic creation via `POST /accounts/{id}/d1/database` — signup-time provisioning works. Time Travel PITR 30 days (Paid). Sessions API gives free read replicas w/ sequential consistency. Cold first-query ~700 ms vs ~300 ms warm `[unconfirmed as universal]`. **No native vector search.** Has **SQLite FTS5** (lexical only). `SQLITE_BUSY` reported above ~200 writes/sec/DB `[unconfirmed, single blog]`.
- **Vectorize** — 50,000 indexes/account; 20 M vectors/index; **1536 dims max**; **namespaces (≤1,000/index) are the tenant-isolation mechanism**, applied before metadata filters; 10 metadata indexes/index; topK 50 w/ metadata, 100 without. $0.01/M queried dims (50 M/mo free), $0.05/100 M stored dims. **ANN only — no BM25/keyword**, so hybrid = D1 FTS5 + Vectorize + your own RRF merge.
- **Durable Objects** — SQLite-backed GA, 10 GB/object, no account cap on Paid. **Alarms** = per-user scheduled work, 15 min max wall time per invocation. Hibernation is load-bearing: a cited WebSocket example is **~$138/mo un-hibernated vs ~$10/mo hibernated**. $0.15/M requests, $12.50/M GB-s, 1 M requests + 400,000 GB-s included.
- **Containers** — billed **per 10 ms while awake**, true scale-to-zero (`sleepAfter`), SIGTERM then SIGKILL after 15 min. Cold start ~100 ms (scratch/Go/Rust) to 1–3 s (heavy Node/Python). Runs arbitrary Docker images — **people run real Postgres inside one**. lite (1/16 vCPU, 256 MiB) → standard-4 (4 vCPU, 12 GiB, 20 GB disk). $5/mo includes 375 vCPU-min + 25 GiB-hr + 200 GB-hr disk.
- **R2** — $0.015/GB-mo, **$0 egress**, Class A $4.50/M, Class B $0.36/M. AES-256-GCM at rest, **Cloudflare-managed keys only — no documented SSE-C / customer-managed per-object keys.** R2 SQL (Iceberg over R2) $2.50/TB scanned.
- **Encryption** — Workers WebCrypto has full AES-GCM/HKDF. Secrets Store is account-level, **not a per-tenant KMS**. "Agent-only access" in practice = application-level envelope encryption in the Worker with an externally-held wrapping key — **the Worker still sees plaintext at unwrap time, so Cloudflare stays inside the trust boundary.**
- **Scheduling** — Cron Triggers 250/account (Paid), 15 min max. Queues at-least-once w/ explicit delays, ~$0.40/M ops. **Workflows is GA: 50,000 concurrent instances/account, 25,000 steps/instance, 300 creates/sec, sleeping steps are FREE, $0.80/100k steps past 500k/mo.** Workflows is the right home for 10k nightly dream cycles — well under the concurrency ceiling even if all fire at once.
- **AI Gateway** — core (analytics, caching, rate limiting) free; **spend limits (June 2026) scope budgets per model/provider/custom metadata — e.g. a per-user-ID $/day cap — and work for both unified billing and BYOK.** Workers AI bills in Neurons ($0.011/1,000, 10,000/day free); BGE embeddings $0.012–$0.204 per M input tokens (bge-m3 cheapest).
- **MCP hosting** — Cloudflare's **Agents SDK supports MCP 2026-07-28 (stateless core) from day zero**; each request runs on a fresh stateless handler **with no session-tracking Durable Object**. `@cloudflare/workers-oauth-provider` handles the OAuth side for Claude Desktop/Code/ChatGPT.
- **Worker ceilings** — **128 MB memory, hard, not configurable**; CPU up to 5 min/request on Paid (30 s default); subrequests configurable to 10 M; bundle 10 MB compressed. Hyperdrive: ~100 pooled connections on Paid.

**Cost sketch** (assumes 2,000 pages/user, ~6,000 chunks @768 dims, ~100 MB D1/user, 50 MCP calls/day, one nightly Workflow of ~30 steps; LLM inference excluded):

| | 1 user | 1,000 users | 10,000 users |
|---|---|---|---|
| Workers | ~$5 (plan min) | ~$6 | ~$16 |
| D1 (storage-dominated) | ~$5 (plan min) | ~$5–10 | **~$750** (≈1 TB → at/over the default account cap) |
| Vectorize | ~$0 | ~$8 | ~$80 |
| R2 | ~$0 | ~$0.75 | ~$5 |
| Workflows | $0 | ~$5 | ~$70 |
| **CF subtotal** | **~$10–15/mo** | **~$25–35/mo** | **~$900–1,000/mo** |

LLM inference dominates at every tier — likely 10–100× the Cloudflare subtotal. Request volume
stays cheap because the free pools (25 B D1 reads, 30 M queried dims, 500k Workflow steps) absorb
growth; **storage is the only line that really moves.**

**What this substrate makes easy that container-per-user does not:** ms-scale API-driven
provisioning at signup; genuine idle-cost-zero on both compute and storage; automatic geo-placement
of each user's DO/D1; native stateless-MCP hosting with no session-affinity infrastructure; a
per-tenant LLM spend cap as a *platform feature*.

**The inverse — what you give up:** a real filesystem and real `git` (R2 is blobs; "brain repo as
files" must be reimplemented as R2 objects + a commit log, or run a git daemon in a Container); one
engine that does relational + vector + full-text together (three services glued in Worker code
instead of Postgres+pgvector+tsvector); arbitrary long-running daemons; and the 128 MB ceiling
rules out heavy in-process rerank/embedding batches.

**Disqualifiers to design around:** D1's 1 TB account cap is the number that threatens "thousands of
users" — plan the increase request or the DO fallback *before* it's an incident. Vectorize's missing
BM25 makes hybrid search a hand-built two-system RRF merge. R2's lack of SSE-C means true
keys-outside-Cloudflare custody isn't available at the storage layer. Containers are wrong for the
live MCP path (cold start + 15 min teardown grace) — keep them strictly on the batch/dream side.
And D1's informal ~200 writes/sec/DB ceiling means the "one shared D1 with a tenant_id column"
fallback is *worse* under load than per-user DBs — the limit reinforces the isolation design.

**Cross-domain analogy worth knowing.** **Plaid** is the closest structural match to "connect all
my accounts, never think about tokens again": an Aggregator Token layer dedupes redundant re-auth
when many apps link the same institution, refresh happens transparently before use, and granular
per-account scoping plus the **1033-rule revocation requirement** (delete data on disconnect
unless "reasonably necessary") maps directly onto Gmail/Drive/Calendar disconnect flows.
**Zapier/IFTTT galleries** work because each template is a two-endpoint, single-trigger →
single-action unit a non-technical user can preview before enabling; they decay into dead weight
when templates need multi-step config or drift against API versions.
