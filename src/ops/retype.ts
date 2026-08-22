/**
 * Correcting an entity's type, which nothing else in this system can do.
 *
 * `entity_type` is written once, at INSERT (`links.ts`), and never updated.
 * `findEntitiesByName` carries no type predicate, so inserting the corrected
 * type does not repair the row — it forks it, leaving two entities with one
 * name that no rule will ever collapse. That is why this is an operator script
 * and not a self-healing pass.
 *
 * **Why nine rows needed it.** `role_copula` used to match
 * `(NAME) is (ROLE) (of|at|for) (NAME)` and assert employment, whose subject
 * slot is declared `person`. Of 58 live facts it matched on the founder's
 * brain, one was a job title; the rest were `trademark of`, `set for`,
 * `confirmed for` and `part of`. `Android`, `App Store`, `Google Play`, `FICO`,
 * `Discover` and `Glassdoor` were filed as people by sentences about
 * trademarks. Narrowing that rule fixed the *future*; these rows are the past.
 *
 * **A deliberate non-choice: this does NOT mint a successor.** The temptation
 * is to reuse `widenEntityOrigins`' cascade, because that is how this codebase
 * changes an entity elsewhere. It would be nine new ids and nine tombstones
 * dropped into a purge window, entirely self-inflicted: the successor dance
 * exists because `origin_contexts` is immutable by trigger, and `entity_type`
 * is not. `entity`'s only two triggers are `BEFORE UPDATE OF origin_contexts`,
 * so a plain UPDATE of this column fires nothing at all.
 *
 * **The pre-flight is in the same transaction as the update, and that is the
 * one subtle thing here.** `entity_type` is the second component of
 * `mergeEntitiesByRule`'s bucket key, so a *corrected* type can move a row into
 * an already-occupied bucket — and the damage would land up to thirty minutes
 * later, unattended, by cron, through the one path that issues a hard
 * `DELETE FROM entity_alias` with no undo. Checking before the transaction
 * rather than inside it leaves exactly that window open.
 *
 * Dry-run by default. `--confirm` writes.
 *
 *     bun run src/ops/retype.ts organization Android "App Store" FICO
 *     bun run src/ops/retype.ts organization Android --confirm
 */

import { SQL } from 'bun';

import type { EntityType } from '../core/write/links.ts';

/** The union restated, because a type is not a runtime list and argv is text. */
const ENTITY_TYPES: readonly EntityType[] = [
  'person', 'organization', 'place', 'project', 'product', 'event', 'topic', 'other',
];
import { numericArrayLiteral } from '../core/write/pg-values.ts';

interface Candidate {
  entity_id: string;
  canonical_name: string;
  entity_type: string;
  origin_contexts: string[];
}

export interface RetypeOutcome {
  readonly retyped: readonly Candidate[];
  readonly missing: readonly string[];
  readonly collisions: readonly { readonly name: string; readonly collidesWith: string }[];
  readonly applied: boolean;
}

/**
 * Retype named entities, or explain why it refused.
 *
 * A collision refuses the **whole run** rather than the offending row: a
 * half-applied correction is a state nobody asked for and nobody is watching.
 */
export async function retypeEntities(
  sql: SQL,
  input: {
    readonly names: readonly string[];
    readonly to: EntityType;
    readonly confirm: boolean;
  },
): Promise<RetypeOutcome> {
  const rows = (await sql.unsafe(
    `SELECT entity_id::text AS entity_id, canonical_name, entity_type, origin_contexts
       FROM entity
      WHERE deleted_at IS NULL AND lower(canonical_name) = ANY($1::text[])
      ORDER BY entity_id`,
    [`{${input.names.map((name) => `"${name.toLowerCase().replace(/"/g, '\\"')}"`).join(',')}}`],
  )) as Candidate[];

  const found = new Set(rows.map((row) => row.canonical_name.toLowerCase()));
  const missing = input.names.filter((name) => !found.has(name.toLowerCase()));
  const already = rows.filter((row) => row.entity_type === input.to);
  const wanted = rows.filter((row) => row.entity_type !== input.to);

  if (wanted.length === 0) {
    return { retyped: [], missing, collisions: [], applied: false };
  }

  const ids = numericArrayLiteral(wanted.map((row) => row.entity_id));
  const collisions: Array<{ name: string; collidesWith: string }> = [];

  const run = async (db: SQL): Promise<boolean> => {
    const clashes = (await db.unsafe(
      `SELECT a.canonical_name AS name, b.entity_id::text AS collides_with
         FROM entity a
         JOIN entity b
           ON b.deleted_at IS NULL
          AND b.entity_id <> a.entity_id
          AND lower(b.canonical_name) = lower(a.canonical_name)
          AND b.entity_type = $2
          AND b.origin_contexts = a.origin_contexts
        WHERE a.entity_id = ANY($1::bigint[]) AND a.deleted_at IS NULL`,
      [ids, input.to],
    )) as Array<{ name: string; collides_with: string }>;
    for (const clash of clashes) {
      collisions.push({ name: clash.name, collidesWith: clash.collides_with });
    }
    // A row that would land in an occupied rule-merge bucket is a MERGE, not a
    // retype, and the two are not interchangeable: the merge path hard-deletes
    // the loser's alias vocabulary. Refuse and say which pair.
    if (collisions.length > 0) return false;
    if (!input.confirm) return false;

    await db.unsafe(
      `UPDATE entity
          SET entity_type = $2,
              -- NULL so enrichment re-derives the summary with the corrected
              -- type. These displace nobody: the batch limit is 200 and this
              -- brain holds 56 entities, so the marginal model cost is zero.
              enrich_considered_version = NULL
        WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL`,
      [ids, input.to],
    );
    return true;
  };

  const applied = input.confirm ? await sql.begin(async (tx) => run(tx as unknown as SQL)) : await run(sql);
  void already;
  return { retyped: wanted, missing, collisions, applied: applied === true };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const rest = argv.filter((arg) => arg !== '--confirm');
  const to = rest[0] as EntityType | undefined;
  const names = rest.slice(1);

  if (to === undefined || !ENTITY_TYPES.includes(to) || names.length === 0) {
    console.error(`usage: bun run src/ops/retype.ts <${ENTITY_TYPES.join('|')}> <name> [name...] [--confirm]`);
    process.exit(2);
  }

  const dsn = process.env.TENANT_DSN;
  if (dsn === undefined || dsn.length === 0) {
    console.error('TENANT_DSN is not set. Confirm it is THIS brain before running with --confirm.');
    process.exit(2);
  }

  const sql = new SQL(dsn);
  const outcome = await retypeEntities(sql, { names, to, confirm });
  await sql.end();

  for (const name of outcome.missing) console.log(`  not found, skipped: ${name}`);
  for (const clash of outcome.collisions) {
    console.log(`  REFUSED: '${clash.name}' would collide with entity ${clash.collidesWith}`);
  }
  if (outcome.collisions.length > 0) {
    console.log('\nNothing was written. A row that lands in an occupied rule-merge bucket is a');
    console.log('merge, not a retype, and the merge path hard-deletes the loser\'s aliases.');
    process.exit(1);
  }
  for (const row of outcome.retyped) {
    console.log(`  ${outcome.applied ? 'retyped' : 'would retype'} ent:${row.entity_id} ${row.entity_type} -> ${to}  ${row.canonical_name}`);
  }
  console.log(
    outcome.applied
      ? `\n${outcome.retyped.length} retyped. Their summaries will be re-derived on the next cycle.`
      : `\nDRY RUN — ${outcome.retyped.length} would change. Re-run with --confirm.`,
  );
}
