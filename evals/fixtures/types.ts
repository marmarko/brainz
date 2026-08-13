/**
 * The shapes the fixture corpus is authored in.
 *
 * **Every closed set here is copied from the tenant DDL on purpose, not
 * paraphrased.** `source_type`, `entity_type` and the slug pattern are CHECK
 * constraints in `src/schema/migrations/v2-knowledge-core.sql`; a fixture that
 * drifts from them is a fixture U5 cannot seed, and the drift would surface as a
 * constraint violation on the day someone tries to use the corpus rather than on
 * the day it was written. `test/evals/seed.test.ts` loads the whole corpus into a
 * real tenant database precisely so these unions cannot quietly go stale — the
 * database is the authority, and the types here are a convenience that the
 * database checks.
 *
 * Origin context is the one set that is *ours* rather than the DDL's: the schema
 * stores `origin_context` as free text because it is credential-derived at
 * ingestion, so the fixture declares its own closed vocabulary and the loader
 * enforces it. R15 fences reads on this value and nothing else.
 */

/**
 * The credentials this synthetic brain was filled through. Two grants —
 * personal and work — across four surfaces. Context-fenced questions are
 * questions whose answer changes depending on which of these the reader holds.
 */
export const ORIGIN_CONTEXTS = [
  'personal:mail',
  'personal:chat',
  'personal:files',
  'personal:calendar',
  'work:mail',
  'work:files',
  'work:calendar',
] as const;
export type OriginContext = (typeof ORIGIN_CONTEXTS)[number];

/** Verbatim from `page_source_type_is_known`. */
export const SOURCE_TYPES = [
  'email',
  'chat',
  'document',
  'web',
  'note',
  'calendar',
  'transcript',
  'file',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Verbatim from `entity_type_is_known`. */
export const ENTITY_TYPES = [
  'person',
  'organization',
  'place',
  'project',
  'product',
  'event',
  'topic',
  'other',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * R6's four question types. Each query has exactly one, and each carries its own
 * floor — R6 is explicit that an aggregate alone is not enough, because an
 * aggregate lets a stack that is excellent at named-entity lookup and blind to
 * time report a healthy number.
 */
export const QUESTION_TYPES = ['relational', 'named_entity', 'temporal', 'context_fenced'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * The probe families R6 names separately from the question types. They are a
 * second, independent axis: a title-substring probe is usually also a
 * named-entity question, and the two floors measure different failures. Every
 * query has exactly one family; `general` is the family for queries that are not
 * probing one of the three named failure modes.
 */
export const QUERY_FAMILIES = ['title_substring', 'alias', 'dilution', 'general'] as const;
export type QueryFamily = (typeof QUERY_FAMILIES)[number];

/**
 * One ingested document. Paragraphs become chunks in order, which is the whole
 * chunking policy: it is deterministic, it is legible in a diff, and it means a
 * gold key can point at `p-thing#2` and a human can count to it.
 */
export interface FixturePage {
  readonly id: string;
  readonly title: string;
  readonly sourceType: SourceType;
  readonly origin: OriginContext;
  /** ISO date. Temporal questions are decided by this and by fact validity. */
  readonly createdAt: string;
  readonly paragraphs: readonly string[];
  /**
   * Marks this page's chunks as members of a near-duplicate cluster — the same
   * content arriving through more than one credential, which is the ordinary
   * state of a brain fed from both a personal and a work mailbox.
   */
  readonly dupGroup?: string;
  /** R12 soft delete. Must never appear in a result; see `visibility_violations`. */
  readonly deletedAt?: string;
  /** U9 junk quarantine. Same rule. */
  readonly quarantinedAt?: string;
}

export interface FixtureAlias {
  readonly alias: string;
  /** `user` aliases are declarations; `inferred` ones must carry a confidence. */
  readonly source: 'user' | 'inferred';
  readonly confidence?: number;
}

export interface FixtureEntity {
  /** Doubles as the canonical slug; must match the DDL's slug pattern. */
  readonly id: string;
  readonly canonicalName: string;
  readonly type: EntityType;
  readonly origins: readonly OriginContext[];
  readonly aliases: readonly FixtureAlias[];
}

/**
 * A typed relationship. The inverse is declared once in {@link FixtureEdgeType}
 * and never materialised as a second row, matching the tenant schema's design:
 * there is only one half of a relationship, so the two halves cannot disagree.
 */
export interface FixtureEdge {
  readonly subject: string;
  readonly type: string;
  readonly object: string;
  /** The facts this edge was derived from. Empty is not allowed — see the loader. */
  readonly factIds: readonly string[];
}

export interface FixtureEdgeType {
  readonly type: string;
  readonly inverse: string;
  readonly description: string;
}

/**
 * An extracted claim, and the chunks it came from.
 *
 * `validFrom` plus `supersededBy` is what makes the temporal questions decidable:
 * a stale fact is not deleted, it is superseded, and a stack with no notion of
 * time will happily return the superseded one — especially when, as here, the
 * stale page repeats the query's terms more often than the current one does.
 */
export interface FixtureFact {
  readonly id: string;
  readonly statement: string;
  readonly sourceChunks: readonly string[];
  readonly validFrom: string;
  readonly supersededBy?: string;
}

/**
 * One evaluation query, its gold key, and its answerability audit — deliberately
 * one record rather than three files.
 *
 * Splitting them invites the failure R6a's upper bound exists to catch: a query
 * whose gold key silently references a chunk that is soft-deleted, or fenced out
 * of its own grant, or simply no longer in the corpus. Keeping them adjacent
 * does not prevent that, but the loader's bidirectional referential check does,
 * and having one record makes the check trivial to write and impossible to
 * forget for a newly added query.
 */
export interface FixtureQuery {
  readonly id: string;
  readonly text: string;
  readonly type: QuestionType;
  readonly family: QueryFamily;
  /** The origins the asking credential may see. R15's fence, as a query input. */
  readonly grant: readonly OriginContext[];
  /** Grade-3 chunks: the ones that answer the question outright. Hit@k reads these. */
  readonly answers: readonly string[];
  /** Grades 1 and 2: related and strongly supporting. nDCG reads these plus the answers. */
  readonly supporting?: Readonly<Record<string, 1 | 2>>;
  /** Dilution queries only: every one of these duplicate groups must reach the top 3. */
  readonly requiredGroups?: readonly string[];
  /**
   * The stack elements that reach this answer, by their `upstream/concepts.jsonl`
   * ids. Validated against the ledger — both that the id exists and that its
   * owning unit lands by U5 — so a query cannot be authored that is unanswerable
   * by the stack it will be used to grade. That is the misread R6a's upper bound
   * exists to prevent, made mechanical.
   */
  readonly mechanisms: readonly string[];
  /** The hand audit: the evidence chain, in a sentence a reviewer can check. */
  readonly evidence: string;
}
