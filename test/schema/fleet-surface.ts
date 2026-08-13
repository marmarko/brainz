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

export const FLEET_SURFACES: readonly FleetSurface[] = [FLEET_1_SURFACE];

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
