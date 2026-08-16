# Source layout

One package, several entrypoints. Each directory is owned by specific
implementation units in the roadmap plan; the plan is the authority on scope.

| Directory | Owns | Units |
|---|---|---|
| `control/` | Control plane (content-free), tenant provisioning, secret store, the migration runner that moves a tenant along the schema ladder and the ports the fleet's scheduled sweep runs it through. It also holds U15's half: the **identity** schema and its accessors — a second database, separate from the content-free control plane, so that plane's claim stays literally true of the database the register names — the webhook verifier that is the only thing allowed to move a tenant's tier, the seam the consolidation cycle reads that tier through, and the warm pool | U2, U3, U15 |
| `schema/` | The per-tenant schema as an ordered ladder of rungs, the applier that provisioning calls, and the one vector-query helper every read goes through | U3 |
| `ai/` | The single model gateway — routing by op, metering, pricing, key resolution. **No other directory imports a provider SDK.** | U20 |
| `core/` | Write path, retrieval stack, consolidation cycle, briefing assembly, media/OCR | U4, U5, U11, U12, U21 |
| `mcp/` | The MCP surface — tools, response envelope, OAuth grant lifecycle, shared dispatch | U6, U14 |
| `worker/` | Typed job runner, locking, dead-lettering, the scheduled fleets | U10 |
| `ingest/` | Chat-export and folder import, Pipedream connector substrate, first-import gate | U8, U9 |
| `web/` | The web app — signup, sessions, subscription, connectors, spend, BYOK entry, the guided connect flow, and the `/admin` scope table. It holds the identity database, the control plane, and a **write-only** port for tenant provider keys; it holds no secret store, no tenant connection and no model gateway, because R11 is a claim about capability rather than intent. Filed here rather than under `apps/` because `tsconfig.json` covers `src`, `test` and `scripts`, and code that is neither typechecked nor scanned by the guards is worse than a differently-named directory. | U15 |
| `register/` | R10's register as **data**, the renderer that publishes `docs/register.md` as a table for a person and a JSON block for a machine, and the completeness check that holds it to three evidence sets the register does not author — every `http(s)://` host named under `src/`, every provider a routing profile can reach, and every binding `wrangler.toml` declares. A register checked against its own rendering is complete by construction and can still be wrong in fact, which is the failure R10 exists against; adding a vendor turns it red instead. Both directions are failures, so an entry naming a vendor the code no longer calls is a finding too. What no sweep can reach — a credential with no host literal, a party contacted only inbound — is named by hand and asserted by name in `test/register/completeness.test.ts`. | U16 |

**The tenant schema is a ladder, and rungs are append-only.** `schema/tenant.sql` is rung one
and `schema/migrations/` holds the rest; `schema/migrations.ts` is the ordered list.
Provisioning and upgrading run the *same* rungs in the same order, so there is no
provisioning-only DDL path for the migration tests to miss. Every rung must be additive — no
`DROP`, no `RENAME`, no `NOT NULL` without a `DEFAULT` — because during a rolling deploy the
previous release is still serving tenants a newer instance has already migrated. That is
enforced twice: `findExpandContractViolations` scans each rung, and `test/schema/rollout.test.ts`
runs the previous release's own frozen statements against a migrated database.

**And nothing serves a tenant at a rung it does not understand.** The two halves of that
live outside `control/`, which is why they are stated here: `mcp/dispatch.ts` asserts a
servable schema — off the version the connection accessor caches on its entry, so a warm
request pays nothing for it — before the fence is derived or any handler runs, and
`worker/scheduler.ts`'s tick sweeps tenants behind the head through
`control/schema-sweep.ts`, bounded, warmest first, ahead of enqueueing work that would fail.

## Two invariants that outlive any single unit

**Every model call goes through `ai/`.** Routing, metering, the spend cap and the
unpriced-model hard-fail all live in one module. This is enforced rather than
agreed: `test/ai/boundary.test.ts` scans every file under `src/` and fails on a
provider SDK import, a model-endpoint literal, a raw `@cf/…` model id and a
direct platform AI binding outside `src/ai/` — because a direct call is not a
style problem, it is unmetered spend that surfaces as a bill rather than an
error. `test/ai/price-drift.test.ts` holds the other half: `src/ai/pricing.ts`
is the only file under `src/` that may contain a price.

**Every tenant-scoped read derives its scope from authenticated context.** No
call site constructs a database key, an object-storage prefix, or a connection
from request input. One accessor per boundary, and the scope check lives below
the handlers so it cannot be forgotten at a call site. For object storage this
is enforced rather than agreed: `test/control/accessor-boundary.test.ts` scans
every file under `src/` and fails on a cast to the branded prefix and key types,
on a second copy of the prefix layout, and on any use of the de-branded
`storage_prefix` outside the module that records it. Until a module derives
something it should not, the invariant is held by that scan and not by there
being little code.
