/**
 * What a released fleet version actually said to a tenant database — frozen.
 *
 * ==========================================================================
 * THE FREEZE RULE. Read this before editing anything below.
 *
 * These statements are a **historical record**, not a fixture. They are the SQL
 * that release `fleet-1`'s code issued, and the only thing that makes
 * `test/schema/rollout.test.ts` mean anything is that they cannot be adjusted
 * when a migration breaks them. Editing a statement here to make a test pass
 * converts the guard into a tautology: of course the current code works against
 * the current schema — it was written against it.
 *
 * So: **append a new surface when a release ships; never edit an existing one.**
 * If a rung breaks a frozen statement, the rung is wrong. That is the finding.
 *
 * The rule is not enforced by good intentions. Each surface declares the schema
 * version its release was written against, and the rollout test runs it twice:
 * against a database at exactly that version, and against one migrated to head.
 * A statement "fixed" by borrowing a column from a later rung fails the first
 * run immediately.
 * ==========================================================================
 *
 * **Why a transcription rather than an import of the real code.** Importing the
 * helpers that issued these statements would freeze nothing — those helpers move
 * with the tree, so tomorrow's version of `candidateQuery()` is what would run,
 * which is precisely the current code the guard is trying not to test. The cost
 * is that a transcription can drift from what the release really said; the
 * mitigation is that these came from that release's own files
 * (`test/hazards/fixture.ts`, `src/schema/vector-query.ts`,
 * `src/schema/vector-index.ts` at rung one) and that each entry names its source.
 */

import type { SQL } from 'bun';

export interface FrozenExchange {
  /** What the release was doing, in its own terms. */
  readonly what: string;
  /** Where in that release's tree it came from. */
  readonly from: string;
  /** Run in one transaction, so `SET LOCAL` means what it meant then. */
  readonly statements: readonly string[];
}

export interface FleetSurface {
  /** The release, as it would be named in a deploy. */
  readonly release: string;
  /** The rung this release's code was written against. */
  readonly schemaVersion: number;
  readonly exchanges: readonly FrozenExchange[];
}

/** A 1536-dimension unit vector as rung-one code spelled it. */
const V1_VECTOR = "('[1' || repeat(',0', 1535) || ']')::vector(1536)";

/**
 * Release 1: the chunk-storage core, its two hazard remedies, and the
 * provisioning assertion. Written against schema rung 1.
 */
export const FLEET_1_SURFACE: FleetSurface = {
  release: 'fleet-1',
  schemaVersion: 1,
  exchanges: [
    {
      what: 'writes a chunk with rung one’s column list',
      from: 'test/hazards/fixture.ts — seedCorpus',
      statements: [
        `INSERT INTO chunk (origin_context, content, embedding, deleted_at, quarantined_at)
         VALUES ('personal', 'frozen surface chunk', ${V1_VECTOR}, NULL, NULL)`,
      ],
    },
    {
      what: 'writes a chunk before it has been embedded',
      from: 'test/hazards/fixture.ts — the nullable embedding column',
      statements: [`INSERT INTO chunk (origin_context, content) VALUES ('work', 'frozen unembedded chunk')`],
    },
    {
      what: 'backfills an embedding onto an existing chunk',
      from: 'the write path rung one described: written first, embedded after',
      statements: [
        `UPDATE chunk SET embedding = ${V1_VECTOR} WHERE content = 'frozen unembedded chunk'`,
      ],
    },
    {
      what: 'asks the vector arm for a 250-candidate pool, production-shaped',
      from: 'src/schema/vector-query.ts + test/hazards/fixture.ts — candidateQuery({filtered:true})',
      statements: [
        'SET LOCAL hnsw.ef_search = 250',
        'SET LOCAL hnsw.iterative_scan = relaxed_order',
        `SELECT chunk_id
           FROM chunk
           WHERE origin_context = 'personal'
             AND deleted_at IS NULL
             AND quarantined_at IS NULL
           ORDER BY embedding <=> ${V1_VECTOR}
           LIMIT 250`,
      ],
    },
    {
      what: 'asks the vector arm for the same pool unfiltered',
      from: 'test/hazards/fixture.ts — candidateQuery({filtered:false})',
      statements: [
        'SET LOCAL hnsw.ef_search = 250',
        'SET LOCAL hnsw.iterative_scan = relaxed_order',
        `SELECT chunk_id FROM chunk WHERE embedding IS NOT NULL ORDER BY embedding <=> ${V1_VECTOR} LIMIT 250`,
      ],
    },
    {
      what: 'reads the full-text arm',
      from: "rung one's generated content_tsv column and its GIN index",
      statements: [`SELECT chunk_id FROM chunk WHERE content_tsv @@ plainto_tsquery('frozen') LIMIT 25`],
    },
    {
      what: 'counts what a read would have been allowed to see',
      from: 'test/hazards/fixture.ts — countQualifying',
      statements: [
        `SELECT count(*)::int AS n FROM chunk
          WHERE origin_context = 'personal' AND deleted_at IS NULL AND quarantined_at IS NULL
            AND embedding IS NOT NULL`,
      ],
    },
    {
      what: 'asserts the tenant has a usable HNSW index before serving it',
      from: 'src/schema/vector-index.ts — findIndexesOnColumn',
      statements: [
        `SELECT i.relname AS index_name, am.amname AS method, ix.indisvalid AND ix.indisready AS valid
           FROM pg_class t
           JOIN pg_index ix ON ix.indrelid = t.oid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_am am ON am.oid = i.relam
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (ix.indkey)
          WHERE t.relname = 'chunk' AND a.attname = 'embedding' AND t.relkind = 'r'
            AND pg_table_is_visible(t.oid)
          ORDER BY i.relname`,
      ],
    },
    {
      what: 'soft-deletes a chunk (R12)',
      from: "rung one's deleted_at column",
      statements: [`UPDATE chunk SET deleted_at = now() WHERE content = 'frozen unembedded chunk'`],
    },
  ],
};

/**
 * Release 13: the release that added the 1024 column and did not use it.
 *
 * Frozen because rung 14 drops `fact.embedding`'s `NOT NULL` — the one
 * `ALTER COLUMN` action the expand-only scanner now admits — and the entire
 * argument for admitting it is that a fleet-13 instance serving a tenant
 * migrated past it notices nothing. That argument is worth exactly as much as
 * this surface, which is release 13's own SQL: the synchronous fact write, the
 * dedup neighbour scan that reads the column back, and the chunk backfill.
 *
 * The CHECK rung 14 adds is tested here too, and without a line mentioning it:
 * every fact this release writes fills `embedding`, so the constraint is
 * satisfied by construction — which is the property `ADD CONSTRAINT … CHECK`
 * needs and cannot get from being additive in shape.
 *
 * Transcribed from that release's own files, named per exchange. `1` followed
 * by 1535 zeroes is how `embed.ts:vectorLiteral` spelled a vector then, minus
 * the 1534 characters of comma-zero nobody needs to read.
 */
const V13_VECTOR = "('[1' || repeat(',0', 1535) || ']')::vector";

export const FLEET_13_SURFACE: FleetSurface = {
  release: 'fleet-13',
  schemaVersion: 13,
  exchanges: [
    {
      what: 'writes a page, then a fact under it, with rung 13’s column list',
      from: 'src/core/write/write-path.ts — commitWrite',
      statements: [
        `INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                           chunker_version, normalizer_version, content_sha256)
         VALUES ('personal', 'note', 'frozen surface page', 'text-embedding-3-large', 1536, 1, 1, repeat('f', 64))`,
        `INSERT INTO fact (page_id, statement, embedding, origin_contexts, confidence, taxonomy_version)
         VALUES ((SELECT max(page_id) FROM page), 'the frozen surface states a fact',
                 ${V13_VECTOR}, ARRAY['personal']::text[], 0.9, 1)`,
      ],
    },
    {
      what: 'reads its own fact back by similarity, to decide duplicate or supersede',
      from: 'src/core/write/dedup.ts — the neighbour scan',
      statements: [
        'SET LOCAL hnsw.ef_search = 100',
        `SELECT fact_id::text AS fact_id, statement, 1 - (embedding <=> ${V13_VECTOR}) AS similarity
           FROM fact
          WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
            AND 'personal' = ANY (origin_contexts)
          ORDER BY embedding <=> ${V13_VECTOR}
          LIMIT 100`,
      ],
    },
    {
      what: 'drains the chunk embedding backlog into the 1536 column',
      from: 'src/core/write/embed.ts — pendingChunkEmbeddings + runChunkEmbedBacklog',
      statements: [
        `INSERT INTO chunk (origin_context, content) VALUES ('personal', 'frozen surface unembedded chunk')`,
        `SELECT c.chunk_id::text AS chunk_id, c.content, p.title
           FROM chunk c
           LEFT JOIN page p ON p.page_id = c.page_id
          WHERE c.embedding IS NULL AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
            AND (p.page_id IS NULL OR (p.deleted_at IS NULL AND p.quarantined_at IS NULL))
          ORDER BY c.chunk_id
          LIMIT 32`,
        `UPDATE chunk SET embedding = ${V13_VECTOR}
          WHERE content = 'frozen surface unembedded chunk' AND embedding IS NULL`,
      ],
    },
    {
      what: 'supersedes a fact, which is how a claim goes stale without being rewritten',
      from: 'src/core/write/write-path.ts — the supersession UPDATE',
      statements: [
        // The correction arrives as its own row, embedded like any other:
        // origin is immutable, so a claim whose value changed is a new fact
        // pointing back at the old one rather than an edit.
        `INSERT INTO fact (page_id, statement, embedding, origin_contexts, confidence, taxonomy_version)
         VALUES ((SELECT max(page_id) FROM page), 'the frozen surface states it differently now',
                 ${V13_VECTOR}, ARRAY['personal']::text[], 0.9, 1)`,
        `UPDATE fact
            SET superseded_by = (SELECT fact_id FROM fact
                                  WHERE statement = 'the frozen surface states it differently now')
          WHERE statement = 'the frozen surface states a fact' AND superseded_by IS NULL`,
      ],
    },
  ],
};

/**
 * Release 14: what a connector poll wrote into the tenant's own ingest log.
 *
 * **Why this surface exists and why now.** Rung 15 widens
 * `ingest_log_failure_is_a_code` — the CHECK on `failure_code` — from six
 * labels to seven, and a CHECK cannot be widened in place: it has to be dropped
 * and re-added. `findExpandContractViolations` admits that pair statically, but
 * static admission cannot see whether the replacement is *wider* or *narrower*;
 * a rung that re-added a narrower constraint under the same name would pass the
 * scanner and then refuse a code fleet-14 still writes, on the first poll after
 * the rung lands. So the claim is paid for behaviourally, the way rung 14's
 * `DROP NOT NULL` was: these are release 14's own statements, and the rollout
 * test runs them against a database migrated to head.
 *
 * Every one of the six labels is written, not a representative sample. The
 * failure this proves against is one label going missing from the replacement,
 * and a sample would only catch it if it happened to be sampled.
 *
 * Transcribed from that release's `src/ingest/log.ts` — `openRun`,
 * `sweepAbandonedRuns`, `finishRun`, `countRunItem`, `recordItem` and the
 * `sourceStaleness` read — with bound parameters written out as literals.
 */
export const FLEET_14_SURFACE: FleetSurface = {
  release: 'fleet-14',
  schemaVersion: 14,
  exchanges: [
    {
      what: 'opens a run row, counts an item against it, then closes it',
      from: 'src/ingest/log.ts — openRun + countRunItem + finishRun',
      statements: [
        `INSERT INTO ingest_log (origin_context, source_type, outcome)
         VALUES ('connector:gmail', 'email', 'running')
         RETURNING ingest_id::text AS ingest_id`,
        `UPDATE ingest_log
            SET items_seen = items_seen + 1,
                items_written = items_written + 1,
                items_quarantined = items_quarantined + 0
          WHERE ingest_id = (SELECT max(ingest_id) FROM ingest_log)::bigint`,
        `UPDATE ingest_log
            SET outcome = 'ok', failure_code = NULL, finished_at = now()
          WHERE ingest_id = (SELECT max(ingest_id) FROM ingest_log)::bigint
            AND outcome = 'running'`,
      ],
    },
    {
      what: 'closes a failed run under every failure code release 14 could produce',
      from: 'src/ingest/log.ts — finishRun, over INGEST_FAILURE_CODES as it stood at rung 14',
      // The six labels the constraint held before rung 15. If the widened
      // constraint drops any of them, this exchange is where it shows —
      // release 14 is still writing them while release 15 rolls out.
      statements: [
        'auth_expired',
        'rate_limited',
        'provider_error',
        'parse_failed',
        'budget_exhausted',
        'cancelled',
      ].flatMap((code) => [
        `INSERT INTO ingest_log (origin_context, source_type, outcome)
         VALUES ('connector:gmail', 'email', 'running')`,
        `UPDATE ingest_log
            SET outcome = 'failed', failure_code = '${code}', finished_at = now()
          WHERE ingest_id = (SELECT max(ingest_id) FROM ingest_log)::bigint
            AND outcome = 'running'`,
      ]),
    },
    {
      what: 'records one item that failed, already terminal',
      from: 'src/ingest/log.ts — recordItem',
      statements: [
        `INSERT INTO ingest_log (
           origin_context, source_type, external_ref, outcome, failure_code,
           items_seen, items_written, items_quarantined, finished_at
         ) VALUES (
           'connector:gmail', 'email', 'gmail:m1', 'failed', 'provider_error',
           1, 0, 0, now()
         )`,
      ],
    },
    {
      what: 'sweeps a run that stopped reporting, then reads per-source staleness',
      from: 'src/ingest/log.ts — sweepAbandonedRuns + sourceStaleness',
      statements: [
        `UPDATE ingest_log
            SET outcome = 'cancelled', failure_code = 'cancelled', finished_at = now()
          WHERE outcome = 'running'
            AND external_ref IS NULL
            AND origin_context = 'connector:gmail'
            AND source_type = 'email'
            AND started_at <= now() - make_interval(secs => 21600)
          RETURNING ingest_id`,
        `SELECT origin_context,
                source_type,
                max(coalesce(finished_at, started_at)) AS last_checked_at,
                max(finished_at) FILTER (
                  WHERE external_ref IS NULL AND items_written > 0) AS last_write_at,
                coalesce(sum(items_seen) FILTER (WHERE external_ref IS NULL), 0)::int AS items_seen,
                coalesce(sum(items_written) FILTER (WHERE external_ref IS NULL), 0)::int AS items_written,
                count(*) FILTER (WHERE external_ref IS NULL AND outcome = 'running')::int AS running,
                (array_agg(failure_code
                             ORDER BY coalesce(finished_at, started_at) DESC, ingest_id DESC)
                   FILTER (WHERE external_ref IS NULL AND outcome <> 'running'))[1] AS last_failure_code,
                count(*) FILTER (WHERE external_ref IS NOT NULL AND outcome = 'failed')::int AS items_failed,
                (array_agg(failure_code
                             ORDER BY coalesce(finished_at, started_at) DESC, ingest_id DESC)
                   FILTER (WHERE external_ref IS NOT NULL AND outcome = 'failed'))[1] AS last_item_failure_code
           FROM ingest_log
          GROUP BY origin_context, source_type
          ORDER BY origin_context, source_type`,
      ],
    },
  ],
};

export const FLEET_SURFACES: readonly FleetSurface[] = [
  FLEET_1_SURFACE,
  FLEET_13_SURFACE,
  FLEET_14_SURFACE,
];

export interface SurfaceFailure {
  readonly what: string;
  readonly statement: string;
  readonly message: string;
}

/**
 * Runs a frozen surface against a database and reports what that release could
 * no longer do. Each exchange runs in its own transaction, so one failure does
 * not hide the rest — a report naming one broken statement out of nine sends
 * whoever reads it looking for one bug.
 *
 * **Known limit, deliberately not papered over:** a failure is recorded only
 * when a statement *raises*. No result is compared, so a rung that changes what
 * the previous release's queries *return* — a partial index that narrows a plan,
 * a default that changes a count — is invisible here. Fixing it means freezing
 * expected results alongside the statements, which is a second freeze with its
 * own rot problem; it wants its own pass rather than a clause bolted on.
 */
export async function runFleetSurface(
  sql: SQL,
  surface: FleetSurface,
): Promise<SurfaceFailure[]> {
  const failures: SurfaceFailure[] = [];

  for (const exchange of surface.exchanges) {
    let failed: { statement: string; message: string } | undefined;
    try {
      await sql.begin(async (tx) => {
        for (const statement of exchange.statements) {
          try {
            await tx.unsafe(statement);
          } catch (error) {
            failed = {
              statement: statement.replace(/\s+/g, ' ').trim().slice(0, 120),
              message: error instanceof Error ? error.message : String(error),
            };
            throw error;
          }
        }
        return { done: true };
      });
    } catch (error) {
      failures.push({
        what: exchange.what,
        statement: failed?.statement ?? '',
        message: failed?.message ?? (error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return failures;
}
