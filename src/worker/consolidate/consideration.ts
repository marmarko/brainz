/**
 * What a model phase has already looked at, and the version it looked at it at.
 *
 * **The gap this closes.** Six model phases, and until this module existed only
 * two of them could say what they had finished. `transcribe` selects attachments
 * whose `ocr_text` is null; `synopsis` selects pages with no summary page
 * standing against them. Both re-select only work nobody has done, so a cycle
 * that stops costs them nothing. The other four — `extract`, `enrich`,
 * `contradiction`, `salience_refine` — took the top N by salience or by id with
 * no clause at all about work already done, so the only thing between a second
 * cycle and a second invoice was `consolidation_checkpoint`, a row keyed to one
 * RUN.
 *
 * That is why the freeze had two faces and why every design tried against it
 * broke in one direction or the other. Keep the run open when a cycle stops and
 * the next cycle honours a sibling's checkpoint against it forever — one page
 * drawing a provider 500 called `extract` once across three cycles on a brain of
 * 5,608 pages. Close the run on every exit and `extract` is re-paid every cycle
 * while `enrich`, `synopsis`, `contradiction` and `salience_refine` are never
 * reached at all. Both measured, on the same brain, against the same budget.
 *
 * A phase that records what it has considered pays neither. Closing the run then
 * costs what it already costs `transcribe` and `synopsis`: nothing.
 *
 * ---------------------------------------------------------------------------
 * **"Considered", not "produced something".**
 *
 * The marker is written for every row the phase handed to the model and got a
 * readable answer about, whether or not that row yielded a fact, a card, a
 * conflict or a score. The alternative — key the marker on output, so a chunk is
 * done once a fact points at it — was refused, and the case that refuses it is
 * ordinary rather than exotic: a calendar invite or a one-line email states no
 * factual claim, so it is never "done", so it stays at the top of the
 * salience-ordered queue and is re-sent every cycle for the life of the brain
 * with every chunk behind it waiting. The batch is pinned by exactly the rows
 * with nothing in them.
 *
 * ---------------------------------------------------------------------------
 * **Why a version and not a boolean or a timestamp.**
 *
 * A durable marker's cost is that a deliberate re-run needs a door, and a bare
 * flag leaves only one: an operator with a psql session writing UPDATE over a
 * content table. A version gives the code the door instead — a row carries the
 * version that considered it, and a selector takes rows whose stamp is absent or
 * older than the version it is running at, so bumping the number in
 * {@link CONSIDERATION_VERSION} offers the corpus again with nobody touching a
 * row.
 *
 * A timestamp would look like it does the same and does not: "re-consider
 * everything stamped before this instant" needs the instant written down
 * somewhere anyway, and that somewhere would be a second source of truth for a
 * decision the code already has to make.
 *
 * **Where the number comes from: here, by hand, one per phase.** It is bumped in
 * the same commit as the change that makes the previous answers not worth
 * keeping — a rewritten prompt, a changed gate, or the case the owner named, a
 * different model behind the phase's op in `src/ai/routing.ts`. Bumping it means
 * exactly one thing: the whole corpus becomes a candidate again for that phase,
 * once, and the brain re-pays for it at the new version.
 *
 * **It is deliberately NOT derived from the routing pin**, which is the obvious
 * automation and is wrong three ways. The pin is per-*profile* — `self-host`
 * remaps five of the nine ops to a different id serving the same weights — so a
 * derived version would differ between two tenants running the same weights, and
 * a profile switch would re-pay for the whole corpus for no reason a user would
 * recognise. The pin is per-*op*, and `salience_refine` shares the `salience` op
 * with nothing else in this table but could. And most of all, advancing a pin is
 * a thing done for reasons that have nothing to do with the answer quality — a
 * vendor deprecation, a security fix — so deriving from it hides a decision to
 * re-bill an entire corpus inside an edit whose stated purpose is something
 * else. The cost of re-consideration is a product decision, and a product
 * decision belongs in a number somebody typed.
 */

import type { SQL } from 'bun';

import { numericArrayLiteral } from '../../core/write/pg-values.ts';

/**
 * The four phases whose work was not durable until this module.
 *
 * `transcribe` and `synopsis` are absent because their durability is in the
 * content — a transcribed attachment has `ocr_text`, a summarised page has a
 * summary — and a second marker for a fact the row already states is a second
 * place for it to be wrong.
 */
export const CONSIDERING_PHASES = ['extract', 'enrich', 'contradiction', 'salience_refine'] as const;

export type ConsideringPhase = (typeof CONSIDERING_PHASES)[number];

export type ConsiderationVersions = Readonly<Record<ConsideringPhase, number>>;

/**
 * The version each phase considers at today.
 *
 * One per phase rather than one shared number, because the phases are retuned
 * independently: a rewritten extraction prompt is no reason to re-score every
 * page's salience, and a shared counter would make every bump cost four
 * corpora.
 *
 * **Bumping one of these re-bills that phase over the whole corpus, once.** On a
 * brain of a few thousand pages that is one batch per `limit` rows per cycle
 * until it converges again. Do it when the phase's answers changed, not when its
 * code did.
 */
export const CONSIDERATION_VERSION: ConsiderationVersions = Object.freeze({
  extract: 1,
  enrich: 1,
  contradiction: 1,
  salience_refine: 1,
});

/**
 * The shipped versions, with a caller's overrides on top.
 *
 * The seam exists so a test can express a bump as an argument rather than by
 * reaching into a module constant — a suite that mutated the constant would be
 * asserting against a value no deploy ever has, and the two would drift the
 * first time somebody froze the object.
 */
export function considerationVersions(
  overrides?: Partial<ConsiderationVersions>,
): ConsiderationVersions {
  if (overrides === undefined) return CONSIDERATION_VERSION;
  return Object.freeze({ ...CONSIDERATION_VERSION, ...overrides });
}

/** Where one phase's marker lives: the row it consumes, and its key. */
export interface ConsideredMarker {
  readonly table: string;
  readonly key: string;
  readonly column: string;
}

/**
 * One shape for all four, and the shape is a nullable version column on the row
 * the phase consumes.
 *
 * A side table keyed by (phase, row kind, row id) was the alternative and it
 * buys nothing here: the four ids are four different key columns on four
 * different tables, so the shared table's key would be polymorphic — no foreign
 * key, no cascade when a page is deleted, and an anti-join against a growing
 * table in front of every candidate query. The column is on the row, so it goes
 * when the row goes and the predicate is a column read.
 *
 * The column is named for the PHASE, not the op: `page` is written by the
 * deterministic `salience` phase as well, and a column called
 * `salience_considered_version` would read as that one's.
 */
export const CONSIDERED: Readonly<Record<ConsideringPhase, ConsideredMarker>> = Object.freeze({
  extract: { table: 'chunk', key: 'chunk_id', column: 'extract_considered_version' },
  enrich: { table: 'entity', key: 'entity_id', column: 'enrich_considered_version' },
  contradiction: { table: 'fact', key: 'fact_id', column: 'contradiction_considered_version' },
  salience_refine: { table: 'page', key: 'page_id', column: 'salience_refine_considered_version' },
});

/**
 * Stamp every row a phase considered, in one statement.
 *
 * **Called once, at the end, on the path where the model answered and this code
 * could read the answer.** Not when the gateway refused, and not when the body
 * would not parse: those are the phase's failure rather than any row's outcome,
 * and marking a row the phase never got a verdict about would lose it — the one
 * direction a durable marker must never be wrong in. A batch that is not marked
 * is re-sent next cycle, which costs one call and whatever duplicate rows it
 * writes, and `dedup` is the phase that already collapses those.
 *
 * The table, key and column come from {@link CONSIDERED} — code constants, never
 * input — so the identifiers are interpolated and only the version and the id
 * list are bound.
 */
export async function markConsidered(
  sql: SQL,
  phase: ConsideringPhase,
  ids: readonly string[],
  version: number,
): Promise<void> {
  if (ids.length === 0) return;
  const marker = CONSIDERED[phase];
  await sql.unsafe(
    `UPDATE ${marker.table} SET ${marker.column} = $1 WHERE ${marker.key} = ANY($2::bigint[])`,
    [version, numericArrayLiteral(ids)],
  );
}
