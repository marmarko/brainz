# U16 re-plan — isolation proofs, the register, and a fence that was a function of its caller

**Status:** execution plan for `### U16. Isolation proofs + register` in
`docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`. Milestone-grade, so
the roadmap's execution note asks for this document before any code. Written as
a sibling doc; the roadmap body is not edited.

**Requirements in scope:** R10 (the register and the attestation), with R9 and
R11 as the two properties the attestation is allowed to claim and the reason its
signing key may not live where the fleet can read it.

---

## 0. What changed between the roadmap and this plan

Three things the roadmap could not know:

1. **R9 settled.** `scripts/probes/r2-boundary/RESULT.md` closed the object-store
   question as *structural, conditional on correct prefix derivation, scoped to
   the mint modes actually verified*. The attestation therefore reports two
   boundaries with two different strengths, and the weaker one carries its
   condition in the value rather than in a footnote. That is already the shape
   `src/mcp/tools/meta.ts` ships (`storage_boundary:
   'structural_conditional_on_prefix_derivation'`); this unit keeps it and adds
   the facts underneath it.

2. **H6 is live, and the guard sweep is right about it.** U19's sweep carded
   `scripts/check-search-path.sh` as `unported`. It is not a paper hazard here:
   §1 below records the measurement, including a working bypass of R15's origin
   fence on the head schema. It lands in this unit because U16's whole claim is
   *the isolation story is externally checkable*, and an attestation that says
   `database_boundary: structural` while the in-database fence is a function of
   the caller's session state is exactly the receipt R10 warns about — one that
   keeps verifying after the property stops holding.

3. **`_meta` already carries an attestation, and it is unsigned.** The
   `brainz.app/brain` stamp shipped in U6 with `signature: 'unsigned'` and a
   comment deferring the signer to this unit. So U16 is not introducing the
   stamp; it is paying for the word `signature`.

---

## 1. H6 — measured before it is fixed

### 1.1 The severity question, answered from the catalog

The brief asks whether any of the eight trigger functions is `SECURITY DEFINER`,
because that is the fork between *privilege escalation* and *a correctness
hazard*. Measured against a database provisioned by the real applier at
`HEAD_SCHEMA_VERSION`:

| function | `prosecdef` | `proconfig` |
|---|---|---|
| `assert_commitment_origin_union` | `false` | `null` |
| `assert_edge_origin_union` | `false` | `null` |
| `assert_entity_card_origin_union` | `false` | `null` |
| `assert_fact_page_origin` | `false` | `null` |
| `assert_inverse_is_involutive` | `false` | `null` |
| `assert_origin_union` | `false` | `null` |
| `assert_report_origin_union` | `false` | `null` |
| `refuse_origin_change` | `false` | `null` |

**No function is `SECURITY DEFINER`.** So this is *not* privilege escalation:
there is no definer's-rights body a hostile `search_path` can aim at a
privileged role, which is the classic form of this bug. It is the milder
diagnosis of the two the brief names — and the milder diagnosis still has a
working exploit, which is why "only a correctness hazard" is the wrong place to
stop reading.

### 1.2 The exploit, on the head schema

R15's fence refuses a `fact` claiming `{personal}` when the `page` it was
extracted from is `work` — `assert_fact_page_origin` raises `BZ002`. It resolves
`page` unqualified, through the caller's `search_path`:

```
baseline (default search_path):     REFUSED BZ002
with search_path = shadow, public:  ADMITTED
the row a personal-fenced read now returns:
  [{"fact_id":"2","origin_contexts":["personal"],"page_origin":"work"}]
```

`shadow` is a schema holding an empty table named `page`. Three statements
(`CREATE SCHEMA`, `CREATE TABLE`, `SET search_path`) and the union check
inspects a table with no rows in it, finds no uncovered origin, and admits the
row. KTD5 fences reads on origin alone, so that row is now returned to a
personal-scoped grant carrying a work page's content.

`refuse_origin_change` looked immune — its body names no table, only
`to_jsonb`/`->` from `pg_catalog`, and `pg_catalog` is searched first when it is
not listed. It is not immune, because *listing* it demotes it:

```
baseline:                                    REFUSED BZ001
search_path = shadow, pg_catalog, public,
  with shadow.to_jsonb(anyelement) -> '{}':  ADMITTED
page.origin_context is now 'personal'
```

So **all eight are exploitable, and the reason to pin all eight is measured
rather than uniform-for-tidiness.**

### 1.3 Severity, stated

**A live bypass of R15's origin fence, reachable by anything that can issue SQL
as the tenant role — not privilege escalation, and not remotely reachable
through `/mcp`.** The tool surface issues no caller-controlled `SET`, so no
bearer or OAuth grant reaches this. What it costs is *defence in depth against
the request path itself*: the fence is the thing that is supposed to still hold
when the process parsing attacker-controlled mail is wrong, and today its
enforcement is a property of that process's session state. It is H4's class —
"the mechanism that enforces a property is itself unprotected" — and the
porting-hazards card already says so.

It is also a live-ammunition trap for ordinary work: a pooler, a future rung, or
any feature that creates a second schema silently disables the union fence with
no error and no failing test.

### 1.4 The fix, and the constraint that shapes it

The obvious fix is `ALTER FUNCTION … SET search_path`. It is unavailable:
`findExpandContractViolations` in `src/control/migrate.ts` admits only
`CREATE TABLE|INDEX|TYPE|DOMAIN|FUNCTION|TRIGGER|EXTENSION`, `COMMENT ON`,
`INSERT INTO` and additive `ALTER TABLE` actions. `ALTER FUNCTION` is rejected
as "not an additive statement", and `CREATE OR REPLACE FUNCTION` does not match
`/^CREATE FUNCTION\b/`. `src/control/` is out of scope for this unit, so the
rung is written to the rule rather than the rule to the rung.

**Rung 8 therefore expands rather than replaces.** For each of the eight
functions it creates a pinned twin, and for each of the eighteen triggers that
call one it creates a twin trigger calling the pinned function. Both fire; the
unpinned one can be fooled and the pinned one cannot, and a check that raises is
a check that raises, so the fence holds at the strength of its strongest arm.
This is the ordinary expand/contract shape the ladder already promises: the
contract rung that drops the unpinned originals is a later rung, gated on every
fleet instance having been replaced, and it needs the `migrate.ts` change below.

The pin is:

```sql
SET search_path = pg_catalog, public, pg_temp
```

Each of the three positions is load-bearing:

* `pg_catalog` **first and explicit** — the `refuse_origin_change` bypass in §1.2
  works by demoting it. Naming it first makes the demotion unavailable.
* `public` — the fence's own tables. Without it the functions do not resolve
  `page` at all.
* `pg_temp` **last and explicit** — this is the position most easily got wrong.
  When `pg_temp` is not listed, Postgres searches it *first* for relation names,
  ahead of `pg_catalog`. A pin of `pg_catalog, public` would leave the union
  checks defeatable by a `CREATE TEMP TABLE page`, which needs no `CREATE`
  privilege on any schema at all — a strictly cheaper attack than the one being
  fixed. The mutation for this is in §5.

### 1.5 Backfill story

**There is none, and that is the point.** Rung 8 adds functions and triggers. It
writes no column and backfills no value, so there is no row anywhere carrying a
value nobody observed. What the rung cannot do is retroactively re-check rows
admitted before it: a tenant that was exploited before rung 8 keeps the forged
row, and rung 8 does not claim otherwise. No production tenant is in that state
(the fleet is pre-beta and no tenant has ever executed a `SET search_path`), and
inventing a "verified clean" marker on that basis is exactly the unobserved
assertion the brief forbids. The re-verification of historical rows, if it is
ever wanted, is a sweep with its own receipt, not a column.

### 1.6 Guard

`src/schema/search-path.ts`, in the two-halves shape `origin-fence.ts` already
uses, because each half is blind to the other's failure:

* `findUnpinnedFunctionDeclarations(ddl)` — a static scan over the ladder's DDL.
  Every `CREATE FUNCTION` must carry a `SET search_path` clause. This is the
  half that stops a ninth function landing unpinned, and it runs with no
  database. The eight pre-rung-8 functions are named in a closed
  `SUPERSEDED_UNPINNED_FUNCTIONS` set — and an entry there is only accepted if
  the ladder also declares its pinned successor, so the set cannot be used to
  park a new unpinned function.
* `findUnpinnedFenceCoverage(sql)` — a catalog scan against a real tenant. Every
  origin column must carry an enabled trigger calling a **pinned** function, and
  every `public` trigger function outside the superseded set must have
  `search_path` in `proconfig`. This is the half that sees a pinned twin trigger
  that was dropped, disabled, or never created for a table added later.
* `assertSearchPathPinned(sql)` runs both.

A third, behavioural half lives in the test rather than the module: the §1.2
exploit, replayed against a rung-8 database, asserting `BZ002`/`BZ001` still
come back. A structural guard that passes while the exploit still works is the
failure mode this whole file is against.

### 1.7 What this unit cannot wire, with the patch written down

`assertSearchPathPinned` should run where `assertOriginFence` runs — inside
`migrateTenantSchema`, so every wake of a behind tenant and every provision
re-attests the pin. That is `src/control/migrate.ts`, out of scope. The patch,
for whoever owns that file next:

```ts
// src/control/migrate.ts — import beside the origin-fence import
import { SEARCH_PATH_PINNED_SINCE, assertSearchPathPinned } from '../schema/search-path.ts';

// …in migrateTenantSchema, immediately after the assertOriginFence call:
if (reached >= SEARCH_PATH_PINNED_SINCE) await assertSearchPathPinned(sql);
```

And, to make the contract rung expressible at all:

```ts
// src/control/migrate.ts — EXPAND_ONLY_STATEMENTS
  /^ALTER FUNCTION\b/i,   // SET search_path on an existing function is additive:
                          // the previous fleet release calls it identically.
```

Until both land, the guard is enforced by `bun test` only. Stated rather than
assumed: a guard that runs in CI and not on the request path is a guard against
*our* mistakes, not against a tampered tenant.

### 1.8 The hazard ledger

`docs/porting-hazards.md`'s H6 card and its skipped stub in
`test/hazards/swept.test.ts` are both generated from `src/upstream/hazard-map.ts`
by U19's sweep, and `test/upstream/sweep-freshness.test.ts` re-derives and
compares them. Flipping H6 to `guarded` means teaching the renderer that a swept
card can have been closed — a card cannot simply be deleted from `SWEPT_CARDS`,
because the ids are positional and H7…H15 would renumber under every existing
reference to them.

The change is additive and small: `SweptCardSpec` gains an optional
`guardedBy: string`, `SweptCard.status` widens to `'unported' | 'guarded'`,
`renderCards` prints the brainz guard path instead of "No brainz counterpart",
and `renderStubs` emits no stub for a guarded card. The disposition for
`scripts/check-search-path.sh` moves from `unported` to `guarded` naming
`src/schema/search-path.ts`. This unit makes that change, because a ledger that
denies a guard it ships is worse than no ledger.

---

## 2. The register

### 2.1 What "machine-readable" has to mean here

The roadmap asks for `docs/register.md`, machine-readable, so that *an outsider
can audit the blast radius without reading the source*. Those two clauses pull
in opposite directions if the artifact is a hand-written table: prose is what an
outsider reads, and prose is what drifts.

So the register follows the pattern this repo already has twice
(`hazard-map.ts` → `docs/porting-hazards.md`, `concepts.jsonl` → `ledger:check`):

* `src/register/components.ts` — the register **as data**, one entry per shared
  component, plus the renderer.
* `docs/register.md` — rendered from it, with a fenced JSON block carrying the
  same data verbatim so a machine reads the published artifact rather than the
  source it came from.
* A freshness test: re-render, compare, fail on drift.

### 2.2 What an entry carries

Per R10, each component names its blast radius and its rotation owner. The
fields:

| field | why it is here |
|---|---|
| `id`, `name`, `kind` | the component, and whether it is fleet / control plane / worker / vendor / credential / data |
| `shared_by` | `all_tenants`, `some_tenants`, `one_tenant` — the "more than one user" test, stated |
| `transmits_user_content` | R10's shorter list: the parties content actually reaches, which is not the model catalog |
| `blast_radius` | what an attacker holding it reaches |
| `rotation_owner`, `rotation` | who turns the key and how |
| `evidence` | the code that proves this component exists — the thing completeness is checked against |

Cloudflare gets its own entry rather than being invisible substrate: it is fleet
host, container platform and AI Gateway transport, which makes it the broadest
`>1-user` component in the system.

### 2.3 Completeness, enforced against the code and not against itself

The trap named in the brief is real and easy to fall into: a check that reads
`docs/register.md`, parses it, and asserts it contains what `components.ts` says
is a check that always passes. So completeness is asserted against three
**independently derived** evidence sets, none of which the register authors:

1. **Every external host the code can name.** A sweep for `https?://` literals
   across `src/**/*.ts`. Today that is eleven hosts across eight files —
   `gateway.ai.cloudflare.com`, `api.openai.com`,
   `generativelanguage.googleapis.com`, `api.pipedream.com`, `claude.ai`, the
   web app origin, and the Neon documentation links. Each must be classified in
   the register: a named component, or an explicit
   `not_a_destination` with a reason (documentation links are the reason that
   escape hatch exists, and each use of it is a row somebody wrote).
2. **Every provider a routing profile can reach.** `PROFILES` in
   `src/ai/routing.ts`, reduced to `Route.provider`. This is KTD13's "exactly two
   model-side processors" claim made checkable: adding a third provider row to a
   profile turns the register red before it turns the subprocessor list wrong.
3. **Every binding the fleet declares.** `wrangler.toml`'s Durable Object
   bindings and container classes — `MCP_FLEET`/`McpFleet`,
   `WORKER_FLEET`/`WorkerFleet` — because "the MCP fleet" and "the worker fleet"
   are register entries whose existence should be derived from the deployment
   surface rather than remembered.

Each derivation goes red when someone adds a shared component and does not name
it. That is the property; the doc is the artifact.

### 2.4 The signing key's entry

R10 is explicit that naming the signing key's blast radius is not containing it.
Its register entry records: custody (KMS or sign-only signer endpoint, never the
fleet's request-path secret store), the published verification key, the rotation
procedure, the revocation procedure, and — honestly — that no real KMS key
exists yet and the shipped signer is a port with a fake. §3.3 covers what that
does and does not prove.

---

## 3. The attestation

### 3.1 Payload

Extends what `attestation()` already returns rather than replacing it, because
`_meta`'s keys are frozen-additive:

```
tenant_id, issued_at,
project:  { id | null, id_source, endpoint_host }
database: { name }
storage:  { prefix | null, prefix_source }
boundaries: { database: 'structural',
              storage:  'structural_conditional_on_prefix_derivation' }
definitions_digest, instructions_release,
signature: { alg, key_id, value } | { status: 'unsigned', reason }
```

`counts` rides the `brain` tool's own body, not the signed payload: counts change
on every write, and a signature over a value that changes every write is a
signature nobody can cache, compare or replay-check.

**Every field is derived from something the fleet provably holds.** The database
name and endpoint host come from the tenant's own DSN, userinfo discarded before
anything is read. The storage prefix comes from `prefixFor` on an injected
prefix source. The Neon **project id is not resolvable from the request path** —
`TenantSecret` carries a connection string and a bearer and nothing else, and
the control-plane row that holds `neonProjectId` is not readable by the fleet
identity (R11, by design). So `project.id` is `null` with
`id_source: 'unresolved'` unless a fleet is wired to a resolver, and it is never
guessed from the endpoint host: Neon endpoint ids and project ids look similar
and are not the same identifier, and an attestation built on a naming
coincidence is a receipt that verifies until the day the coincidence stops.

### 3.2 Where it is produced

In `dispatch`, above the handlers, from the resolved secret — never in a handler.
`test/mcp/guards.test.ts` already refuses a handler that touches key material,
and the DSN is key material. Handlers receive the *derived facts*, which carry no
secret, and the `brain` tool renders what dispatch stamped.

### 3.3 The signing key, which is the reason the unit exists

An attestation signed by a key the fleet can read proves nothing an attacker who
owns the fleet could not forge. So:

* `AttestationSigner` is a **port** with two methods, `sign(payload)` and
  `verificationKey()`. It has no export, no `privateKey` accessor, and no way to
  round-trip to key bytes.
* The shipped implementation is a **fake** holding an HMAC key in a closure. No
  KMS key is provisioned and no cloud resource is created — the brief forbids it
  and an orphaned probe already cost this project eighteen buckets.
* The payload is **bound to a fixed shape**: the signer canonicalises and prefixes
  a domain-separation tag before signing, so a sign-only endpoint cannot be used
  as a general-purpose signing oracle for some other message.

What the test asserts, and what it cannot:

* **Asserted, and this is the load-bearing one.** A genuine export attempt runs
  through the same accessors a handler has — the `ToolContext`, the
  `DispatchDeps`, and the signer port itself — deep-walking every reachable value
  for the key bytes. The negative control is the mutation: a deliberately leaky
  signer that exposes the key must turn the test red, or the test is an absence
  property that passes because nothing tried.
* **Asserted.** The fleet's readable secret scope is `TenantSecretStore.resolve`,
  and what it returns is a two-field `TenantSecret`. A test pins that shape, so
  adding the attestation key to the store is a red test rather than a code review.
* **Asserted.** A signature over a *different* payload is rejected. A verifier
  that accepts any signature is the third trivially-passing test the brief names.
* **Not asserted, and recorded as such.** Nothing here proves a *deployed*
  container cannot read a *real* KMS key. That is a deployment property — an IAM
  policy granting `kms:Sign` and not `kms:GetPublicKey`-plus-export, or a signer
  service with no egress — and it belongs in the deployment checklist in §6, not
  in a green tick from `bun test`.

---

## 4. The canary tenant

`evals/isolation-canary.ts`, runnable by an outside party from published docs
with no credential of ours:

```
bun evals/isolation-canary.ts --endpoint https://<host>/mcp --token <their own>
```

Two halves:

* **The public known record.** A fixture page whose content is published in
  `docs/register.md`, so an outsider can ask the canary tenant for it and compare
  the answer to the published bytes. A canary whose expected answer is private is
  a canary only we can read.
* **The post-deploy path check.** Extensions (`vector`), GUCs (`hnsw.ef_search` —
  H1's truncation hazard), the vector indexes (H2), and the job queue. Each check
  reports `pass`, `fail`, or `deferred` with the reason it is deferred, and
  **`deferred` is never counted as `pass`**. With no `--endpoint` the whole run is
  `deferred`, exits non-zero, and says what deployment it needs — the discipline
  `evals/canary.ts` already uses for the model-judged tier.

`package.json` is out of scope for this unit, so the command is invoked by path
rather than by script name. The line to add when that file is next touched:

```json
    "probe:isolation": "bun run evals/isolation-canary.ts",
```

`evals/` is outside `tsconfig.json`'s `include`, so the module is pulled into the
typechecked program by its test importing it — the same way `evals/canary.ts` is.

---

## 5. Red first, then mutate

Every guard in this unit is written as a failing test before its implementation,
and then each guard is mutated in isolation and observed to die for the right
reason. The traps, and the mutation that proves each guard is not one of them:

| guard | mutation | must die because |
|---|---|---|
| rung 8 pin | pin `pg_catalog, public` (drop `pg_temp`) | `CREATE TEMP TABLE page` defeats the union check |
| rung 8 pin | pin `public, pg_catalog` (demote catalog) | `shadow.to_jsonb` defeats `refuse_origin_change` |
| twin triggers | drop one twin trigger from the rung | that table's fence is unpinned again |
| static scan | add an unpinned `CREATE FUNCTION` to the rung | a ninth function lands unguarded |
| catalog scan | disable a twin trigger in the database | a pinned function nothing calls |
| register completeness | add an unlisted `https://` host to a src file | a vendor nobody named |
| register completeness | add a fourth provider to a routing profile | a subprocessor nobody named |
| key custody | swap in a signer that exposes its key | the export attempt must find it |
| verifier | verify a signature against a mutated payload | a verifier that accepts anything |
| canary | make a `deferred` check count as `pass` | a green tick for having checked nothing |

Reverts are byte-exact rewrites verified by digest. `git checkout` is not used to
undo a mutation: it has twice made a surviving mutant report as killed.

---

## 6. What needs a deployment, a real KMS, or another owner

Listed here so no green tick is mistaken for one of them.

1. **A real KMS key or sign-only signer endpoint.** The shipped signer is a fake.
   Custody is recorded in the register with the rotation and revocation
   procedure; the key does not exist.
2. **The IAM policy that makes custody true.** "No fleet container can export it"
   is provable only against a deployed fleet and a real key policy. The test
   proves the *code* offers no export path.
3. **The canary tenant itself.** A provisioned tenant, its published record, and
   the nightly schedule. Until then the probe reports `deferred` and exits
   non-zero.
4. **`assertSearchPathPinned` on the request path**, and `ALTER FUNCTION` in the
   expand-only allowlist so the contract rung can drop the unpinned originals.
   Both are `src/control/migrate.ts`; the patch is in §1.7.
5. **The `probe:isolation` script line** in `package.json` (§4).
6. **The CI checklist item.** The register review must be a required check on
   every PR that adds a shared component. `.github/` is out of scope; the exact
   job is §7.

---

## 7. The CI checklist item, as YAML

Append this job to `.github/workflows/ci.yml`. It is separate from the unit test
job because it is the *review* gate rather than the correctness gate: the
completeness test in `bun test` catches a component the code names and the
register does not, and this catches a component whose register entry a human
must still sign off.

```yaml
  register-review:
    name: Register review (shared components)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      # The machine half: the register must name every shared component the code
      # names. Independent of docs/register.md's prose, by construction — it
      # derives its evidence from src/**/*.ts, routing profiles and wrangler.toml.
      - name: Register completeness
        run: bun test test/register/

      # The human half. A diff that touches a shared-component surface must also
      # touch the register, or say in the PR body why it does not. `git diff`
      # against the merge base rather than HEAD~1, so a rebase does not hide it.
      - name: Register review required on shared-component changes
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
        run: |
          set -euo pipefail
          CHANGED=$(git diff --name-only "${BASE}" HEAD)
          TOUCHES_SHARED=$(printf '%s\n' "$CHANGED" | grep -E \
            '^(src/ai/routing\.ts|src/ai/gateway\.ts|src/ingest/pipedream/|src/control/(storage|secrets|neon-api)\.ts|wrangler\.toml)' \
            || true)
          TOUCHES_REGISTER=$(printf '%s\n' "$CHANGED" | grep -E \
            '^(docs/register\.md|src/register/)' || true)
          if [ -n "$TOUCHES_SHARED" ] && [ -z "$TOUCHES_REGISTER" ]; then
            echo "::error::This PR changes a shared-component surface:"
            printf '  %s\n' $TOUCHES_SHARED
            echo "::error::but does not touch docs/register.md or src/register/."
            echo "Every component shared by more than one user is named in the"
            echo "register with its blast radius and rotation owner (R10). If this"
            echo "change genuinely adds no shared component, say so in the PR body"
            echo "and add the path to the allowlist in this job."
            exit 1
          fi
          echo "register review: no shared-component surface touched"
```

The checklist text for `.github/pull_request_template.md`, for whoever owns it:

```markdown
- [ ] **Register (R10).** If this PR adds or changes a component shared by more
      than one user — a vendor, a model provider, a fleet, a queue, a credential
      — `docs/register.md` names it with its blast radius and rotation owner.
```

---

## 7a. What execution changed about this plan

Recorded here rather than by editing the sections above, so the plan stays a
plan and the corrections stay attributable.

1. **The canary needs two database URLs, not one** (§4). `control.job` is in the
   control plane, and KTD1 gives every tenant a database of its own — so the
   queue check takes `--control-database-url` and the tenant checks take
   `--database-url`. `docs/register.md` carries the current invocation.
2. **The `ef_search` check was aimed at the wrong property.** The plan inherited
   "is it raised above 40" from H1's card. brainz never relies on the default —
   `withVectorScan` sets it per transaction — so what can silently be wrong is
   whether the setting is *registered*, since Postgres accepts any prefixed
   custom GUC and a `SET LOCAL` on an unloaded pgvector succeeds and does
   nothing.
3. **Two boundary guards fired on the new code and both were right** (not
   anticipated in §5's mutation table): the storage accessor's de-branding rule
   and the gateway's endpoint-marker rule. Both now carry narrowed exemptions
   with reasons, and the gateway exemption is held to a stricter rule than the
   one it is excused from — the register may name an endpoint and a test asserts
   it cannot reach one.
4. **The `pg_catalog`-demotion mutation initially survived** (§5), because the
   first version of that test put its shadow in a schema the pin excluded. With
   a pin in place the only reachable shadow is `public`, which the tenant role
   owns — so that is the adversary the test now uses.
5. **The hazard-ledger flip was made** (§1.8), and needed the `ported`
   disposition kind described there.

## 8. Order of work

1. This document.
2. H6: failing tests, observe red; rung 8; guard; mutations; ledger card flip.
3. Register: data, renderer, three completeness derivations, doc.
4. Attestation: signer port, fake, verifier, dispatch wiring, `brain` body.
5. Canary probe and its published invocation.
6. `bun run typecheck`, `bun test`, `bun run ledger:check`, `bun run eval:blocking`.
