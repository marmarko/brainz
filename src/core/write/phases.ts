/**
 * The sync/async split, named — and enforced.
 *
 * This is U4's spine. Everything else in the unit is a step; this file is the
 * statement of **what must be true before the call returns, versus what may
 * complete later**, in a form a test can check.
 *
 * The reason it is data rather than a paragraph in a doc comment is that the
 * split degrades silently in both directions. Move chunk embedding onto the
 * synchronous side and nothing fails — the write just gets slower, on a path
 * where the provider round-trip is measured in hundreds of milliseconds and the
 * caller is a user waiting. Move link extraction off it and nothing fails
 * either — "who did I just say Alice works with" simply answers wrong for a
 * while. Neither shows up as an error, so both are pinned here:
 * {@link PhaseRecorder} records what a run actually did and refuses a run that
 * skipped a synchronous phase or performed a deferred one inline.
 *
 * **What is synchronous, and why each one is.**
 *
 *  - `normalize`, `chunk`, `extract` — pure, sub-millisecond, and everything
 *    downstream is a function of them.
 *  - `embed_facts` — `fact.embedding` is `NOT NULL` in the schema precisely
 *    because classifiers need vectors immediately; an unembedded fact is a row
 *    the database refuses rather than one the vector arm skips forever.
 *  - `dedup` — deferring it means `recall` can return two contradictory
 *    versions of one claim in the window before a consolidation cycle.
 *  - `resolve_entities`, `reconcile_edges` — sub-second, and the graph arm is
 *    asked about what the user just said immediately after they say it.
 *  - `commit` — the row is durable or the call failed. There is no third state.
 *
 * **What is deferred, and why deferring it is safe.**
 *
 *  - `embed_chunks` — the expensive one, and safe to defer only because its
 *    backlog is a query over the rows themselves (`embedding IS NULL`), not a
 *    promise held by the process that made it. Meanwhile the full-text arm
 *    already serves the chunk: the tsvector is a generated column, so it exists
 *    the moment the row commits.
 *  - `synopsis_wrap` — the contextual tier that costs a model call per chunk.
 *    The free title tier is applied on the write path; this one is
 *    consolidation's (U11).
 */

export const SYNC_PHASES = [
  'normalize',
  'chunk',
  'extract',
  'embed_facts',
  'dedup',
  'resolve_entities',
  'reconcile_edges',
  'commit',
] as const;

export type SyncPhase = (typeof SYNC_PHASES)[number];

export const ASYNC_PHASES = ['embed_chunks', 'synopsis_wrap'] as const;

export type AsyncPhase = (typeof ASYNC_PHASES)[number];

export class PhaseOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhaseOrderError';
  }
}

export interface PhaseRecorder {
  /** Records that a phase ran. Refuses a deferred phase outright. */
  enter(phase: SyncPhase): void;
  /** What ran, in order. Carried on the receipt. */
  readonly ran: readonly SyncPhase[];
  /**
   * Asserts the run performed every synchronous phase, in the declared order.
   * Called before a receipt is handed back, so a write that quietly skipped
   * reconciliation cannot report success.
   */
  assertComplete(): void;
}

export function createPhaseRecorder(): PhaseRecorder {
  const ran: SyncPhase[] = [];
  const declared = new Set<string>(SYNC_PHASES);
  const deferred = new Set<string>(ASYNC_PHASES);

  return {
    ran,
    enter(phase) {
      if (deferred.has(phase)) {
        throw new PhaseOrderError(
          `'${phase}' is a deferred phase: running it inline puts a provider round-trip on the caller's write`,
        );
      }
      if (!declared.has(phase)) {
        throw new PhaseOrderError(`'${phase}' is not a declared phase of the write path`);
      }
      ran.push(phase);
    },
    assertComplete() {
      const expected = SYNC_PHASES.join(' → ');
      const actual = ran.join(' → ');
      if (expected !== actual) {
        throw new PhaseOrderError(
          `the synchronous half did not run as declared.\n  expected: ${expected}\n  actual:   ${actual}`,
        );
      }
    },
  };
}
