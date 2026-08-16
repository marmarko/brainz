/**
 * `remember` and document ingestion — the two entry points, over one pipeline.
 *
 * **The sync/async split is this module's contract with its caller**, and
 * `phases.ts` states it. What must be true before the call returns: the page,
 * its chunks, its facts (each with a vector, because `fact.embedding` is `NOT
 * NULL`), its entities and its edges are committed, and the dedup verdict has
 * been made. What may complete later: chunk embedding, whose backlog is a query
 * over the rows (`embedding IS NULL`) rather than a promise held by this
 * process — so a crash between the commit and the backfill resumes instead of
 * losing the write.
 *
 * **Everything expensive happens before the transaction opens.** Chunking,
 * extraction, the one embedding call and the dedup lookup all run on the plain
 * connection; the transaction that follows is pure SQL. A provider round-trip
 * inside an open write transaction holds locks for the length of somebody
 * else's network, and under a pooled connection that is how a slow provider
 * becomes a database outage.
 *
 * **A failed embed writes nothing at all.** Not "writes the page and retries
 * the facts later" — the facts *are* the classifier input, and a page whose
 * facts silently never arrived is indistinguishable from a page that stated
 * none. The call fails typed and the caller retries.
 *
 * **KTD9's provision-time decisions are read, never assumed.** The taxonomy
 * version comes from `tenant_setting`, so a tenant re-classified to version 3
 * stamps 3 rather than the column default — the same class of mistake as an
 * English-default FTS config on a Spanish brain, one table over.
 *
 * **R16's substrate parts, minus the classifier.** Ingestion is idempotent on
 * (external ref, content digest) and costs zero provider calls when nothing
 * changed; a changed digest tombstones the previous page and reconciles rather
 * than accumulating, so an edited document's superseded chunks stop ranking;
 * every page can name the ingest run that fetched it; and a page the caller
 * marks as junk is written but never embedded. **The junk classifier itself is
 * U9's** — this module owns the seam it plugs into, which is the half that has
 * to exist first.
 */

import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import type { Budget, ModelGateway } from '../../ai/gateway.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import { EMBEDDING_DIMENSIONS } from '../../schema/vector-index.ts';
import { CHUNKER_VERSION, chunkDocument, type Chunk } from './chunker.ts';
import { classifyStatement, type DedupVerdict, type WriteStatus } from './dedup.ts';
import { embedTexts, knownEmbeddingModelFor, vectorLiteral } from './embed.ts';
import { extractFacts, extractFromStatement, type ExtractedFact } from './extract.ts';
import { NORMALIZER_VERSION } from './normalize.ts';
import { textArrayLiteral } from './pg-values.ts';
import { createPhaseRecorder, type SyncPhase } from './phases.ts';
import { reconcileEdges } from './links.ts';

/** `page_source_type_is_known`, restated so a bad value is refused before the
 * write rather than at the last statement of the transaction. */
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

export interface WriteContext {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget: Budget;
}

export type WriteFailureReason =
  | 'empty_document'
  | 'unknown_source_type'
  | 'origin_missing'
  | 'tenant_not_configured'
  | 'embed_failed'
  /**
   * Nothing was encoded — a document that stated no facts — and the gateway's
   * profile is not one this process can look a model up by name. There is no
   * honest value for `page.embedding_model`, and KTD8's fleet re-embed selects
   * on exactly that column, so a guess would take a page out of the set that
   * gets fixed. Typed, because every other refusal on this path is.
   */
  | 'embedding_model_unknown';

export interface WriteFailure {
  readonly ok: false;
  readonly reason: WriteFailureReason;
  /** The gateway's own typed reason, when the failure came from there. */
  readonly detail?: string;
}

export interface DocumentInput {
  /** Credential-derived and immutable once written (R15). */
  readonly originContext: string;
  readonly sourceType: SourceType;
  readonly title?: string | null;
  readonly body: string;
  /** The provider's own id for the item, and the idempotency key with the digest. */
  readonly externalRef?: string | null;
  readonly ingestId?: string | null;
  /**
   * When the thing happened, as the *provider* asserted it — a calendar event's
   * start, a message's `Date`, a file's `modifiedTime`. Absent means the source
   * did not say, which readers spell `coalesce(occurred_at, created_at)`.
   *
   * **Content, not provenance.** An outside sender chooses this value exactly as
   * they choose a subject line, so it may order and window and it may decide
   * nothing else: not visibility, not corroboration, and never access — the fence
   * reads `origin_context`, which is credential-derived and immutable. Rung 5's
   * header carries the full statement.
   *
   * It is deliberately **not** part of {@link contentDigest}: a provider that
   * re-states an unchanged event with a jittered timestamp would otherwise
   * re-chunk and re-embed the whole page every poll.
   */
  readonly occurredAt?: Date | null;
  /** Inferred, mutable, confidence-scored — R15's other half. */
  readonly subject?: { readonly context: string; readonly confidence: number } | null;
  /**
   * The junk gate's verdict (R16). Any non-empty marker quarantines the page:
   * it is stored, hidden from reads, and never embedded. **U9 owns the
   * classifier**; what lives here is the seam and the structural guarantee that
   * a quarantined row costs no provider call.
   */
  readonly quarantine?: string | null;
}

export interface FactReceipt {
  readonly factId: string;
  readonly status: WriteStatus;
}

export interface DocumentReceipt {
  readonly ok: true;
  /** `unchanged` costs nothing; `replaced` tombstoned a previous version. */
  readonly status: 'written' | 'unchanged' | 'replaced';
  readonly pageId: string;
  readonly chunkCount: number;
  readonly facts: readonly FactReceipt[];
  readonly deferred: { readonly chunkEmbeddings: number };
  readonly phases: readonly SyncPhase[];
}

export interface RememberInput {
  readonly originContext: string;
  readonly statement: string;
  readonly sourceType?: SourceType;
  readonly title?: string | null;
  readonly subject?: { readonly context: string; readonly confidence: number } | null;
}

export interface RememberReceipt {
  readonly ok: true;
  /** The frozen contract: on `duplicate` this is the EXISTING fact's id. */
  readonly id: string;
  readonly status: WriteStatus;
  /** Null when nothing was written, which is what `duplicate` means. */
  readonly pageId: string | null;
  readonly deferred: { readonly chunkEmbeddings: number };
  readonly phases: readonly SyncPhase[];
}

interface TenantSettings {
  readonly ftsLanguage: string;
  readonly taxonomyVersion: number;
}

async function readTenantSettings(sql: SQL): Promise<TenantSettings | null> {
  const rows = (await sql`
    SELECT fts_language, taxonomy_version FROM tenant_setting LIMIT 1
  `) as Array<{ fts_language: string; taxonomy_version: number }>;
  const row = rows[0];
  if (row === undefined) return null;
  return { ftsLanguage: row.fts_language, taxonomyVersion: row.taxonomy_version };
}

/** `page.content_sha256`: the idempotency key's other half. Title included,
 * because a retitled document is a changed document to every reader. */
export function contentDigest(title: string | null | undefined, body: string): string {
  return createHash('sha256').update(`${title ?? ''}\n${body}`).digest('hex');
}

interface ExistingPage {
  readonly pageId: string;
  readonly contentSha256: string;
  readonly chunkCount: number;
  /** Whether the stored page is hidden. Half of the idempotency question. */
  readonly quarantined: boolean;
}

/**
 * The page this write replaces — **within this credential's origin, never across
 * it.**
 *
 * `external_ref` is the provider's own id, and nothing makes it unique across
 * origins: the schema carries no unique index on it, and two credentials
 * legitimately fetch the same object — a shared calendar event pulled by both a
 * work connector and a personal one is the ordinary case, not an edge one.
 * Keyed on the ref alone this lookup returns the *other* origin's page, and the
 * caller then tombstones it and writes its own in its place: a cross-origin
 * delete-and-replace performed above every fence, so no fence is consulted and
 * nothing reports it. The sibling retirement path (`ingest/pipedream/tombstone.ts`)
 * already fences on origin for exactly this reason; this is the half that did not.
 *
 * The narrowing costs nothing an operator would notice: a poller re-reading its
 * own items still finds its own row, because its own row is the one at its own
 * origin.
 */
async function livePageByRef(
  sql: SQL,
  externalRef: string,
  originContext: string,
): Promise<ExistingPage | null> {
  const rows = (await sql`
    SELECT p.page_id::text AS page_id, p.content_sha256,
           (p.quarantined_at IS NOT NULL) AS quarantined,
           (SELECT count(*)::int FROM chunk c WHERE c.page_id = p.page_id AND c.deleted_at IS NULL) AS chunks
      FROM page p
     WHERE p.external_ref = ${externalRef}
       AND p.origin_context = ${originContext}
       AND p.deleted_at IS NULL
     ORDER BY p.page_id DESC
     LIMIT 1
  `) as Array<{ page_id: string; content_sha256: string; quarantined: boolean; chunks: number }>;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        pageId: row.page_id,
        contentSha256: row.content_sha256,
        chunkCount: row.chunks,
        quarantined: row.quarantined,
      };
}

async function liveFactStatements(db: SQL, pageId: string): Promise<string[]> {
  const rows = (await db`
    SELECT statement FROM fact
     WHERE page_id = ${pageId}::bigint
       AND deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
  `) as Array<{ statement: string }>;
  return rows.map((row) => row.statement);
}

function fail(reason: WriteFailureReason, detail?: string): WriteFailure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * One item, on the run that fetched it. Every outcome an ingest run can have
 * for an item passes through here, so "seen" cannot come to mean "written"
 * again by a path that forgot to count itself.
 *
 * Outside the write transaction, deliberately: a counter is not worth holding
 * a lock across, and a run whose count is one short is a smaller problem than a
 * write that rolled back because its bookkeeping did.
 */
async function countIngestItem(
  sql: SQL,
  ingestId: string | null,
  item: { readonly written: number; readonly quarantined: number },
): Promise<void> {
  if (ingestId === null) return;
  await sql`
    UPDATE ingest_log
       SET items_seen = items_seen + 1,
           items_written = items_written + ${item.written},
           items_quarantined = items_quarantined + ${item.quarantined}
     WHERE ingest_id = ${ingestId}::bigint
  `;
}

interface CommitPlan {
  readonly origin: string;
  readonly sourceType: SourceType;
  readonly title: string | null;
  readonly externalRef: string | null;
  readonly ingestId: string | null;
  readonly subject: { readonly context: string; readonly confidence: number } | null;
  readonly quarantined: boolean;
  readonly occurredAt: Date | null;
  readonly digest: string;
  readonly chunks: readonly Chunk[];
  readonly facts: readonly ExtractedFact[];
  readonly vectors: ReadonlyArray<readonly number[]>;
  readonly verdicts: readonly DedupVerdict[];
  readonly settings: TenantSettings;
  readonly modelId: string;
  readonly replaces: string | null;
}

interface CommitOutcome {
  readonly pageId: string;
  readonly chunkCount: number;
  readonly facts: readonly FactReceipt[];
}

/**
 * The whole write, in one transaction and with no provider call inside it.
 *
 * Order is load-bearing at one point: the previous version's facts are read and
 * then tombstoned **before** {@link reconcileEdges} runs, because reconciliation
 * asks "is this edge still implied by a live fact" and that question has to be
 * asked of the state the write is leaving behind, not the one it found.
 */
async function commitWrite(
  sql: SQL,
  plan: CommitPlan,
  phases: { enter(phase: SyncPhase): void },
): Promise<CommitOutcome> {
  const outcome = (await sql.begin(async (tx) => {
    const previousStatements =
      plan.replaces === null ? [] : await liveFactStatements(tx, plan.replaces);

    if (plan.replaces !== null) {
      await tx`UPDATE fact SET deleted_at = now() WHERE page_id = ${plan.replaces}::bigint AND deleted_at IS NULL`;
      await tx`UPDATE chunk SET deleted_at = now() WHERE page_id = ${plan.replaces}::bigint AND deleted_at IS NULL`;
      await tx`UPDATE page SET deleted_at = now() WHERE page_id = ${plan.replaces}::bigint`;
    }

    const pageRows = (await tx`
      INSERT INTO page (origin_context, subject_context, subject_confidence, source_type,
                        external_ref, ingest_id, title, taxonomy_version, occurred_at,
                        embedding_model, embedding_dimensions, chunker_version,
                        normalizer_version, content_sha256, quarantined_at)
      VALUES (${plan.origin}, ${plan.subject?.context ?? null}, ${plan.subject?.confidence ?? null},
              ${plan.sourceType}, ${plan.externalRef}, ${plan.ingestId}::bigint, ${plan.title},
              ${plan.settings.taxonomyVersion}, ${plan.occurredAt},
              ${plan.modelId}, ${EMBEDDING_DIMENSIONS},
              ${CHUNKER_VERSION}, ${NORMALIZER_VERSION}, ${plan.digest},
              ${plan.quarantined ? new Date() : null})
      RETURNING page_id::text AS page_id
    `) as Array<{ page_id: string }>;
    const pageId = pageRows[0]?.page_id;
    if (pageId === undefined) throw new Error('page insert returned no id');

    const chunkIds: string[] = [];
    for (const chunk of plan.chunks) {
      const rows = (await tx`
        INSERT INTO chunk (origin_context, subject_context, subject_confidence, content,
                           page_id, ordinal, quarantined_at)
        VALUES (${plan.origin}, ${plan.subject?.context ?? null}, ${plan.subject?.confidence ?? null},
                ${chunk.content}, ${pageId}::bigint, ${chunk.ordinal},
                ${plan.quarantined ? new Date() : null})
        RETURNING chunk_id::text AS chunk_id
      `) as Array<{ chunk_id: string }>;
      const chunkId = rows[0]?.chunk_id;
      if (chunkId === undefined) throw new Error('chunk insert returned no id');
      chunkIds.push(chunkId);
    }

    const receipts: FactReceipt[] = [];
    const written: ExtractedFact[] = [];
    // Statements this write retired. A supersession is a claim going stale
    // exactly as a page edit is, and the edges it implied have to be
    // reconsidered — but it arrives on a *different* page, so nothing in
    // `previousStatements` would otherwise mention it. Without this, correcting
    // a fact through `remember` leaves the old fact's edge live and the graph
    // answers with both jobs.
    const retired: string[] = [];

    for (const [index, fact] of plan.facts.entries()) {
      const verdict = plan.verdicts[index];
      const vector = plan.vectors[index];
      if (verdict === undefined || vector === undefined) continue;

      if (verdict.status === 'duplicate') {
        // The brain already holds this claim; the page is still written, so the
        // chunk that states it is retrievable, but the fact is not doubled.
        receipts.push({ factId: verdict.matchedFactId ?? '', status: 'duplicate' });
        written.push(fact);
        continue;
      }

      const rows = (await tx`
        INSERT INTO fact (page_id, statement, embedding, origin_contexts, confidence, taxonomy_version)
        VALUES (${pageId}::bigint, ${fact.statement}, ${vectorLiteral(vector)}::vector,
                ${textArrayLiteral([plan.origin])}::text[], ${fact.confidence}, ${plan.settings.taxonomyVersion})
        RETURNING fact_id::text AS fact_id
      `) as Array<{ fact_id: string }>;
      const factId = rows[0]?.fact_id;
      if (factId === undefined) throw new Error('fact insert returned no id');

      for (const ordinal of fact.chunkOrdinals) {
        const chunkId = chunkIds[ordinal];
        if (chunkId === undefined) continue;
        await tx`
          INSERT INTO fact_source (fact_id, chunk_id)
          VALUES (${factId}::bigint, ${chunkId}::bigint)
          ON CONFLICT DO NOTHING
        `;
      }

      if (verdict.status === 'superseded' && verdict.matchedFactId !== null) {
        // Supersession rather than rewriting: origin is immutable, so a claim
        // whose value changed is a new row pointing back at the old one.
        const supersededRows = (await tx`
          UPDATE fact SET superseded_by = ${factId}::bigint
           WHERE fact_id = ${verdict.matchedFactId}::bigint AND superseded_by IS NULL
          RETURNING statement
        `) as Array<{ statement: string }>;
        for (const row of supersededRows) retired.push(row.statement);
      }

      receipts.push({ factId, status: verdict.status });
      written.push(fact);
    }

    await reconcileEdges(tx, {
      facts: written,
      previousStatements: [...previousStatements, ...retired],
      origins: [plan.origin],
      taxonomyVersion: plan.settings.taxonomyVersion,
      onPhase: (phase) => phases.enter(phase),
    });

    return { value: { pageId, chunkCount: chunkIds.length, facts: receipts } };
  })) as { value: CommitOutcome };

  return outcome.value;
}

export async function ingestDocument(
  ctx: WriteContext,
  input: DocumentInput,
): Promise<DocumentReceipt | WriteFailure> {
  const phases = createPhaseRecorder();
  phases.enter('normalize');

  if (!(SOURCE_TYPES as readonly string[]).includes(input.sourceType)) {
    return fail('unknown_source_type');
  }
  const origin = input.originContext.trim();
  if (origin.length === 0) return fail('origin_missing');

  const settings = await readTenantSettings(ctx.sql);
  if (settings === null) return fail('tenant_not_configured');

  const digest = contentDigest(input.title, input.body);
  const externalRef = input.externalRef ?? null;
  const existing = externalRef === null ? null : await livePageByRef(ctx.sql, externalRef, origin);
  const quarantined = (input.quarantine ?? '').trim().length > 0;

  // **The digest is not the whole idempotency key; the verdict is the rest of
  // it.** The junk verdict is reached from headers and labels, and the digest
  // covers title and body — so a message re-classified between two pulls has an
  // identical digest and a different visibility. Taking the unchanged shortcut
  // on the digest alone makes the classification a one-way door: a page hidden
  // once is hidden forever, its chunks never enter the embedding backlog, and
  // the user's mail is unrecallable with no error anywhere. The reverse leaks
  // just as quietly. A moved verdict therefore falls through and rewrites,
  // which the receipt reports as `replaced`.
  if (existing !== null && existing.contentSha256 === digest && existing.quarantined === quarantined) {
    // Idempotency, and it has to cost nothing: a poller re-reads the same items
    // on every cadence, and paying an embedding call for each is the whole
    // difference between a connector and a bill.
    //
    // It still counts as an item the run *saw*. That is the denominator an
    // operator reads a connector's health out of, and this is a poller's most
    // common outcome by a wide margin — so a counter that only advances when a
    // row was written reports a run that saw nothing on the day it worked, and
    // makes `items_seen` and `items_written` the same number forever.
    await countIngestItem(ctx.sql, input.ingestId ?? null, { written: 0, quarantined: 0 });
    return {
      ok: true,
      status: 'unchanged',
      pageId: existing.pageId,
      chunkCount: existing.chunkCount,
      facts: [],
      deferred: { chunkEmbeddings: 0 },
      phases: phases.ran,
    };
  }

  phases.enter('chunk');
  const chunks = chunkDocument(input.body);
  if (chunks.length === 0) return fail('empty_document');

  phases.enter('extract');
  // A quarantined page contributes no facts, no entities and no edges: junk
  // that reaches the graph is junk every later phase reasons over.
  const facts = quarantined ? [] : extractFacts(chunks);

  phases.enter('embed_facts');
  const embedded = await embedTexts({
    gateway: ctx.gateway,
    tenantId: ctx.tenantId,
    caller: ctx.caller,
    budget: ctx.budget,
    texts: facts.map((fact) => fact.statement),
  });
  if (!embedded.ok) return fail('embed_failed', embedded.reason);

  phases.enter('dedup');
  const verdicts: DedupVerdict[] = [];
  for (const [index, fact] of facts.entries()) {
    const vector = embedded.vectors[index];
    if (vector === undefined) return fail('embed_failed', 'embedding_count_mismatch');
    verdicts.push(
      await classifyStatement(ctx.sql, {
        statement: fact.statement,
        vector,
        origin,
        // The page being rewritten is not "what the brain already knows": its
        // own previous facts must not make its new ones duplicates of rows this
        // write is about to tombstone.
        excludePageId: existing === null ? null : existing.pageId,
      }),
    );
  }

  // What the gateway says it called, never a re-derivation from its profile's
  // *name*: the two agree only for the shipped profiles, and the fallback is
  // reached solely when nothing was encoded.
  const modelId = embedded.modelId ?? knownEmbeddingModelFor(ctx.gateway.profileName);
  if (modelId === null) return fail('embedding_model_unknown');

  const outcome = await commitWrite(
    ctx.sql,
    {
      origin,
      sourceType: input.sourceType,
      title: input.title ?? null,
      externalRef,
      ingestId: input.ingestId ?? null,
      subject: input.subject ?? null,
      quarantined,
      occurredAt: input.occurredAt ?? null,
      digest,
      chunks,
      facts,
      vectors: embedded.vectors,
      verdicts,
      settings,
      modelId,
      replaces: existing === null ? null : existing.pageId,
    },
    phases,
  );

  phases.enter('commit');
  phases.assertComplete();

  await countIngestItem(ctx.sql, input.ingestId ?? null, {
    written: quarantined ? 0 : 1,
    quarantined: quarantined ? 1 : 0,
  });

  return {
    ok: true,
    status: existing === null ? 'written' : 'replaced',
    pageId: outcome.pageId,
    chunkCount: outcome.chunkCount,
    facts: outcome.facts,
    // Quarantined chunks are never embedded, so they are not deferred work —
    // they are work that will never happen, and saying otherwise would put a
    // backlog number on a queue nothing drains.
    deferred: { chunkEmbeddings: quarantined ? 0 : outcome.chunkCount },
    phases: phases.ran,
  };
}

/**
 * The `remember` verb.
 *
 * Two differences from ingestion, both deliberate. **The statement is the
 * fact**, whether or not a rule understands its shape — a user asserting
 * something is not an extraction problem, and "the spare key is in the blue
 * tin" must be storable. Extraction still runs, because its structure is what
 * lets the claim supersede an earlier one and imply an edge. And **a duplicate
 * writes nothing at all**: no fact, no page, no chunk. A client retrying a
 * write would otherwise fill retrieval with copies of one claim that the token
 * budget then packs against each other.
 */
export async function remember(
  ctx: WriteContext,
  input: RememberInput,
): Promise<RememberReceipt | WriteFailure> {
  const phases = createPhaseRecorder();
  phases.enter('normalize');

  const origin = input.originContext.trim();
  if (origin.length === 0) return fail('origin_missing');
  const statement = input.statement.trim();
  if (statement.length === 0) return fail('empty_document');

  const sourceType = input.sourceType ?? 'note';
  if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) return fail('unknown_source_type');

  const settings = await readTenantSettings(ctx.sql);
  if (settings === null) return fail('tenant_not_configured');

  phases.enter('chunk');
  const chunks = chunkDocument(statement);
  if (chunks.length === 0) return fail('empty_document');

  phases.enter('extract');
  const structured = extractFromStatement(statement);
  const fact: ExtractedFact =
    structured === null
      ? {
          statement,
          family: null,
          predicate: 'assertion',
          subject: '',
          object: '',
          topic: 'unstructured',
          confidence: 0.9,
          chunkOrdinals: chunks.map((chunk) => chunk.ordinal),
        }
      : { ...structured, confidence: 0.9, chunkOrdinals: chunks.map((chunk) => chunk.ordinal) };

  phases.enter('embed_facts');
  const embedded = await embedTexts({
    gateway: ctx.gateway,
    tenantId: ctx.tenantId,
    caller: ctx.caller,
    budget: ctx.budget,
    texts: [statement],
  });
  if (!embedded.ok) return fail('embed_failed', embedded.reason);
  const vector = embedded.vectors[0];
  if (vector === undefined) return fail('embed_failed', 'embedding_count_mismatch');

  phases.enter('dedup');
  const verdict = await classifyStatement(ctx.sql, {
    statement,
    vector,
    origin,
    excludePageId: null,
  });

  if (verdict.status === 'duplicate' && verdict.matchedFactId !== null) {
    return {
      ok: true,
      id: verdict.matchedFactId,
      status: 'duplicate',
      pageId: null,
      deferred: { chunkEmbeddings: 0 },
      phases: phases.ran,
    };
  }

  // `remember` always encodes exactly one text, so the gateway always has a
  // record here and the by-name fallback is unreachable — but it is spelled the
  // same way as ingestion's, because "unreachable" is a claim about today.
  const modelId = embedded.modelId ?? knownEmbeddingModelFor(ctx.gateway.profileName);
  if (modelId === null) return fail('embedding_model_unknown');

  const outcome = await commitWrite(
    ctx.sql,
    {
      origin,
      sourceType,
      title: input.title ?? null,
      externalRef: null,
      ingestId: null,
      subject: input.subject ?? null,
      quarantined: false,
      // `remember` is a person typing now. There is no provider asserting when
      // this happened, and inventing one would put a locally-minted value in a
      // column whose meaning is "the source said so".
      occurredAt: null,
      digest: contentDigest(input.title, statement),
      chunks,
      // A statement no rule understands still becomes a fact; it simply implies
      // no edge, because `impliedEdges` only speaks for predicates it knows.
      facts: [fact],
      vectors: [vector],
      verdicts: [verdict],
      settings,
      modelId,
      replaces: null,
    },
    phases,
  );

  phases.enter('commit');
  phases.assertComplete();

  const receipt = outcome.facts[0];
  if (receipt === undefined) throw new Error('remember committed no fact');

  return {
    ok: true,
    id: receipt.factId,
    status: receipt.status,
    pageId: outcome.pageId,
    deferred: { chunkEmbeddings: outcome.chunkCount },
    phases: phases.ran,
  };
}
