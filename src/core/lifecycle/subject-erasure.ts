/**
 * Subject-scoped erasure (R12), keyed on a **correspondent**, not on a tenant.
 *
 * Every one of the five account-erasure legs drops a whole tenant. A brain also
 * holds identifiable content about people who never signed up — the ones who
 * write to the user and the ones who attend their meetings — and a request from
 * one of them has nothing to run against a brain that stays live. This module is
 * what makes that request answerable.
 *
 * It is built against the determination a sibling settled first, at
 * `docs/plans/2026-08-13-003-u15-web-app-identity-billing-replan.md` §6 — brainz
 * is the **processor** and the user is the **controller** for everything in the
 * brain, including this content — and §6.3 fixes four properties this module
 * owes. Each is answered here:
 *
 *   1. **Keyed on a correspondent identifier, not a tenant.** The identifier is
 *      an address or a name, normalised through the *same* normalizer the write
 *      path used, and resolved through `entity_slug` and `entity_alias`.
 *   2. **Spanning derivation, not just rows.** See the two handles below.
 *   3. **Invocable by the controlling user, out of band.** This module exports a
 *      function and registers no MCP tool. R12a's rule applies with full force:
 *      the assistant that would issue it is the assistant reading the
 *      correspondent's mail.
 *   4. **Tombstoned against re-ingestion.** {@link eraseSubject} writes an
 *      `erased_subject` row, and {@link isErasedSubject} is what a pull path
 *      consults before writing a page. **The consulting half is wired**:
 *      `src/ingest/pipedream/pull.ts` asks through `src/ingest/erased-subjects.ts`
 *      before the estimate, so the next poll cannot undo the erasure on a
 *      cadence and make the receipt handed to a third party false within the
 *      hour. That module states the bound the digest imposes — a pull can only
 *      ask about identifiers it can *name*, so a prose mention carrying no
 *      address is not suppressed, and the manual import paths do not consult it
 *      at all.
 *
 * ============================================================================
 * TWO HANDLES, AND THE LIMIT BETWEEN THEM
 * ============================================================================
 *
 * **The derivation handle.** The resolved `entity` and everything hanging off
 * it: its slugs, its aliases, its `entity_card`, and every `entity_edge` it is
 * an endpoint of.
 *
 * **The text handle.** Pages, chunks, facts and commitments whose text names the
 * subject. This exists because there is no structural edge from a fact to the
 * entity it is about — `fact_source` reaches chunks, `entity_edge` reaches
 * entities, and nothing joins the two — so a derivation-only sweep would delete
 * the person's card and leave every sentence about them answering `recall`.
 *
 * **A hazard on the text handle, and the two things that hold it.** The surface
 * forms include the entity's *inferred* aliases, not only the ones a user
 * stated — `resolveOrCreateEntity` writes `normalize(name)` as an `inferred`
 * alias for every surface form the extractor emits, with no length floor, so a
 * correspondent who signs off `Al` puts a two-character row in the vocabulary
 * this sweep reads. Two properties keep that from erasing other people:
 *
 *   1. **The text handle matches a name, not a substring.** Every form becomes a
 *      regular expression with word-boundary assertions at whichever end is a
 *      word character ({@link formToPattern}), so `al` reaches the person called
 *      Al and does not reach `legal`, `Alvarez`, `renewal` or `Alberta`. A
 *      length floor was the other candidate and is worse: it answers
 *      over-deletion by silently under-erasing, which on this operation is the
 *      failure with no way back. **The escaping is regex escaping, not LIKE
 *      escaping** — `J.P.` under a LIKE-escaped pattern would match `JXPX`.
 *   2. **The preview names every row, not just every page.** The mitigation for
 *      a widened sweep is the flow rather than a filter — the controller reads
 *      {@link previewSubjectErasure} before instructing, exactly as they read a
 *      blast radius before a `forget` — and a flow whose preview reported
 *      `facts: 2` as a bare number could not see what it was authorising.
 *      {@link SubjectErasurePreview.rows} carries one entry per fact,
 *      commitment, proposal, attachment and snapshot the sweep will take, with
 *      the text that named her and the handle that found it. The counts are
 *      *derived from that list*, so a receipt cannot report a number nobody can
 *      inspect. Anything that makes erasure invocable without the preview
 *      re-opens this.
 *
 * **What neither handle reaches**, stated here rather than discovered by a
 * regulator: a message that mentions the correspondent, from which no fact was
 * extracted, *and* which does not contain the identifier or any known alias as
 * text. That is a limit of extraction rather than of erasure, and the receipt
 * reports which handle found each page so the controller can see the difference.
 *
 * ============================================================================
 * THE TABLES NOTHING ELSE WILL EVER SWEEP
 * ============================================================================
 *
 * The soft deletes below ride `forget`'s existing 72h purge, and that promise is
 * only true of the tables `purgeExpiredTombstones` reaches. Three do not, by
 * their own design, and each is swept here rather than left to a cascade that
 * does not exist:
 *
 *   * **`page_version`** — its foreign key is `ON DELETE SET NULL` precisely so
 *     history outlives a purge. Matched on its own text as well as by document
 *     key, because the ordinary case is a document *edited* after the snapshot
 *     was banked: the live page no longer names her, page discovery never
 *     reaches it, and her mail is in the history. Hard-deleted — a snapshot is a
 *     verbatim second copy of the document, and there is no version of "removed"
 *     that leaves one standing.
 *   * **`review_queue`** — deliberately carries no foreign key so it "outlives
 *     proposals about rows that a later cycle superseded". An unreviewed
 *     proposal is free-text prose about the correspondent, including inferences
 *     the extractor made, and every state carries it: an `applied` proposal
 *     quotes her identically to an open one.
 *   * **`commitment` and `attachment` rows with no surviving parent.** Both
 *     cascade from rows the purge takes — but a commitment whose `page_id` and
 *     `fact_id` are both NULL (the shape extraction writes when it could not
 *     attribute one) and an attachment on a page that is *staying* have no
 *     cascade to ride. `src/mcp/tombstone.ts` purges both by `deleted_at` for
 *     that reason, and `test/core/lifecycle/subject-erasure.test.ts` runs the
 *     real purge rather than asserting the claim in prose.
 *
 * **The attachment's object, and the one key this module is allowed to know.**
 * `attachment.object_key` is what `src/control/storage.ts` derived and recorded;
 * reading it back is not deriving one. That is why the attachment's object is
 * removable here while a raw payload's key still has to come from the caller
 * through {@link SubjectErasureDeps.rawKeyOf} — and why both are counted
 * separately on the receipt, including the ones a run without a store could not
 * reach.
 *
 * **What this closes upstream.** `revertPage` re-ingests a snapshot body through
 * U4 with no erased-subject consult, and it cannot have one: the tombstone
 * stores a digest and no caller can recover an identifier to hash. The property
 * that closes it is that the snapshot is gone, so a revert refuses at its first
 * statement instead of re-chunking and re-embedding an erased correspondent back
 * into the live corpus.
 *
 * ============================================================================
 * REMOVED IS NOT THE WHOLE COST
 * ============================================================================
 *
 * Same shape as `blast-radius.ts`, for the same R15 reason: a derived row that
 * *survives* but lost an input is not correct any more. A surviving fact whose
 * source chunks were partly removed, and a surviving entity's card that was
 * built while an edge to the erased person existed, both have to be re-derived.
 * They are counted separately and the receipt says a recompute is required —
 * an erasure that silently left stale derived text about the person it erased
 * would be the failure this module exists to prevent, one derivation removed.
 */

import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import { nameMatchPattern } from '../search/name-match.ts';

import { docKeyFor } from '../export/reconstruct.ts';
import { normalize, slugify } from '../write/normalize.ts';
import { textArrayLiteral } from '../write/pg-values.ts';

/** Where the erasure instruction came from. `agent_mcp` is deliberately absent. */
export type ErasureAuthority = 'app' | 'panel' | 'operator';

export interface SubjectCounts {
  readonly pages: number;
  readonly chunks: number;
  readonly facts: number;
  readonly entities: number;
  readonly entityCards: number;
  readonly commitments: number;
  readonly edges: number;
  /** Mid-confidence proposals quoting her. No foreign key, so nothing else sweeps them. */
  readonly reviewQueue: number;
  /** Attachment rows. The stored objects are counted on the receipt, separately. */
  readonly attachments: number;
  /** `page_version` snapshots, which the 72h purge cannot reach by design. */
  readonly versions: number;
}

const NOTHING: SubjectCounts = {
  pages: 0,
  chunks: 0,
  facts: 0,
  entities: 0,
  entityCards: 0,
  commitments: 0,
  edges: 0,
  reviewQueue: 0,
  attachments: 0,
  versions: 0,
};

export interface SubjectMatch {
  readonly pageId: string;
  readonly externalRef: string | null;
  /**
   * The page's own origin, which is half of its document key.
   *
   * `external_ref` carries no cross-origin uniqueness, so `page_version` keys on
   * `<origin>|<ref>` (`src/core/export/reconstruct.ts:docKeyFor`). Without the
   * origin here, this module could not name the snapshot rows belonging to the
   * page it is about to take.
   */
  readonly originContext: string;
  /** Which handle found it: the entity graph, or the identifier as text. */
  readonly handle: 'derivation' | 'text';
}

/** The tables a row-level match can come from. Pages are {@link SubjectMatch}. */
export type SubjectRowKind = 'fact' | 'commitment' | 'review_queue' | 'attachment' | 'page_version';

/**
 * One row the sweep will take, named rather than counted.
 *
 * This is what makes the module's stated mitigation — the controller reads the
 * preview before instructing — capable of seeing what it is authorising. A
 * `facts: 2` with no list is a number about somebody's records that nobody can
 * check.
 */
export interface SubjectRowMatch {
  readonly kind: SubjectRowKind;
  readonly id: string;
  /** The text that named her, truncated. What the controller reads. */
  readonly excerpt: string;
  /** Whether it goes because its page goes, or because its own text names her. */
  readonly handle: 'page' | 'text';
  /** `attachment` only: the key `storage.ts` recorded for the stored object. */
  readonly objectKey?: string;
}

/** Long enough to recognise a row, short enough that a preview stays readable. */
const EXCERPT_CHARACTERS = 300;

export interface SubjectErasurePreview {
  /** sha256 of the normalised identifier. The identifier itself is never stored. */
  readonly subjectDigest: string;
  /** The entities the identifier resolved to. Empty is a real, reportable answer. */
  readonly entityIds: readonly string[];
  /** Every surface form the sweep will match on: the identifier and its aliases. */
  readonly surfaceForms: readonly string[];
  readonly matches: readonly SubjectMatch[];
  /** Every non-page row the sweep will take, with the text that named her. */
  readonly rows: readonly SubjectRowMatch[];
  readonly removed: SubjectCounts;
  /** Rows that survive with a hole in their evidence. */
  readonly recomputed: SubjectCounts;
  readonly recomputeRequired: boolean;
}

/**
 * The tombstone key.
 *
 * Digest, never the identifier: keeping `alice@example.com` in a table whose
 * whole purpose is that we no longer hold anything about her is the failure
 * wearing the fix's clothes. Normalised first, through the write path's own
 * normalizer, so the comparison is the one the brain would have made.
 */
export function subjectDigest(identifier: string): string {
  return createHash('sha256').update(normalize(identifier)).digest('hex');
}

/**
 * What erasing this correspondent would take, and what it would invalidate.
 *
 * Read-only. The controller sees this before instructing, exactly as they see a
 * blast radius before a `forget`.
 */
export async function previewSubjectErasure(
  sql: SQL,
  request: { readonly identifier: string },
): Promise<SubjectErasurePreview> {
  const digest = subjectDigest(request.identifier);
  const normalized = normalize(request.identifier);

  const entities = (await sql`
    SELECT DISTINCT e.entity_id::text AS entity_id, e.canonical_name
      FROM entity e
      LEFT JOIN entity_slug s ON s.entity_id = e.entity_id
      LEFT JOIN entity_alias a ON a.entity_id = e.entity_id
     WHERE e.deleted_at IS NULL
       AND (s.slug = ${slugify(request.identifier)} OR lower(a.alias) = ${normalized})
     ORDER BY e.entity_id::text
  `) as Array<{ entity_id: string; canonical_name: string }>;

  const entityIds = entities.map((row) => row.entity_id);

  const aliases =
    entityIds.length === 0
      ? []
      : ((await sql`
          SELECT DISTINCT alias FROM entity_alias
           WHERE entity_id = ANY(${textArrayLiteral(entityIds)}::text[]::bigint[])
        `) as Array<{ alias: string }>).map((row) => row.alias);

  // The identifier itself, the entities' canonical names, and every alias the
  // brain knows for them. Deduplicated and non-empty by construction.
  const surfaceForms = [
    ...new Set(
      [request.identifier, ...entities.map((row) => row.canonical_name), ...aliases]
        .map((form) => form.trim())
        .filter((form) => form.length > 0),
    ),
  ];

  const patterns = surfaceForms.map(nameMatchPattern);
  const matches = await matchingPages(sql, entityIds, patterns);
  const rows = await matchingRows(sql, matches, patterns);
  const removed = await countRemoved(sql, entityIds, matches, rows);
  const recomputed = await countRecomputed(sql, entityIds, matches);

  return {
    subjectDigest: digest,
    entityIds,
    surfaceForms,
    matches,
    rows,
    removed,
    recomputed,
    recomputeRequired:
      recomputed.facts + recomputed.entityCards + recomputed.commitments + recomputed.edges > 0,
  };
}

/** Objects a caller can empty. The key derivation stays with the caller (R9). */
export interface SubjectObjectStore {
  delete(key: string): Promise<boolean>;
}

export interface SubjectErasureDeps {
  readonly sql: SQL;
  /**
   * The raw payload's object key for one external ref, or `null` when the
   * caller cannot derive one. **The caller derives it**, through
   * `src/ingest/import/raw.ts:rawKeyFor` and therefore through the one accessor
   * that may build a key — this module never constructs one (`src/README.md`).
   */
  readonly rawKeyOf?: (externalRef: string) => string | null;
  readonly objects?: SubjectObjectStore;
}

export interface SubjectErasureReceipt extends SubjectErasurePreview {
  readonly erasedBy: ErasureAuthority;
  readonly erasedAt: string;
  /** R2 raw payloads removed, and the ones the caller could not name. */
  readonly rawObjectsRemoved: number;
  readonly rawObjectsUnreachable: number;
  /**
   * Stored attachments removed, and the ones this run could not reach.
   *
   * Separate from the raw-payload counts because they are separate objects
   * under separate keys — the raw payload is the message as it arrived, the
   * attachment is the file that came with it, and for mail the second one is
   * usually where a signature or an address is. A run with no object store
   * reports every one of them as unreachable rather than reporting nothing.
   */
  readonly attachmentObjectsRemoved: number;
  readonly attachmentObjectsUnreachable: number;
  /** True once `erased_subject` carries this digest. */
  readonly reingestionTombstoned: boolean;
  /** The same bound account erasure states, and deliberately not a longer one. */
  readonly unrecoverableAfterDays: number;
}

/** Imported rather than re-declared: one number, two erasure paths. */
import { PITR_WINDOW_DAYS } from './erasure.ts';

/**
 * Erase one correspondent from a brain that stays live.
 *
 * Soft-deletes rather than hard-deletes, deliberately: the 72-hour TTL cascade
 * (`src/mcp/tombstone.ts`) already exists, already purges, and already carries
 * the recovery window a mistaken erasure needs. A hard delete here would be a
 * second deletion mechanism with different semantics for the highest-stakes
 * operation in the product — and it would make an erasure instructed against the
 * wrong `alice` unrecoverable within the same second it was issued.
 *
 * **The tombstone is written in the same transaction as the deletions.** An
 * erasure that removed the rows and failed to write the suppression row is an
 * erasure the next poll undoes, and the receipt would already have been handed
 * over.
 */
export async function eraseSubject(
  deps: SubjectErasureDeps,
  request: {
    readonly identifier: string;
    readonly erasedBy: ErasureAuthority;
    readonly now?: Date;
  },
): Promise<SubjectErasureReceipt> {
  const sql = deps.sql;
  const at = (request.now ?? new Date()).toISOString();

  // The preview runs **inside the transaction that does the deleting**, the same
  // way `severance.ts` re-runs its own: the receipt handed to a data subject has
  // to name what happened, not what a dialog rendered before a connector poll
  // landed. Every delete below is then keyed on the ids that preview enumerated,
  // so "what the receipt names" and "what went" are the same set by
  // construction rather than by two predicates agreeing.
  const preview = await sql.begin(async (tx) => {
    const inside = await previewSubjectErasure(tx as unknown as SQL, request);
    const pageIds = inside.matches.map((match) => match.pageId);
    const rowIds = (kind: SubjectRowKind): string[] =>
      inside.rows.filter((row) => row.kind === kind).map((row) => row.id);

    // Facts and commitments: the ones on a page that is going, and the ones
    // whose own text names her wherever they came from. Without the second the
    // person's card goes and every sentence about them keeps answering `recall`.
    const factIds = rowIds('fact');
    if (factIds.length > 0) {
      await tx`UPDATE fact SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL
                  AND fact_id = ANY(${textArrayLiteral(factIds)}::text[]::bigint[])`;
    }
    const commitmentIds = rowIds('commitment');
    if (commitmentIds.length > 0) {
      await tx`UPDATE commitment SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL
                  AND commitment_id = ANY(${textArrayLiteral(commitmentIds)}::text[]::bigint[])`;
    }
    const attachmentIds = rowIds('attachment');
    if (attachmentIds.length > 0) {
      await tx`UPDATE attachment SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL
                  AND attachment_id = ANY(${textArrayLiteral(attachmentIds)}::text[]::bigint[])`;
    }

    if (pageIds.length > 0) {
      const ids = textArrayLiteral(pageIds);
      await tx`UPDATE chunk SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND page_id = ANY(${ids}::text[]::bigint[])`;
      await tx`UPDATE page SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND page_id = ANY(${ids}::text[]::bigint[])`;
    }

    // The two tables the 72h purge cannot reach, and therefore the two this
    // erasure has to take outright. See the header: `page_version`'s foreign key
    // is ON DELETE SET NULL so history outlives a purge, and `review_queue`
    // carries no foreign key at all so it outlives what it quotes. A soft delete
    // in either is a row that sits verbatim for the life of the brain.
    const versionIds = rowIds('page_version');
    if (versionIds.length > 0) {
      await tx`DELETE FROM page_version
                WHERE version_id = ANY(${textArrayLiteral(versionIds)}::text[]::bigint[])`;
    }
    const proposalIds = rowIds('review_queue');
    if (proposalIds.length > 0) {
      await tx`DELETE FROM review_queue
                WHERE review_id = ANY(${textArrayLiteral(proposalIds)}::text[]::bigint[])`;
    }

    if (inside.entityIds.length > 0) {
      const ids = textArrayLiteral(inside.entityIds);
      await tx`UPDATE entity_card SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])`;
      await tx`DELETE FROM entity_edge
                WHERE subject_entity_id = ANY(${ids}::text[]::bigint[])
                   OR object_entity_id = ANY(${ids}::text[]::bigint[])`;
      // The entity is tombstoned rather than dropped, so a mis-targeted erasure
      // is recoverable for the same 72 hours everything else is. Its slug and
      // its aliases carry the identifier in plaintext and have no `deleted_at`
      // to set — they go when the purge takes the entity, through the same
      // `ON DELETE CASCADE` that has always held them, and the test purges for
      // real rather than asserting it here.
      //
      // **Recoverable, and deliberately NOT reachable from the account
      // holder's restore surface**, for two reasons that are worth stating
      // where the tombstone is written rather than only where the surface is:
      //
      //   * the account holder is not the party who requested this. An undo
      //     button on somebody else's erasure request is the wrong party
      //     reversing it, one click away, with no record of having been asked;
      //   * and `restoreForgotten` structurally *cannot* undo an erasure. It
      //     walks `TOMBSTONED_TABLES` and `ARCHIVED_TABLES` only, while this
      //     function hard-deleted `page_version`, `review_queue` and
      //     `entity_edge` above and is about to write a live suppression row.
      //     A restore would therefore return nonzero counts for a strict subset
      //     — a button that reports success for a recovery that did not happen.
      //
      // So the instant this stamps is absent from `listRestorable` by
      // construction (it writes no `retraction` row) and refused by the restore
      // port's membership gate. The surviving path is operator-mediated and
      // out of band: read the instant from `erased_subject.erased_at`, call
      // `restoreForgotten`, and delete the suppression row alongside it or the
      // next poll undoes the undo. That is the vocabulary the schema already
      // has — `erased_by IN ('app','panel','operator')`, with `agent_mcp`
      // deliberately absent.
      await tx`UPDATE entity SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])`;
    }

    // Same transaction as the deletions. An erasure that removed the rows and
    // failed to suppress re-ingestion is one the next poll silently undoes.
    await tx`
      INSERT INTO erased_subject (subject_digest, erased_at, erased_by,
                                  pages_removed, facts_removed, entities_removed, artifacts_recomputed)
      VALUES (${inside.subjectDigest}, ${at}::timestamptz, ${request.erasedBy},
              ${inside.removed.pages}, ${inside.removed.facts}, ${inside.removed.entities},
              ${inside.recomputed.facts + inside.recomputed.entityCards + inside.recomputed.commitments})
      ON CONFLICT (subject_digest) DO UPDATE
        SET erased_at = EXCLUDED.erased_at,
            erased_by = EXCLUDED.erased_by,
            pages_removed = erased_subject.pages_removed + EXCLUDED.pages_removed,
            facts_removed = erased_subject.facts_removed + EXCLUDED.facts_removed,
            entities_removed = erased_subject.entities_removed + EXCLUDED.entities_removed,
            artifacts_recomputed = erased_subject.artifacts_recomputed + EXCLUDED.artifacts_recomputed
    `;

    return inside;
  });

  let rawObjectsRemoved = 0;
  let rawObjectsUnreachable = 0;
  if (deps.objects !== undefined && deps.rawKeyOf !== undefined) {
    for (const match of preview.matches) {
      if (match.externalRef === null) continue;
      const key = deps.rawKeyOf(match.externalRef);
      if (key === null) {
        rawObjectsUnreachable += 1;
        continue;
      }
      if (await deps.objects.delete(key)) rawObjectsRemoved += 1;
    }
  } else {
    rawObjectsUnreachable = preview.matches.filter((match) => match.externalRef !== null).length;
  }

  // The attachment's object, under the key the row recorded. No key is derived
  // here — `storage.ts` derived it once, on the way in.
  const attachmentKeys = preview.rows.flatMap((row) =>
    row.kind === 'attachment' && row.objectKey !== undefined ? [row.objectKey] : [],
  );
  let attachmentObjectsRemoved = 0;
  let attachmentObjectsUnreachable = 0;
  if (deps.objects !== undefined) {
    for (const key of attachmentKeys) {
      if (await deps.objects.delete(key)) attachmentObjectsRemoved += 1;
      else attachmentObjectsUnreachable += 1;
    }
  } else {
    attachmentObjectsUnreachable = attachmentKeys.length;
  }

  const tombstoned = (await sql`
    SELECT 1 AS present FROM erased_subject WHERE subject_digest = ${preview.subjectDigest}
  `) as Array<{ present: number }>;

  return {
    ...preview,
    erasedBy: request.erasedBy,
    erasedAt: at,
    rawObjectsRemoved,
    rawObjectsUnreachable,
    attachmentObjectsRemoved,
    attachmentObjectsUnreachable,
    reingestionTombstoned: tombstoned.length === 1,
    unrecoverableAfterDays: PITR_WINDOW_DAYS,
  };
}

/**
 * Whether this brain has been instructed to hold nothing about this person.
 *
 * The pull path's question, and the only one that stops the next poll from
 * undoing an erasure. It takes the raw identifier and hashes it here, so no
 * caller has to know the tombstone stores a digest — and so no caller is
 * tempted to store the plaintext to compare against.
 */
export async function isErasedSubject(sql: SQL, identifier: string): Promise<boolean> {
  const erased = await erasedSubjects(sql, [identifier]);
  return erased.has(identifier);
}

/**
 * Which of these identifiers name somebody this brain was told to forget.
 *
 * **Batched because the caller is a mail poll**, not because a round trip is
 * expensive in the abstract. `partitionErasedSubjects` asked this question once
 * per *distinct correspondent in the listing*, sequentially, on a lane that runs
 * every five minutes — so a busy listing paid one round trip per person named
 * anywhere in it, every time, on a fleet whose database is a network hop away
 * rather than on localhost. The shape was invisible in tests because a fixture
 * listing names three people.
 *
 * **The hashing stays inside.** No caller learns that the tombstone stores a
 * digest rather than an address, which is the property the table exists for:
 * keeping `alice@example.test` in the table whose whole purpose is that this
 * brain no longer holds anything about her would be the failure wearing the
 * fix's clothes. Callers pass identifiers; they get identifiers back.
 */
export async function erasedSubjects(
  sql: SQL,
  identifiers: readonly string[],
): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  const distinct = [...new Set(identifiers)].filter((identifier) => identifier.length > 0);
  if (distinct.length === 0) return found;

  // Keyed back by digest, because that is all the answer carries.
  const byDigest = new Map<string, string>();
  for (const identifier of distinct) byDigest.set(subjectDigest(identifier), identifier);

  const digests = [...byDigest.keys()];
  for (let at = 0; at < digests.length; at += ERASURE_PROBE_BATCH) {
    const slice = digests.slice(at, at + ERASURE_PROBE_BATCH);
    const rows = (await sql.unsafe(
      `SELECT subject_digest FROM erased_subject WHERE subject_digest = ANY($1::text[])`,
      [textArrayLiteral(slice)],
    )) as Array<{ subject_digest: string }>;
    for (const row of rows) {
      const identifier = byDigest.get(row.subject_digest);
      if (identifier !== undefined) found.add(identifier);
    }
  }
  return found;
}

/**
 * Digests per probe.
 *
 * Bounded rather than unbounded so one pathological listing cannot bind an
 * array of arbitrary size; 500 is far above any real listing's distinct
 * correspondent count, so the ordinary case is exactly one statement.
 */
const ERASURE_PROBE_BATCH = 500;

async function matchingPages(
  sql: SQL,
  entityIds: readonly string[],
  patterns: readonly string[],
): Promise<SubjectMatch[]> {
  const matches = new Map<string, SubjectMatch>();

  // The text handle. Title or passage — a mail whose body names them and whose
  // subject line does not is the ordinary case. One statement over every form,
  // in the same shape the row sweep and the counts use, so the three cannot
  // drift into disagreeing about what "names her" means.
  const literal = textArrayLiteral([...patterns]);
  const rows = (await sql`
      SELECT DISTINCT p.page_id::text AS page_id, p.external_ref, p.origin_context
        FROM page p
        LEFT JOIN chunk c ON c.page_id = p.page_id AND c.deleted_at IS NULL
       WHERE p.deleted_at IS NULL
         AND (coalesce(p.title, '') ~* ANY(${literal}::text[])
              OR c.content ~* ANY(${literal}::text[]))
    `) as Array<{ page_id: string; external_ref: string | null; origin_context: string }>;
  for (const row of rows) {
    if (!matches.has(row.page_id)) {
      matches.set(row.page_id, {
        pageId: row.page_id,
        externalRef: row.external_ref,
        // Carried because a document key folds the origin in — see `docKeysOf`.
        originContext: row.origin_context,
        handle: 'text',
      });
    }
  }

  // **There is deliberately no page-discovery arm here for the entity graph, and
  // the reason is a hazard rather than an omission.** The schema has no
  // structural edge from a fact to the entity it is about: `fact_source` reaches
  // chunks, `entity_edge` reaches entities, and nothing joins the two. The
  // tempting proxy is to walk `entity_edge` and match facts whose origins
  // overlap the edge's — and it is catastrophically wrong, in the *ordinary*
  // shape rather than an exotic one. In a single-origin brain (every row
  // `personal`, which is what an alpha tenant looks like) every fact's origins
  // overlap every edge's, so once the subject has one edge the arm matches every
  // fact-bearing page in the brain and the erasure deletes it. Origin overlap is
  // a fence, not a derivation edge.
  //
  // So page discovery is the text handle, and the entity subtree below is
  // reached directly by id. The limit that leaves — a page that mentions the
  // correspondent, from which no fact was extracted, and which contains neither
  // the identifier nor any known alias as text — is stated in this module's
  // header rather than papered over with a proxy that over-matches. The
  // `handle` field stays on {@link SubjectMatch} for the day a structural link
  // exists; until then every match is honestly `text`.
  void entityIds;

  return [...matches.values()].sort((left, right) => Number(left.pageId) - Number(right.pageId));
}

/**
 * The document keys a snapshot of this page could have been banked under.
 *
 * **Two, and the second one is compatibility rather than belt-and-braces.**
 * `docKeyFor` is the constructor — `<origin>|<external_ref>`, or
 * `<origin>|page:<id>` for a page with no upstream id — and it is *imported*
 * rather than restated, so this module and `versions.ts` cannot come to disagree
 * about what a document key is. The bare ref is the shape keys had before the
 * origin was folded in, and those rows cannot be rewritten: the ladder's
 * expand-only rule refuses a contracting `UPDATE` (`src/control/migrate.ts`),
 * so a pre-fold snapshot is still sitting under the bare key. Dropping it from
 * this list would leave that snapshot behind on an erasure — a copy of her mail
 * in the one table the 72h purge cannot reach — which is the worst possible
 * place to be precise at the cost of being complete.
 *
 * The bare arm inherits the reach the whole sweep had before the fold: it also
 * matches another origin's snapshot of the same ref. That is unchanged behaviour
 * rather than new, and it errs toward removing more of an erased correspondent
 * rather than less.
 */
function docKeysOf(match: SubjectMatch): string[] {
  const folded = docKeyFor({
    originContext: match.originContext,
    pageId: match.pageId,
    externalRef: match.externalRef,
  });
  const legacy = match.externalRef === null ? `page:${match.pageId}` : match.externalRef;
  return [folded, legacy];
}

/**
 * Every non-page row the sweep will take, named.
 *
 * One query per table and one predicate shape across all of them, because the
 * counts on the receipt are derived from *this list* rather than recomputed by a
 * second statement. Two predicates that were supposed to agree is the failure
 * this list exists to close.
 */
async function matchingRows(
  sql: SQL,
  matches: readonly SubjectMatch[],
  patterns: readonly string[],
): Promise<SubjectRowMatch[]> {
  const pages = textArrayLiteral(matches.map((match) => match.pageId));
  const docKeys = textArrayLiteral(matches.flatMap(docKeysOf));
  const pats = textArrayLiteral([...patterns]);
  const found: SubjectRowMatch[] = [];

  const facts = (await sql`
    SELECT fact_id::text AS id, left(statement, ${EXCERPT_CHARACTERS}) AS excerpt,
           coalesce(page_id = ANY(${pages}::text[]::bigint[]), false) AS by_page
      FROM fact
     WHERE deleted_at IS NULL
       AND (page_id = ANY(${pages}::text[]::bigint[]) OR statement ~* ANY(${pats}::text[]))
     ORDER BY fact_id
  `) as Array<{ id: string; excerpt: string; by_page: boolean }>;
  for (const row of facts) {
    found.push({ kind: 'fact', id: row.id, excerpt: row.excerpt, handle: row.by_page ? 'page' : 'text' });
  }

  // Commitments are matched on their own text only, never by page. A commitment
  // on a page that is going has lost a source rather than been about her, and
  // `countRecomputed` is where that lands — deleting it here would erase one
  // user's obligations because a correspondent asked about another's.
  const commitments = (await sql`
    SELECT commitment_id::text AS id,
           left(coalesce(owner_name || ': ', '') || statement, ${EXCERPT_CHARACTERS}) AS excerpt
      FROM commitment
     WHERE deleted_at IS NULL
       AND (statement ~* ANY(${pats}::text[]) OR coalesce(owner_name, '') ~* ANY(${pats}::text[]))
     ORDER BY commitment_id
  `) as Array<{ id: string; excerpt: string }>;
  for (const row of commitments) {
    found.push({ kind: 'commitment', id: row.id, excerpt: row.excerpt, handle: 'text' });
  }

  // Every state, not just `open`: an applied proposal quotes her identically.
  const proposals = (await sql`
    SELECT review_id::text AS id, left(proposal, ${EXCERPT_CHARACTERS}) AS excerpt
      FROM review_queue
     WHERE proposal ~* ANY(${pats}::text[])
     ORDER BY review_id
  `) as Array<{ id: string; excerpt: string }>;
  for (const row of proposals) {
    found.push({ kind: 'review_queue', id: row.id, excerpt: row.excerpt, handle: 'text' });
  }

  // The OCR arm matters on its own: `matchingPages` never reads `ocr_text`, so a
  // scan of a signed letter attached to a message that does not spell her name
  // is reachable no other way.
  const attachments = (await sql`
    SELECT attachment_id::text AS id, object_key,
           left(coalesce(nullif(btrim(ocr_text), ''), object_key), ${EXCERPT_CHARACTERS}) AS excerpt,
           coalesce(page_id = ANY(${pages}::text[]::bigint[]), false) AS by_page
      FROM attachment
     WHERE deleted_at IS NULL
       AND (page_id = ANY(${pages}::text[]::bigint[])
            OR coalesce(ocr_text, '') ~* ANY(${pats}::text[]))
     ORDER BY attachment_id
  `) as Array<{ id: string; object_key: string; excerpt: string; by_page: boolean }>;
  for (const row of attachments) {
    found.push({
      kind: 'attachment',
      id: row.id,
      excerpt: row.excerpt,
      handle: row.by_page ? 'page' : 'text',
      objectKey: row.object_key,
    });
  }

  // Both arms, and the second is the one that matters: a document *edited* after
  // its snapshot was banked has a live page that no longer names her, so the
  // document-key arm alone reaches nothing and her mail stays in the history.
  const versions = (await sql`
    SELECT version_id::text AS id,
           left(coalesce(title || ' — ', '') || body, ${EXCERPT_CHARACTERS}) AS excerpt,
           (doc_key = ANY(${docKeys}::text[])) AS by_page
      FROM page_version
     WHERE doc_key = ANY(${docKeys}::text[])
        OR coalesce(title, '') ~* ANY(${pats}::text[])
        OR body ~* ANY(${pats}::text[])
     ORDER BY version_id
  `) as Array<{ id: string; excerpt: string; by_page: boolean }>;
  for (const row of versions) {
    found.push({
      kind: 'page_version',
      id: row.id,
      excerpt: row.excerpt,
      handle: row.by_page ? 'page' : 'text',
    });
  }

  return found;
}

async function countRemoved(
  sql: SQL,
  entityIds: readonly string[],
  matches: readonly SubjectMatch[],
  rows: readonly SubjectRowMatch[],
): Promise<SubjectCounts> {
  // Derived from the enumerated list, never from a second predicate: a count
  // nobody can inspect is what the preview exists to stop being.
  const counted = (kind: SubjectRowKind): number => rows.filter((row) => row.kind === kind).length;
  const listed = {
    facts: counted('fact'),
    commitments: counted('commitment'),
    reviewQueue: counted('review_queue'),
    attachments: counted('attachment'),
    versions: counted('page_version'),
  };

  if (matches.length === 0 && entityIds.length === 0) return { ...NOTHING, ...listed };

  const pageIds = textArrayLiteral(matches.map((match) => match.pageId));
  const ids = textArrayLiteral(entityIds);

  const counts = (await sql`
    SELECT
      (SELECT count(*)::int FROM page
        WHERE deleted_at IS NULL AND page_id = ANY(${pageIds}::text[]::bigint[])) AS pages,
      (SELECT count(*)::int FROM chunk
        WHERE deleted_at IS NULL AND page_id = ANY(${pageIds}::text[]::bigint[])) AS chunks,
      (SELECT count(*)::int FROM entity
        WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])) AS entities,
      (SELECT count(*)::int FROM entity_card
        WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])) AS entity_cards,
      (SELECT count(*)::int FROM entity_edge
        WHERE subject_entity_id = ANY(${ids}::text[]::bigint[])
           OR object_entity_id = ANY(${ids}::text[]::bigint[])) AS edges
  `) as Array<Record<string, number>>;

  return { ...shape(counts[0]), ...listed };
}

/**
 * Rows that survive and are no longer correct.
 *
 * Two shapes, and both are derivation losing an input rather than losing a row:
 * a surviving fact one of whose source chunks is going, and a surviving
 * entity's card where an edge to the erased person is going. Neither is deleted
 * by this erasure and neither can be trusted until a cycle re-derives it.
 */
async function countRecomputed(
  sql: SQL,
  entityIds: readonly string[],
  matches: readonly SubjectMatch[],
): Promise<SubjectCounts> {
  if (matches.length === 0 && entityIds.length === 0) return NOTHING;

  const pageIds = textArrayLiteral(matches.map((match) => match.pageId));
  const ids = textArrayLiteral(entityIds);

  const rows = (await sql`
    SELECT
      0 AS pages, 0 AS chunks, 0 AS entities, 0 AS edges,
      (SELECT count(DISTINCT f.fact_id)::int FROM fact f
         JOIN fact_source fs ON fs.fact_id = f.fact_id
         JOIN chunk c ON c.chunk_id = fs.chunk_id
        WHERE f.deleted_at IS NULL
          AND NOT (f.page_id = ANY(${pageIds}::text[]::bigint[]))
          AND c.page_id = ANY(${pageIds}::text[]::bigint[])) AS facts,
      (SELECT count(DISTINCT card.card_id)::int FROM entity_card card
         JOIN entity_edge e
           ON e.subject_entity_id = card.entity_id OR e.object_entity_id = card.entity_id
        WHERE card.deleted_at IS NULL
          AND NOT (card.entity_id = ANY(${ids}::text[]::bigint[]))
          AND (e.subject_entity_id = ANY(${ids}::text[]::bigint[])
               OR e.object_entity_id = ANY(${ids}::text[]::bigint[]))) AS entity_cards,
      (SELECT count(*)::int FROM commitment c
        WHERE c.deleted_at IS NULL
          AND c.page_id = ANY(${pageIds}::text[]::bigint[])) AS commitments
  `) as Array<Record<string, number>>;

  return shape(rows[0]);
}

function shape(row: Record<string, number> | undefined): SubjectCounts {
  const source = row ?? {};
  return {
    pages: Number(source.pages ?? 0),
    chunks: Number(source.chunks ?? 0),
    facts: Number(source.facts ?? 0),
    entities: Number(source.entities ?? 0),
    entityCards: Number(source.entity_cards ?? 0),
    commitments: Number(source.commitments ?? 0),
    edges: Number(source.edges ?? 0),
    reviewQueue: Number(source.review_queue ?? 0),
    attachments: Number(source.attachments ?? 0),
    versions: Number(source.versions ?? 0),
  };
}

/**
 * One surface form as a Postgres regular expression that matches **the name**.
 *
 * Two halves, and both are load-bearing:
 *
 *   1. **Regex escaping, not LIKE escaping.** The old sweep escaped `%` and `_`,
 *      which is right for `ILIKE` and leaves `.`, `+`, `(` and `|` live in a
 *      regex — an identifier `J.P.` would then match `JXPX`, and a name
 *      containing `|` would match either half of itself across every row in the
 *      brain. Only the POSIX ARE metacharacters are escaped, deliberately not
 *      every non-alphanumeric: `\` before a *non-ASCII letter* is not a defined
 *      escape and Postgres rejects the pattern outright.
 *   2. **Word boundaries where the form has a word edge.** `\m` and `\M` assert
 *      the start and end of a word, so `al` reaches the person called Al and not
 *      `legal`, `Alvarez`, `renewal` or `Alberta`. They are applied only when
 *      the form actually begins or ends with an ASCII word character — a form
 *      starting with `@` or an accented letter gets no assertion at that end and
 *      falls back to substring matching there, which is *wider*. That direction
 *      is chosen: a sweep that matches too much is caught by the controller
 *      reading {@link SubjectErasurePreview.rows}, and one that matches too
 *      little is an erasure that silently did not happen.
 */

