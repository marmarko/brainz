/**
 * Merging entities, and the preview that stands in for an undo.
 *
 * **A merge cannot be undone, and this file exists because of that.** Three of
 * its steps are one-way at the database level: the absorbed rows' aliases are
 * hard-DELETEd (the unique key is total, so a shared spelling cannot coexist),
 * their canonical slugs are overwritten to redirects, and their edges are
 * retired in a table `restoreForgotten` deliberately refuses to walk. So the
 * protection is not a rollback — it is a preview that writes nothing and prints
 * exactly what would happen, read before `--confirm` is typed.
 *
 * **Names are resolved through `normalize(canonical_name)` against one read of
 * the live set, never through `findEntitiesByName`.** That function hops
 * aliases first and collapses with `DISTINCT ON (key) … ORDER BY key,
 * entity_id` over a vocabulary the schema itself calls *"deliberately not
 * unique across entities"* — so asking it to identify a merge member could
 * silently pick a different entity than the one named. The proposal that
 * suggested the merge was keyed on canonical names for the same reason.
 *
 * Two prerequisites the runbook states and this script cannot enforce:
 * run it from **the exact deployed commit** — version skew between this
 * primitive and the fleet's is the one real hazard on this path — and confirm
 * `TENANT_DSN` is the brain you mean.
 *
 *     bun run src/ops/merge.ts "Google Inc" "Google LLC"
 *     bun run src/ops/merge.ts "Google Inc" "Google LLC" --confirm
 *
 * The FIRST name is the primary: the survivor keeps its canonical name and its
 * canonical slug.
 */

import { SQL } from 'bun';

import { mergeEntities, planMerge, type MergePlan } from '../core/write/merge.ts';
import { normalize } from '../core/write/normalize.ts';

interface LiveEntity {
  entity_id: string;
  canonical_name: string;
  entity_type: string;
  origin_contexts: string[];
}

/** Every live entity, once, so resolution never touches the alias ladder. */
export async function resolveByCanonicalName(
  sql: SQL,
  names: readonly string[],
): Promise<{ found: Map<string, LiveEntity>; missing: string[] }> {
  const rows = (await sql`
    SELECT entity_id::text AS entity_id, canonical_name, entity_type, origin_contexts
      FROM entity WHERE deleted_at IS NULL ORDER BY entity_id
  `) as LiveEntity[];
  const byKey = new Map<string, LiveEntity>();
  for (const row of rows) {
    const key = normalize(row.canonical_name);
    // First wins, and ties are reported rather than resolved: two live rows with
    // the same normalized name are themselves a merge candidate, and guessing
    // which one the operator meant is exactly the silent wrong answer this
    // script is built to avoid.
    if (!byKey.has(key)) byKey.set(key, row);
  }
  const found = new Map<string, LiveEntity>();
  const missing: string[] = [];
  for (const name of names) {
    const hit = byKey.get(normalize(name));
    if (hit === undefined) missing.push(name);
    else found.set(name, hit);
  }
  return { found, missing };
}

export function describePlan(plan: MergePlan, byId: ReadonlyMap<string, LiveEntity>): string {
  const lines: string[] = [];
  lines.push(`  arm:      ${plan.arm}${plan.arm === 'successor' ? '  (a new row is minted; every member is tombstoned)' : '  (the primary survives with its own id)'}`);
  lines.push(`  survivor: ${byId.get(plan.primary)?.canonical_name ?? plan.primary}  [${plan.entityType}]`);
  lines.push('  members:');
  for (const member of plan.members) {
    const row = byId.get(member);
    const mark = member === plan.primary ? '*' : ' ';
    lines.push(
      `   ${mark} ent:${member.padEnd(4)} ${(row?.entity_type ?? '?').padEnd(13)} ` +
        `${JSON.stringify(row?.origin_contexts ?? [])}  ${row?.canonical_name ?? '?'}`,
    );
  }
  lines.push(`  origins:  ${JSON.stringify(plan.origins)}`);
  lines.push(
    `  card:     ${plan.card === null ? 'none' : `keeps the ${plan.card.trustLevel} one`}`,
  );
  lines.push(`  edges:    ${plan.edgeCount} live, all rewritten with the union`);
  lines.push(
    `  aliases:  ${plan.aliasCollisions.length === 0 ? 'no shared spellings' : `${plan.aliasCollisions.length} shared, kept once with the wider provenance: ${plan.aliasCollisions.join(', ')}`}`,
  );
  return lines.join('\n');
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const names = argv.filter((arg) => !arg.startsWith('--'));

  if (names.length < 2) {
    console.error('usage: bun run src/ops/merge.ts "<primary>" "<other>" [more...] [--confirm]');
    console.error('the FIRST name is the primary: the survivor keeps its name and slug.');
    process.exit(2);
  }
  const dsn = process.env.TENANT_DSN;
  if (dsn === undefined || dsn.length === 0) {
    console.error('TENANT_DSN is not set. Confirm it is THIS brain before running with --confirm.');
    process.exit(2);
  }

  const sql = new SQL(dsn);
  const { found, missing } = await resolveByCanonicalName(sql, names);
  if (missing.length > 0) {
    console.error(`not found (canonical names, exactly): ${missing.join(', ')}`);
    await sql.end();
    process.exit(1);
  }

  const primaryName = names[0] ?? '';
  const primary = found.get(primaryName);
  const members = [...found.values()].map((row) => row.entity_id);
  const planned = await planMerge(sql, {
    primary: primary?.entity_id ?? '',
    members,
  });

  if (!planned.ok) {
    console.error(`REFUSED: ${planned.reason}`);
    if (planned.reason === 'two_of_yours') {
      console.error('Two summaries you personally approved are two decisions. Retire one first.');
    }
    await sql.end();
    process.exit(1);
  }

  const byId = new Map([...found.values()].map((row) => [row.entity_id, row] as const));
  console.log(describePlan(planned.plan, byId));

  if (!confirm) {
    console.log('\nDRY RUN — nothing was written. Re-run with --confirm.');
    console.log('A merge CANNOT be undone: aliases are hard-deleted, slugs become redirects,');
    console.log('and retired edges are in a table the restore path refuses to walk.');
    await sql.end();
    process.exit(0);
  }

  const result = await sql.begin(async (tx) =>
    mergeEntities(tx as unknown as SQL, planned.plan, new Date()),
  );
  console.log(`\nmerged into ent:${result.entityId}; tombstoned ${result.tombstoned.length}`);
  await sql.end();
}
