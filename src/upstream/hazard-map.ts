/**
 * The guard decision table — one entry per `scripts/check-*` file gbrain ships.
 *
 * `docs/porting-hazards.md` says the honest thing about porting: *"None of that
 * ports as code — brainz is a different codebase on a different substrate — but
 * the failure mechanisms do."* Deciding whether a mechanism can fire here is a
 * judgement, and judgements are not automatable. So this table is written by
 * hand and the machine's job is **completeness**: `hazard-sweep.ts` asserts that
 * the table and the upstream checkout still agree in both directions, and a
 * guard upstream adds with no entry here fails the build.
 *
 * That inversion is the point of the unit. Before it, "gbrain has 39 guards" was
 * a sentence in a document. After it, a guard upstream writes next week is a red
 * test until somebody says what it means here.
 *
 * **Five dispositions, and what each one claims:**
 *
 *   - `carded`     — an existing H-card in `docs/porting-hazards.md` already
 *                    describes this mechanism.
 *   - `guarded`    — brainz has its own guard, named as a path. The path is
 *                    checked to exist, the same evidence rule the ledger applies
 *                    to a `covered` row: a hazard closed by citing a file nobody
 *                    wrote is the failure this unit is against.
 *   - `not-applicable` — the mechanism cannot fire on this substrate, with the
 *                    reason. Where the reason is a checkable property of this
 *                    repo, it carries a `precondition` so the claim expires when
 *                    the property stops holding rather than when somebody
 *                    remembers.
 *   - `unported`   — applicable, nothing here would catch it. Emits a card, and
 *                    with it a skipped test whose reason string prints on every
 *                    run.
 *   - `ported`     — it *was* `unported`, its card exists and keeps its number,
 *                    and brainz has since written the guard. Emits the same card
 *                    with `**Status:** \`guarded\`` and no skipped stub. This
 *                    kind exists because card ids are positional: deleting a
 *                    closed card would renumber every card after it, silently
 *                    invalidating every reference to `H7`…`H15` in the tree. A
 *                    hazard that was inherited and then closed is a different
 *                    fact from a hazard that never applied, and it counts toward
 *                    `guarded` rather than toward `unported` — the unguarded
 *                    count is the number this unit exists to report, and a
 *                    closed hazard still inside it is the count lying.
 *   - `data`       — not a guard: a fixture or allowlist the guard reads.
 *
 * Each `unported` entry carries a verbatim `quote` from the upstream guard's own
 * header at the pinned commit. Upstream's words are attributed; brainz's half of
 * the card is authored below. The quote is not decoration — `hazard-sweep`'s
 * freshness test reads the guard at the pin and fails if the quote is no longer
 * there, so a card cannot keep quoting a rationale upstream has rewritten.
 */

export type Disposition =
  | { readonly kind: 'carded'; readonly card: string; readonly note: string }
  | { readonly kind: 'guarded'; readonly guard: string; readonly note: string }
  | { readonly kind: 'not-applicable'; readonly note: string; readonly precondition?: string }
  | { readonly kind: 'unported'; readonly card: string; readonly quote: string }
  | {
      readonly kind: 'ported';
      readonly card: string;
      readonly quote: string;
      /** The brainz guard that closed it. Checked to exist, like `guarded`. */
      readonly guard: string;
    }
  | { readonly kind: 'data'; readonly note: string };

/**
 * The cards the sweep emits, in the order that fixes their `H<n>` numbers.
 *
 * Numbering continues after the hand-written H1–H4 and is positional rather than
 * derived from a filename, so inserting a card renumbers deterministically and a
 * re-render is a no-op. Several upstream guards can share one card where they
 * guard one mechanism from different angles — six privacy scanners are one
 * hazard, not six.
 */
export interface SweptCardSpec {
  readonly key: string;
  readonly title: string;
  /** Why it did not show up in development. The field H1–H4 all carry. */
  readonly masked: string;
  /** What the mechanism becomes on this substrate. Authored, never derived. */
  readonly analog: string;
  /** The shape of the guard that would catch it here. */
  readonly guard: string;
  readonly related?: string;
}

export const SWEPT_CARDS: readonly SweptCardSpec[] = [
  {
    key: 'privacy-scanners',
    title: 'A real person reaching a public artifact',
    masked:
      'Nothing fails. A fixture naming a real contact, a proposal quoting a real thread, a synthetic ' +
      'corpus that memorised a real structure — all of them compile, pass, and ship. The signal arrives ' +
      'from outside the repo, if at all, after the artifact is public and indexed.',
    analog:
      'Sharper here than upstream, because upstream guards a knowledge tool whose fixtures its author ' +
      'wrote, and brainz holds strangers’ mail. Every fixture, every committed eval receipt, every ' +
      'quoted example in `docs/`, and every error string that might carry a subject line is the same ' +
      'surface. `imp.privacy-scanners` records the gap in the concepts ledger and is still `not-yet`.',
    guard:
      'A scan over committed artifacts for the shapes upstream names — address, phone, bearer, ' +
      'Luhn-valid card, private path prefixes — plus an exact-string blocklist for identifiers a ' +
      'reviewer has flagged. Shape regexes over an allowlist, because a broad corporate-email regex ' +
      'catches legitimate fixture domains and gets switched off.',
  },
  {
    key: 'unpinned-search-path',
    title: 'A trigger function resolving through the caller’s search_path',
    masked:
      'Every test passes: in a database with one schema there is nothing to shadow, so an unqualified ' +
      'reference resolves to the object the author meant. The failure needs a second same-named object ' +
      'in a schema the caller can reach, which no fixture creates.',
    analog:
      'It fired. brainz’s tenant schema defined **eight** trigger functions across ' +
      '`src/schema/migrations/v2-knowledge-core.sql` and `v3-consolidation.sql` and pinned `search_path` ' +
      'on none of them, and seven of the eight are R15’s origin fence — `refuse_origin_change`, ' +
      '`assert_origin_union`, `assert_fact_page_origin`, `assert_edge_origin_union` and their siblings. ' +
      'None was `SECURITY DEFINER` (`prosecdef` false on all eight), so this was never the ' +
      'privilege-escalation form; it was a **working bypass of the fence**. A schema holding an empty ' +
      'table named `page`, placed in front of `public`, made `assert_fact_page_origin` inspect the wrong ' +
      'table and admit a `fact` claiming `{personal}` extracted from a `work` page — and KTD5 fences ' +
      'reads on origin alone, so that row then reads out to a personal-scoped grant. ' +
      '`refuse_origin_change` names no table and fell too, by listing `pg_catalog` *late* and shadowing ' +
      '`to_jsonb`. A fence that resolves its own references through the calling session is a fence whose ' +
      'enforcement is a function of the caller.',
    guard:
      'Rung 8 (`src/schema/migrations/v8-search-path-pinned.sql`) pins ' +
      '`pg_catalog, public, pg_temp` — `pg_temp` named **last** because an unlisted one is searched ' +
      'first for relation names, which would leave every union check defeatable by a temp table. It ' +
      'expands rather than rewrites, because `ALTER FUNCTION` is not an expand-only statement: each ' +
      'function gets a pinned twin and each trigger a twin trigger, so the unpinned arm can be fooled ' +
      'and the pinned arm cannot. `src/schema/search-path.ts` guards it in two halves — a ladder scan ' +
      'so a ninth function cannot land unpinned, and a catalog scan that sees a twin dropped, disabled, ' +
      'or never written for a later table. The three bypasses above are replayed in ' +
      '`test/schema/search-path.test.ts`, because a structural guard that passes while the exploit works ' +
      'is this card’s own failure mode.',
    related: 'H4 — both are cases where the mechanism that enforces a property is itself unprotected.',
  },
  {
    key: 'credential-in-a-log-or-payload',
    title: 'A connection string or a secret leaving through a log line or a serializer',
    masked:
      'The leak is in the *error* path and the *debug* path, which is where fixtures are thinnest. A ' +
      'redaction helper that exists and is called at four of five sites tests identically to one called ' +
      'at five, because the fifth is the path that only runs when something has already gone wrong.',
    analog:
      'Direct. The control plane stores `connection_secret_ref` and `bearer_secret_ref` rather than the ' +
      'values, precisely so this cannot happen there — but the request path resolves both, and any ' +
      'exception body, structured log, or `_meta` block that serialises a config object it did not ' +
      'redact carries a per-tenant credential out. `src/control/schema.sql`’s alphabets stop the ' +
      'control plane from *storing* one; nothing stops a handler from *printing* one.',
    guard:
      'A source scan, in the shape `test/ai/boundary.test.ts` already uses for the gateway boundary: no ' +
      'module may pass a value derived from the secret store, or a whole config object, to a logging ' +
      'surface or a serializer without a named redaction call in between.',
  },
  {
    key: 'jsonb-double-encode',
    title: 'A structured value encoded twice on its way into the database',
    masked:
      'The dev engine. Upstream’s embedded Postgres accepted the double-encoded form and read it back ' +
      'as the caller expected; the real engine stored a JSON string scalar. Every local test passed and ' +
      'every sync against the real database aborted. `docs/porting-hazards.md` already names this class ' +
      'under "Candidates for the next pass" as *dev engine masks remote engine*.',
    analog:
      'Not the same bug — brainz has no JSONB column and one engine — but the same *shape*, and it has ' +
      'already bitten once here: `src/core/write/pg-values.ts` exists because Bun’s SQL template ' +
      'spreads a JavaScript array into a value list, so binding `[’personal’]` against a ' +
      '`text[]` column sends a bare string. That module’s own header reaches the same conclusion as ' +
      'upstream’s JSONB rule: bind as text and let the cast parse it, because the driver’s ' +
      'handling is not the one the column wants. The generalisation is unguarded — any future column ' +
      'whose driver encoding differs from its Postgres type is the same hazard.',
    guard:
      'A scan asserting that every `::text[]`, `::jsonb` or array-typed bind goes through a named ' +
      'serializer rather than an inline literal, plus a round-trip test per such column that reads the ' +
      'value back through SQL and compares it to what was written — the half a type signature cannot do.',
  },
  {
    key: 'hook-budget',
    title: 'A test hook that times out before the work it sets up can finish',
    masked:
      'Nothing, on a fast machine. The hook that provisions a schema finishes inside the default budget ' +
      'locally and misses it on a loaded CI runner, so the failure is a flake attributed to the test ' +
      'rather than to the budget — and per-test timeouts are not inherited by hooks, so a file whose ' +
      'tests all declare a generous timeout still runs its `beforeAll` against the default.',
    analog:
      'Direct and load-bearing. brainz’s database-backed suites do their expensive work in ' +
      '`beforeAll`: `test/schema/fixture.ts`, `test/worker/fixture.ts`, `test/hazards/fixture.ts` and ' +
      '`test/ai/fixture.ts` each provision a throwaway database and apply DDL before a single assertion ' +
      'runs. Those are exactly the hooks the default budget is sized wrong for.',
    guard:
      'A check that every `bun test` invocation in CI configuration and runner scripts passes an ' +
      'explicit `--timeout`, so the budget is a number somebody chose rather than a default nobody saw.',
  },
  {
    key: 'retry-amplification',
    title: 'Two retry ladders multiplying into one',
    masked:
      'Both layers are correct in isolation and both are tested in isolation. The product only appears ' +
      'under sustained failure, which is the one condition a green suite never reproduces — and it ' +
      'appears as extra load on a service that is already degraded, which reads as the incident rather ' +
      'than as a contributor to it.',
    analog:
      'Two ladders exist already. `control.job` carries `max_attempts` with backoff, and the model ' +
      'gateway has its own provider-level retry; a handler that retries a gateway call inside a job ' +
      'attempt multiplies them. Worse here than upstream, because the amplified unit is a paid model ' +
      'call against a per-tenant spend cap, not a database write.',
    guard:
      'A scan asserting no call site wraps a self-retrying primitive in a second retry, plus a test that ' +
      'counts provider invocations across one failing job attempt and pins the number.',
  },
  {
    key: 'non-protocol-bytes',
    title: 'Non-protocol bytes on the channel a client is parsing',
    masked:
      'Interactive use. A human reading a terminal sees progress output and a result; a parser sees one ' +
      'malformed stream. The bytes are written by code whose job is to be helpful, so the surface that ' +
      'breaks is never the surface being tested.',
    analog:
      'Named already in `docs/porting-hazards.md` under "Candidates for the next pass" as *non-protocol ' +
      'bytes on the MCP stdio stream*; this card is that candidate written up. brainz serves MCP over ' +
      'HTTP rather than stdio, which moves the surface rather than removing it: anything written outside ' +
      'the envelope — a stray `console.log` in a handler, a warning from a library, a progress line — ' +
      'lands in the response body a client is parsing as JSON-RPC.',
    guard:
      'A scan for writes to stdout from any module reachable from the request path, and a server-level ' +
      'test asserting the response body parses as exactly one JSON-RPC message with no leading or ' +
      'trailing bytes.',
  },
  {
    key: 'shared-process-test-leakage',
    title: 'Module-level state leaking between test files in one process',
    masked:
      'File-at-a-time runs. Every file passes alone; the leak needs the parallel runner that loads ' +
      'several files into one process, and it surfaces as a flake in a file that did not cause it. The ' +
      'test most likely to be blamed is the one least likely to be at fault.',
    analog:
      'brainz mutates process-level state in tests by construction: `DATABASE_URL`, the pace and spend ' +
      'environment knobs, and the module-scoped fixtures that hold a database handle. Bun loads multiple ' +
      'files per process, so any `process.env` assignment at module scope is visible to every other file ' +
      'in the shard.',
    guard:
      'A scan over non-serial test files for module-scope `process.env` mutation and for module-scope ' +
      'state that outlives a file, with an explicit allowlist for the files that genuinely need it.',
  },
  {
    key: 'unexhaustive-union',
    title: 'A new union member falling through a switch nobody updated',
    masked:
      'The compiler. TypeScript does not require a `switch` over a union to be exhaustive unless the ' +
      'default branch is typed to reject the leftover, so adding a member type-checks everywhere and ' +
      'silently takes the default path at every site that did not handle it.',
    analog:
      'brainz has several such unions and they carry weight: `control.job_kind` and `control.job_target` ' +
      'in the runner, the page and media types in the write path, the intent labels the ranking plan ' +
      'switches on. `noFallthroughCasesInSwitch` is on in `tsconfig.json`, and it guards a different ' +
      'thing — a missing `break`, not a missing case.',
    guard:
      'A scan asserting every `switch` over a discriminated union ends in an `assertNever`-shaped default, ' +
      'so the compiler is forced to error when a member is added.',
  },
  {
    key: 'tracked-symlink',
    title: 'A symlink in the repository pointing at one machine',
    masked:
      'The machine it was committed from, where the link resolves. Everywhere else the checkout produces ' +
      'a dangling path and the first thing to open it fails — upstream lost `bun install` on every fresh ' +
      'clone to exactly this.',
    analog:
      'Identical; nothing about the substrate changes it. Cheapest card in this file and the one most ' +
      'likely to be dismissed, which is roughly why upstream wrote the guard after the incident rather ' +
      'than before it.',
    guard: 'A check that `git ls-files -s` reports no entry in mode `120000`.',
  },
  {
    key: 'purity-of-a-determinism-claim',
    title: 'A test that claims determinism and reaches the network anyway',
    masked:
      'A populated cache and a working network. The reach succeeds, the value matches, the test is green ' +
      '— and the claim it was written to defend ("this tier is deterministic and makes no model calls") ' +
      'is false in a way that only shows up in the one environment nobody runs it in.',
    analog:
      'Partially covered, and the uncovered half is the structural one. `evals/blocking.ts` traps `fetch` ' +
      'so an accidental live call during the blocking tier is a violation rather than a quietly different ' +
      'score — that is the network half, at run time. What upstream additionally checks is *structural* ' +
      'purity: bundling each target to resolve its full transitive import graph and rejecting a ' +
      'filesystem, process or socket import anywhere in it. A module that reads a file at import time ' +
      'passes brainz’s trap and fails upstream’s.',
    guard:
      'Bundle each determinism-claiming entry point and assert the bundle contains no `node:fs`, ' +
      '`node:child_process`, `node:net`, `node:http` or `node:https` — the transitive check the runtime ' +
      'trap cannot make.',
    related: 'The blocking tier’s determinism claim is what U7 puts in the Verification Contract.',
  },
];

/**
 * One entry per `scripts/check-*` path gbrain ships at the pinned commit.
 *
 * Adding an entry is how a new upstream guard stops failing the sweep. Deleting
 * one is how a deleted upstream guard stops being claimed. Neither is automatic.
 */
export const GUARD_DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  // --- Operator SPA. Declined as a surface, so its guards cannot apply. ---
  'scripts/check-admin-build.sh': {
    kind: 'not-applicable',
    note: 'guards the operator SPA build; brainz ships no SPA (`oos.operator-machinery`)',
  },
  'scripts/check-admin-embedded.sh': {
    kind: 'not-applicable',
    note: 'guards SPA assets embedded in a compiled binary; brainz ships neither',
  },
  'scripts/check-admin-scope-drift.sh': {
    kind: 'guarded',
    guard: 'test/control/schema.test.ts',
    note:
      'the mechanism is a constant duplicated across a boundary that drifts. brainz has one such pair — ' +
      'the tenant-id alphabet in `src/control/schema.sql` and in `src/control/secrets.ts` — and the ' +
      'control-plane schema test pins them together, so an id legal in one and not the other is a failure',
  },

  // --- CLI-shaped surfaces. brainz is served over MCP only. ---
  'scripts/check-cli-executable.sh': {
    kind: 'not-applicable',
    note: 'guards the mode bit on a CLI entry point; brainz has no CLI',
    precondition: 'no-package-bin',
  },
  'scripts/check-exports-count.sh': {
    kind: 'not-applicable',
    note: 'guards a published package export surface; brainz publishes none',
    precondition: 'no-package-exports',
  },
  'scripts/check-trailing-newline.sh': {
    kind: 'not-applicable',
    note: 'file-formatting hygiene, not a failure mechanism',
  },
  'scripts/check-wasm-embedded.sh': {
    kind: 'not-applicable',
    note: 'guards WASM assets inside a compiled binary; brainz runs as a container process',
  },
  'scripts/check-image-decoders-embedded.sh': {
    kind: 'not-applicable',
    note:
      'guards image decoders inside a compiled binary; brainz’s media path (U21) resolves images ' +
      'through a hosted model call, not a bundled decoder',
  },

  // --- Upstream doc and skill machinery. ---
  'scripts/check-key-files-current-state.sh': {
    kind: 'not-applicable',
    note: 'guards the size and shape of upstream’s always-loaded CLAUDE.md; brainz has no such file',
  },
  'scripts/check-skill-brain-first.sh': {
    kind: 'not-applicable',
    note: 'guards skill content; skillpacks are declined as `oos.skillpacks`',
  },
  'scripts/check-skills-manifest-fresh.sh': {
    kind: 'not-applicable',
    note: 'guards a skills manifest; skillpacks are declined as `oos.skillpacks`',
  },
  'scripts/check-eval-glossary-fresh.sh': {
    kind: 'guarded',
    guard: 'test/upstream/sweep-freshness.test.ts',
    note:
      'the mechanism is a generated artifact committed and then allowed to drift from its generator. ' +
      'brainz acquired exactly one such artifact in this unit — the swept hazard cards and the guard ' +
      'inventory — and the freshness test regenerates and compares them, which is upstream’s own ' +
      'recipe applied to the one place the class now exists here',
  },

  // --- Mechanisms an existing brainz guard already catches. ---
  'scripts/check-gateway-routed-no-direct-anthropic.sh': {
    kind: 'guarded',
    guard: 'test/ai/boundary.test.ts',
    note:
      'the same invariant from the other end: no provider SDK, endpoint literal, raw model id or platform ' +
      'AI binding outside `src/ai/`. brainz’s scan is wider than upstream’s because an unrouted ' +
      'call here has no price lookup, no budget and no tenant counter',
  },
  'scripts/check-worker-lock-renewal-shape.sh': {
    kind: 'carded',
    card: 'H4',
    note: 'lease renewal starved by the connection it shares with the work — carded and guarded',
  },
  'scripts/check-worker-pool-atomicity.sh': {
    kind: 'guarded',
    guard: 'test/worker/race.test.ts',
    note:
      'upstream guards the single-threaded assumption a sliding pool rests on. brainz makes no such ' +
      'assumption — claiming is a fenced conditional UPDATE in the database — and the race test is where ' +
      'concurrent claims are exercised',
  },
  'scripts/check-no-legacy-getconnection.sh': {
    kind: 'guarded',
    guard: 'test/mcp/adversarial.test.ts',
    note:
      'the mechanism is a process-wide connection singleton silently serving whichever tenant reached it ' +
      'first. brainz routes every read through `src/mcp/tenant-db.ts` and the cross-tenant isolation ' +
      'assertions under a shared fleet process live in the adversarial suite',
  },
  'scripts/check-operations-filter-bypass.sh': {
    kind: 'guarded',
    guard: 'test/mcp/demarcation.test.ts',
    note:
      'the mechanism is a local-only operation reaching a remote surface because one filter was the only ' +
      'thing holding it back. brainz’s demarcation tests own which tools are advertised and ' +
      'dispatchable per endpoint',
  },
  'scripts/check-source-id-projection.sh': {
    kind: 'guarded',
    guard: 'test/core/search/fence.test.ts',
    note:
      'a projection that drops the scoping column makes a required field lie. brainz’s equivalent ' +
      'column is the origin fence, and the fence tests assert reads carry it',
  },
  'scripts/check-source-scope-onboard.sh': {
    kind: 'guarded',
    guard: 'test/core/search/fence.test.ts',
    note: 'same mechanism as the projection guard, one layer up: a SQL site issued without the scope predicate',
  },
  'scripts/check-system-of-record.sh': {
    kind: 'not-applicable',
    note:
      'upstream’s invariant is that markdown files are the system of record and derived tables must ' +
      'not be written directly. brainz inverts it — Postgres is the system of record and there is no ' +
      'markdown layer to fall out of sync with',
  },
  'scripts/check-batch-audit-site.sh': {
    kind: 'not-applicable',
    note:
      'guards a free-string label vocabulary in an audit log. brainz has no such vocabulary: the ' +
      'equivalent labels are enum types declared in `src/control/schema.sql`, so a typo is unstorable',
  },
  'scripts/check-engine-dynamic-import.sh': {
    kind: 'not-applicable',
    note:
      'guards static-import discipline on upstream’s two swappable engines, for a reason its own ' +
      'header hedges (Windows exits, with commit exhaustion as an unresolved confound). brainz has one ' +
      'engine and no such incident',
  },
  'scripts/check-engine-dynamic-import.ts': {
    kind: 'not-applicable',
    note: 'the AST half of the engine dynamic-import guard; same disposition as its shell half',
  },
  'scripts/check-privacy.sh': {
    kind: 'unported',
    card: 'privacy-scanners',
    quote: 'CLAUDE.md forbids the private OpenClaw fork name in public artifacts:',
  },
  'scripts/check-fixture-privacy.sh': {
    kind: 'unported',
    card: 'privacy-scanners',
    quote: 'Test fixtures ship in the repo; they ARE public.',
  },
  'scripts/check-no-pii-in-agent-voice.sh': {
    kind: 'unported',
    card: 'privacy-scanners',
    quote: 'SHAPE regex: phone, email, SSN, JWT, bearer token, Luhn-valid credit card.',
  },
  'scripts/check-proposal-pii.sh': {
    kind: 'unported',
    card: 'privacy-scanners',
    quote: 'classes that have surfaced in past RFC drafts',
  },
  'scripts/check-synthetic-corpus-privacy.sh': {
    kind: 'unported',
    card: 'privacy-scanners',
    quote: 'Scans test/fixtures/calibration/ for patterns that look like real-world',
  },
  'scripts/check-test-real-names.sh': {
    kind: 'unported',
    card: 'privacy-scanners',
    quote: 'Tests are checked-in code distributed with every release and',
  },
  'scripts/check-search-path.sh': {
    kind: 'ported',
    card: 'unpinned-search-path',
    quote: 'every trigger function in the canonical schema base',
    guard: 'src/schema/search-path.ts',
  },
  'scripts/check-pg-url-redaction.sh': {
    kind: 'unported',
    card: 'credential-in-a-log-or-payload',
    quote: 'CI grep guard (v0.30.1, finding F3): no source file under src/ may emit',
  },
  'scripts/check-source-config-leak.sh': {
    kind: 'unported',
    card: 'credential-in-a-log-or-payload',
    quote: 'without first running it through redactSourceConfig() will leak the secret.',
  },
  'scripts/check-jsonb-pattern.sh': {
    kind: 'unported',
    card: 'jsonb-double-encode',
    quote: 'that caused the v0.12.0 silent-data-loss bug (JSONB columns stored as',
  },
  'scripts/check-jsonb-params.mjs': {
    kind: 'unported',
    card: 'jsonb-double-encode',
    quote: 'The legacy scripts/check-jsonb-pattern.sh only catches the template-tag form',
  },
  'scripts/check-bun-test-timeout.sh': {
    kind: 'unported',
    card: 'hook-budget',
    quote: 'afterAll/afterEach hooks. Hooks do NOT inherit a test',
  },
  'scripts/check-no-double-retry.sh': {
    kind: 'unported',
    card: 'retry-amplification',
    quote: 'Wrapping them ALSO at the call site produces 3',
  },
  'scripts/check-progress-to-stdout.sh': {
    kind: 'unported',
    card: 'non-protocol-bytes',
    quote: 'piped-output scenario: agents that capture stdout for structured',
  },
  'scripts/check-test-isolation.sh': {
    kind: 'unported',
    card: 'shared-process-test-leakage',
    quote: 'into one bun process per shard; module-level state (env vars, PGLite',
  },
  'scripts/check-test-isolation.allowlist': {
    kind: 'data',
    note: 'the allowlist the test-isolation guard reads; data, not an executable guard',
  },
  'scripts/check-pagetype-exhaustive.sh': {
    kind: 'unported',
    card: 'unexhaustive-union',
    quote: "extending PageType (e.g. v0.27.1 adding 'image') silently fell through",
  },
  'scripts/check-no-tracked-symlinks.sh': {
    kind: 'unported',
    card: 'tracked-symlink',
    quote: 'A symlink committed from a build sandbox points at a path that exists on',
  },
  'scripts/check-fuzz-purity.sh': {
    kind: 'unported',
    card: 'purity-of-a-determinism-claim',
    quote: 'no transitive imports of `node:fs`, `node:child_process`',
  },
};
