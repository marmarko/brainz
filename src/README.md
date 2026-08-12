# Source layout

One package, several entrypoints. Each directory is owned by specific
implementation units in the roadmap plan; the plan is the authority on scope.

| Directory | Owns | Units |
|---|---|---|
| `control/` | Control plane (content-free), tenant provisioning, secret store, schema/migration runner | U2, U3 |
| `ai/` | The single model gateway — routing by op, metering, pricing, key resolution. **No other directory imports a provider SDK.** | U20 |
| `core/` | Write path, retrieval stack, consolidation cycle, briefing assembly, media/OCR | U4, U5, U11, U12, U21 |
| `mcp/` | The MCP surface — tools, response envelope, OAuth grant lifecycle, shared dispatch | U6, U14 |
| `worker/` | Typed job runner, locking, dead-lettering, the scheduled fleets | U10 |
| `ingest/` | Chat-export and folder import, Pipedream connector substrate, first-import gate | U8, U9 |

## Two invariants that outlive any single unit

**Every model call goes through `ai/`.** Routing, metering, the spend cap and the
unpriced-model hard-fail all live in one module. A guard test asserts no
provider SDK is imported outside `src/ai/` — because a direct call is not a
style problem, it is unmetered spend that surfaces as a bill rather than an
error.

**Every tenant-scoped read derives its scope from authenticated context.** No
call site constructs a database key, an object-storage prefix, or a connection
from request input. One accessor per boundary, and the scope check lives below
the handlers so it cannot be forgotten at a call site.
