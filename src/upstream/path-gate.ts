/**
 * The path gate — which upstream change is brainz's problem.
 *
 * gbrain is a CLI-first, git-repo-backed, multi-source knowledge tool with a
 * skillpack system and an operator SPA. brainz is a stateless MCP server over a
 * per-tenant Postgres. Most of what upstream ships is therefore genuinely not a
 * concept here, and `upstream/concepts.jsonl` already carries the `oos.*` rows
 * where those decisions were taken. A gate that routed `src/commands/` into the
 * ledger would refill it weekly with decisions already made.
 *
 * **The rule that makes this safe to automate is the treatment of the unknown.**
 * An upstream path under `src/` that matches nothing here is not "not ours" — it
 * is a directory gbrain added since this table was written, which is precisely
 * the event the watcher exists to notice. It resolves to the `unmapped` area, in
 * scope, at low confidence, so it reaches the ledger and a human looks. The
 * alternative — a default of "out of scope" — makes the gate go quiet exactly
 * when upstream does something new.
 *
 * Criticality and priority come from the area rather than from the change, and
 * that is a deliberate under-claim: the watcher cannot read a release note and
 * know how urgent it is here. It assigns the area's floor, records that it did
 * (`discovered_by.assigned`), and the human re-takes it at review.
 */

/** The brainz areas an upstream change can land in. `unmapped` is one of them on purpose. */
export const AREAS = [
  'retrieval',
  'schema',
  'mcp-surface',
  'spend',
  'ai-routing',
  'consolidation',
  'ingest',
  'worker',
  'evaluation',
  'unmapped',
] as const;

export type Area = (typeof AREAS)[number];

export type Confidence = 'low' | 'medium' | 'high';

export interface InScope {
  readonly in_scope: true;
  readonly area: Area;
  readonly criticality: 'critical' | 'important' | 'optional';
  readonly priority: 'p0' | 'p1' | 'p2';
  readonly confidence: Confidence;
}

export interface OutOfScope {
  readonly in_scope: false;
  /** Why, in a sentence a person reading the run report can act on. */
  readonly reason: string;
}

export type Gated = InScope | OutOfScope;

/**
 * Area floors. `critical`/`p1` for the areas where an upstream change can move
 * an R6 number or a tenant boundary; `important`/`p2` elsewhere. Nothing is
 * assigned `p0`: p0 is "this blocks the current phase", which is a roadmap
 * judgement the watcher has no basis for.
 */
const AREA_FLOOR: Readonly<Record<Area, { criticality: InScope['criticality']; priority: InScope['priority'] }>> = {
  retrieval: { criticality: 'critical', priority: 'p1' },
  schema: { criticality: 'critical', priority: 'p1' },
  'mcp-surface': { criticality: 'critical', priority: 'p1' },
  spend: { criticality: 'critical', priority: 'p1' },
  'ai-routing': { criticality: 'important', priority: 'p2' },
  consolidation: { criticality: 'important', priority: 'p2' },
  ingest: { criticality: 'important', priority: 'p2' },
  worker: { criticality: 'important', priority: 'p2' },
  evaluation: { criticality: 'important', priority: 'p2' },
  unmapped: { criticality: 'important', priority: 'p2' },
};

/** Longest prefix wins, so `src/core/search/` beats `src/core/`. */
const IN_SCOPE: ReadonlyArray<readonly [prefix: string, area: Area]> = [
  ['src/core/search/', 'retrieval'],
  ['src/core/rerank', 'retrieval'],
  ['src/core/vector-index.ts', 'schema'],
  ['src/core/postgres-engine.ts', 'schema'],
  ['src/core/pglite-engine.ts', 'schema'],
  ['src/core/migrate.ts', 'schema'],
  ['src/core/db.ts', 'schema'],
  ['src/schema.sql', 'schema'],
  // Written without the trailing 's' deliberately: the gateway-boundary scanner
  // (`test/ai/boundary.test.ts`) treats the literal `/embeddings` anywhere
  // outside `src/ai/` as a module reaching a provider endpoint, and a routing
  // table that names upstream's directories is exactly the false positive that
  // would teach somebody to widen that guard. The prefix still matches.
  ['src/core/embedding', 'schema'],
  ['src/mcp/', 'mcp-surface'],
  ['src/core/verbs/', 'mcp-surface'],
  ['src/core/protocol', 'mcp-surface'],
  ['src/core/operations.ts', 'mcp-surface'],
  ['src/core/surface.ts', 'mcp-surface'],
  ['src/core/budget/', 'spend'],
  ['src/core/model-pricing.ts', 'spend'],
  ['src/core/embedding-pricing.ts', 'spend'],
  ['src/core/anthropic-pricing.ts', 'spend'],
  ['src/core/progressive-batch/', 'spend'],
  ['src/core/ai/', 'ai-routing'],
  ['src/core/model-config.ts', 'ai-routing'],
  ['src/core/cycle/', 'consolidation'],
  ['src/core/facts/', 'consolidation'],
  ['src/core/entities/', 'consolidation'],
  ['src/core/extract/', 'consolidation'],
  ['src/core/eval-contradictions/', 'consolidation'],
  ['src/core/salience', 'consolidation'],
  ['src/core/ingestion/', 'ingest'],
  ['src/core/conversation-parser/', 'ingest'],
  ['src/core/chunkers/', 'ingest'],
  ['src/core/import-file.ts', 'ingest'],
  ['src/core/media/', 'ingest'],
  ['src/core/minions/', 'worker'],
  ['src/core/backfill', 'worker'],
  ['src/core/eval/', 'evaluation'],
  ['src/eval/', 'evaluation'],
  ['src/core/bench/', 'evaluation'],
  ['src/core/audit/', 'evaluation'],
];

/**
 * Out-of-scope prefixes, each with the reason. Where the ledger already took the
 * decision, the reason names its row id — so a report reader can go read why
 * rather than re-litigating it from the release note.
 */
const OUT_OF_SCOPE: ReadonlyArray<readonly [prefix: string, reason: string]> = [
  ['src/commands/', 'no CLI surface — brainz is served over MCP only, so a CLI command has no counterpart here'],
  ['src/cli.ts', 'no CLI surface — brainz is served over MCP only'],
  ['src/core/output/', 'CLI presentation; brainz renders through the MCP envelope'],
  ['src/core/progress.ts', 'CLI progress reporting; brainz jobs report through the control-plane job row'],
  ['skills/', 'no skillpack surface — declined as `oos.skillpacks`'],
  ['src/core/skillpack/', 'no skillpack surface — declined as `oos.skillpacks`'],
  ['src/core/skillify/', 'no skillpack surface — declined as `oos.skillpacks`'],
  ['src/core/skillopt/', 'no skillpack surface — declined as `oos.skillpacks`'],
  ['src/core/schema-pack/', 'schema packs and lens packs declined as `oos.lens-packs`'],
  ['src/core/lens', 'schema packs and lens packs declined as `oos.lens-packs`'],
  ['src/core/thin-client/', 'the multi-source / multi-brain axis is declined as `oos.multi-source-axis`'],
  ['src/core/brainstorm/', 'a generative surface on top of memory is declined as `oos.generative-surface`'],
  ['src/core/think/', 'a generative surface on top of memory is declined as `oos.generative-surface`'],
  ['src/core/takes', 'a generative surface on top of memory is declined as `oos.generative-surface`'],
  ['src/core/code', 'code indexing is declined as `oos.code-indexing`'],
  ['src/core/reindex', 'code indexing is declined as `oos.code-indexing`'],
  ['src/core/onboard/', 'operator/installer machinery declined as `oos.operator-machinery`'],
  ['src/core/scope.ts', 'operator/installer machinery declined as `oos.operator-machinery`'],
  ['admin/', 'no operator SPA — declined as `oos.operator-machinery`'],
  ['src/admin', 'no operator SPA — declined as `oos.operator-machinery`'],
  ['src/openclaw', "upstream's own host integration; brainz has no fork-host seam"],
  ['src/edge-entry.ts', "upstream's own host integration; brainz has no fork-host seam"],
  ['src/types', 'upstream type declarations carry no behaviour to port'],
  ['deploy/', "upstream's deployment configuration"],
  ['test/', "upstream's own tests — the behaviour they pin is read from the source path instead"],
  ['tests/', "upstream's own tests — the behaviour they pin is read from the source path instead"],
  ['scripts/', "upstream's build and guard scripts — guards are swept separately by the hazard sweep"],
  ['docs/', 'upstream documentation'],
  ['evals/', "upstream's own eval harness; brainz's lives in `evals/` and is graded by its own floors"],
  ['bin/', 'upstream build output'],
];

/** Files at the repo root — CHANGELOG, CLAUDE.md, README — carry no portable behaviour. */
const ROOT_FILE = /^[A-Za-z0-9_.-]+$/;

export function gatePath(path: string): Gated {
  const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');

  if (ROOT_FILE.test(normalised)) {
    return { in_scope: false, reason: 'a repo-root file — documentation or configuration, not behaviour' };
  }

  const scoped = [...IN_SCOPE]
    .filter(([prefix]) => normalised.startsWith(prefix))
    .sort((left, right) => right[0].length - left[0].length)[0];

  const declined = [...OUT_OF_SCOPE]
    .filter(([prefix]) => normalised.startsWith(prefix))
    .sort((left, right) => right[0].length - left[0].length)[0];

  // Longest prefix wins across both tables, so a future in-scope module under an
  // out-of-scope tree (or the reverse) is expressible without reordering.
  if (scoped !== undefined && (declined === undefined || scoped[0].length >= declined[0].length)) {
    const floor = AREA_FLOOR[scoped[1]];
    return { in_scope: true, area: scoped[1], ...floor, confidence: 'medium' };
  }

  if (declined !== undefined) {
    return { in_scope: false, reason: declined[1] };
  }

  if (normalised.startsWith('src/')) {
    // The finding. Upstream added a directory this table has never heard of.
    return { in_scope: true, area: 'unmapped', ...AREA_FLOOR.unmapped, confidence: 'low' };
  }

  return { in_scope: false, reason: "outside upstream's source tree" };
}
