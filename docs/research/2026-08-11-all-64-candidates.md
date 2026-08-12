# Raw candidates (condensed checkpoint) — 64 ideas, 7 axes

Condensed to title + axis + basis-type + one-line gist. Full bodies are in the orchestrator
transcript; this protects the selection work against context compaction.

## Agent 1 — Pain & friction (sonnet)
1. Connector Broker — kill file/git-only ingestion; self-hosted broker owns OAuth tokens. `onboarding` `direct:sources.ts:9-12`
2. The connector click IS the install — adding the MCP connector provisions the brain; README's "deploy another agent first" is a bootstrapping paradox. `onboarding` `direct:README.md:78-94`
3. Isolation you can prove with a network diagram, not a WHERE clause — DB-per-tenant. `isolation` `direct:SECURITY.md:163-173`
4. Encrypted so even we can't read it at rest — envelope encryption, key from user's session. `isolation` `direct:user constraint + R2 no-SSE-C`
5. A container that sleeps 23h to run once a day is the anti-pattern — entrypoint.sh's dream role is literally `while :; sleep; done`. `runtime` `direct:entrypoint.sh:97-121`
6. A second, un-bypassable meter — per-tenant spend cap at the AI gateway, not in app code. `runtime` `external:$50.71 incident + CF AI Gateway spend limits`
7. A tool surface we never have to re-publish — freeze at 7 (5 verbs + search/fetch). `mcp` `external:ChatGPT Work approval-time freeze`
8. A briefing nobody reads isn't a briefing — reports skill has NO push step, pull-only. `recipes` `direct:skills/reports/SKILL.md:1-59`

## Agent 2 — Inversion / removal / automation (sonnet)
9. System owns the repo lifecycle — the git-init consent boundary is scoped to `--path`, invert it for hosted. `onboarding` `direct:sources-ops.ts:337-348`
10. Delete the picker triad — zero setup questions on hosted; promote `search tune --apply` to automatic. `onboarding` `direct:init*.ts pickers`
11. The first briefing IS "setup complete" — delete the confirmation screen. `recipes` `direct:README.md:26-62`
12. Physical per-tenant isolation deletes the RLS question. `isolation` `direct:SECURITY.md:163-173` (dupe of #3)
13. Sources push, the brain wakes — delete the 300s poll loop. `runtime` `direct:autopilot.ts:390`
14. Move session state out of the request path so MCP can scale to zero. `runtime` `direct:deploy README reasoning`
15. One contract, zero hand-maintained tool surfaces — generate ChatGPT's search/fetch shape from operations.ts. `mcp` `direct:CLAUDE.md contract-first`
16. The brain proposes your recipes — reuse advisor's 9 collectors to pre-slot cron jobs. `recipes` `direct:advisor/run.ts:21-32`

## Agent 3 — Leverage & compounding (sonnet)
17. Recipes-not-code connectors riding the existing skillpack registry. `onboarding` `direct:registry-client.ts:1-18`
18. Physical per-tenant provisioning as the trust primitive every feature inherits. `isolation` (dupe of #3/#12)
19. One envelope-encryption primitive reused by every data-touching feature. `isolation` (dupe of #4)
20. Per-user Workflow instances retire the always-on autopilot loop. `runtime` (dupe of #5/#13)
21. **The dream cycle's compaction ratio IS the brain-aging cost curve** — 146,646 pages : 24,585 people ≈ 6:1. `runtime` `reasoned: + README scale proof`
22. The frozen five-verb surface as a protocol, not a feature flag — conformance certifier already exists. `mcp` `direct:MEMORY_VERBS_v1.md:1-49`
23. Schema packs on the registry — user #50's domain modeling becomes user #1000's zero-config default. `recipes` `direct:schema-packs.md + registry-client.ts`
24. One core, two businesses — hosted is a 4th caller of operations.ts, not a fork. `recipes` `direct:CLAUDE.md contract-first`

## Agent 4 — Cross-domain analogy (opus)
25. **Copy cataloging** — public entity authority file (LC 1901 / OCLC / MARC bib-vs-holdings split); shared bibliographic record, per-user holdings. `onboarding` `external:LC/OCLC/MARC`
26. **Safe-deposit split custody** — two-vendor key split + Certificate-Transparency-style Merkle unwrap log, witnessed by self-hosters. `isolation` `reasoned:vault dual-custody + RFC 6962`
27. **Hull penetrations register** — publish the machine-readable list of every component touching >1 brain (Vectorize namespaces are the un-sealed one). `isolation` `direct:CF namespace evidence + operations.ts:794`
28. **Sleep, not dreaming** — synaptic downscaling (net-subtractive), sleep pressure, ultradian staging, targeted memory reactivation cued by the day's MCP queries. `runtime` `external:Tononi&Cirelli SHY; Rasch et al. 2007`
29. **Standing orders with refills** — recipes as prescriptions: formulary tier, prior auth, finite refills, dispenser that can refuse. `runtime` `direct:budget-tracker.ts:310-316`
30. **Offline hotel key cards** — epoch-per-client-class in the token, held in the per-user DO; revocation = one integer, zero lookups. `mcp` `direct:mcp/dispatch.ts:1-7`
31. **The MEL (aviation minimum equipment list)** — every response carries the inoperative list + repair category + compensating procedure. `mcp` `direct:operations.ts:4573 search_degraded + :416-435`
32. **Press time** — the brain prints a morning edition during the cheap sleep window; MCP is the newsstand, not the newsroom. `recipes` `reasoned:newspaper mapping`

## Agent 5 — Assumption-breaking (A) + constraint-flipping (B) (opus)
33. A1 Brain-in-a-box — unmodified gbrain as the batch kernel in a Container; rewrite only the read path. `runtime` `direct:entrypoint.sh:11`
34. A2 BYOC — the user's existing client already has Gmail/Drive connectors; we hold zero Google tokens. `onboarding` `direct:CASA constraint + verbs.ts:54-55`
35. A3 The index is a cache, not a prerequisite — `search_degraded` as the cold-start contract. `onboarding` `direct:MEMORY_VERBS recall signature`
36. A4 **The isolation unit is the connected account, not the person** — brain = federation grant across per-account DBs. `isolation` `direct:operations.ts:510-522`
37. A5 Files without git — encrypted content-addressed object log + signed commit log; unwrap receipts. `isolation` `direct:R2 no-SSE-C + entrypoint.sh:39-56`
38. A6 Dreaming is debt repayment, not a bedtime — DO alarm fires on consolidation debt. `runtime` `direct:briefing/SKILL.md:47-49 pending_consolidation_count`
39. A7 Freeze seven tools; everything else ships as MCP **resources**. `mcp` `direct:verbs.ts:5-14 + functional-area-resolver receipts`
40. A8 Open-source the protocol + conformance suite, not the server. `recipes` `direct:verbs.ts:29 + Zep precedent`
41. B1 **Zero-LLM briefings** — briefing skill's declared tools are ALL read ops; the client's model writes the prose. `recipes` `direct:briefing/SKILL.md:8-14`
42. B2 Standing questions as materialized views — citations become invalidation edges. `recipes` `direct:briefing/SKILL.md:26`
43. B3 **Brains are files: R2-cold, D1-hot** — hydrate on demand; $0.75/GB vs $0.015/GB is a 50× spread. `runtime` `reasoned:CF cost sketch`
44. B4 The deterministic sleep tier — a free brain that never calls an LLM. `runtime` `direct:advisor/run.ts:21-32`
45. B5 Latency class + budget-by-caller from the request envelope. `mcp` `direct:entity p99<100ms vs synthesize EXPENSIVE`
46. B6 **Two planes** — index plane never holds plaintext; ChatGPT's search/fetch split becomes the security architecture. `isolation` `direct:SECURITY.md:165-168`
47. B7 `prove_isolation` — signed attestation + public canary tenant a hostile auditor can test. `isolation` `direct:SECURITY.md:165-166 + advisor exit codes`
48. B8 Zero-auth onboarding — per-user ingest email address + calendar seat; no OAuth, no CASA. `onboarding` `direct:CASA gate + verbs.ts:50-56`

## Agent 6 — Recovery: durability (sonnet)
49. Two-tier durability — files get real backup; DB gets platform PITR or rebuild-from-files. `db_only` tier is the named exception. `durability` `direct:storage-config.ts:362-363 + export.ts:73-99`
50. **Export folder = the native self-host input format** — export.ts already writes slug-nested .md; that IS `sources add --path`. `durability` `direct:export.ts:110-126`
51. Export is a privileged, narrow, audited action — highest-blast-radius op in the system. `durability` `direct:SECURITY.md + localOnly precedent`
52. Lost-key recovery: pick escrow-vs-recovery-phrase explicitly and disclose loudly. `durability` `direct:CF no per-tenant KMS`
53. Deletion proof via the platform's PITR ceiling as a hard SLA + deletion certificate. `durability` `direct:D1 Time Travel 30d vs forget() never-deletes`
54. Cost-gate backup retention with the BudgetTracker pattern. `durability` `direct:budget-tracker.ts`
55. Scheduled self-export to a user-owned destination — dead-man's switch vs company shutdown; 10th advisor collector. `durability` `external:Rewind/Limitless Dec 2025`
56. Portability-parity as a CI-gated round-trip test, like engine-parity. `durability` `direct:CLAUDE.md engine-parity invariant`

## Agent 7 — Recovery: upstream (opus)
57. Contract-as-data + a coverage ledger that goes red on drift (`implemented`/`omitted(reason,revisit_by)`/`not_yet`). `upstream` `direct:operations.ts:969-1015`
58. **Be a certified second implementation** — conformance runner needs only `listTools()`+`callTool()`; non-strict on extra fields by design. `upstream` `direct:verbs/conformance.ts:18-21, :10-12`
59. **Upstream as compiler** — run real gbrain unmodified on the batch plane; reimplement only the 5-verb hot path (~4% of the contract). `upstream` `direct:surface.ts:56 + CF containers-are-batch-only`
60. **`gbrain-data`** — schema packs, pricing, skills, recipes, glossary, migrations on their own tzdata-style release clock. `upstream` `direct:pack-upgrade-mechanism.md:8-17, :105-113`
61. **A hazard pack** — every incident becomes a portable failing test against the MCP surface + a fault interface; needs a synthetic golden-brain corpus. `upstream` `direct:incident + CLAUDE.md "CI is the enforcement, not this prose"`
62. Normative-clause IDs — MUST/SHOULD clauses get stable IDs; CI fails when one has no conformance case. `upstream` `direct:CLAUDE.md current-state-only rule`
63. Pay upstream in evidence — fleet metric receipts in gbrain's existing eval receipt schema; no content, no user data. `upstream` `direct:evals/functional-area-resolver/README.md:69-71, :3-8`
64. One registry, two consumers — adopt `gbrain-registry-v1` verbatim; PR a `requires_capabilities` field upstream. `upstream` `direct:registry-schema.ts:15-18, :42-47`

## Heavy dedupe clusters (collapse before ranking)
- **Physical per-tenant isolation:** 3, 12, 18 → one idea
- **Frozen minimal tool surface:** 7, 39, 22 → one idea (39 is strongest: tools frozen, capability ships as *resources*)
- **Envelope encryption:** 4, 19, 37 → one idea (37 is strongest: adds the receipt log + kills git)
- **Scale-to-zero runtime:** 5, 13, 14, 20 → one idea; 38 (debt-triggered) and 43 (R2-cold) are genuinely distinct
- **Connector strategy:** 1, 17, 34, 48 → 34+48 are the real fork (borrow the client's connectors / zero-auth address) vs 1+17 (build our own)
- **Briefing delivery:** 8, 11, 32, 41, 42 → 32 (press time) + 41 (zero-LLM) are the load-bearing pair

## Cross-cutting combinations worth surfacing
- **32 + 41 + 42** — press time + zero-LLM + standing-question invalidation = the whole briefing architecture, and it deletes the largest hosted cost line.
- **46 + 37 + 27** — two planes + content-addressed encrypted log + published penetration register = an isolation story that is structural, not policy.
- **59 + 33 + 60** — upstream-as-compiler + brain-in-a-box + gbrain-data = "we rewrite 4% and inherit the rest," the direct answer to the upstream constraint.
- **50 + 55 + 56** — export-is-the-self-host-format + scheduled self-export + CI parity test = "you can leave" as a tested guarantee.
- **28 + 38 + 21** — sleep-not-dreaming (subtractive) + debt-triggered alarms + compaction ratio = the cost curve bends down as a brain ages.
- **36 + 30** — per-account isolation unit + per-client-class epochs = revocation and work/personal separation fall out of one design.
- **26 + 47 + 63** — split custody + prove_isolation canary + evidence-back-upstream = self-hosters become the auditors of the hosted service.
