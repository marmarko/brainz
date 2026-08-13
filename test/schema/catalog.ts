/**
 * Reading the tenant schema back out of the catalog, rather than out of the file
 * that was supposed to create it.
 *
 * Every guard in this directory asks the database what exists. That is the same
 * discipline `src/schema/vector-index.ts` applies to the HNSW index and for the
 * same reason: a `CREATE` statement in a file is evidence that someone intended
 * a thing, and the failure this whole unit is built around is a DDL step that
 * was intended on every tenant and ran on all but one.
 */

import type { SQL } from 'bun';

export interface TableRecord {
  readonly table: string;
  /** `COMMENT ON TABLE`, which is where each table declares its class. */
  readonly comment: string | null;
}

export interface ColumnRecord {
  readonly table: string;
  readonly column: string;
  /** `format_type`, so `text[]` and `vector(1536)` arrive spelled as declared. */
  readonly type: string;
  readonly notNull: boolean;
  readonly generated: boolean;
}

export interface TriggerRecord {
  readonly table: string;
  readonly trigger: string;
  /** `pg_get_triggerdef`: timing, events, `UPDATE OF <cols>`, function and args. */
  readonly definition: string;
}

export async function listTables(sql: SQL): Promise<TableRecord[]> {
  const rows = await sql<{ table_name: string; comment: string | null }[]>`
    SELECT c.relname AS table_name, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `;
  return rows.map((row) => ({ table: row.table_name, comment: row.comment }));
}

export async function listColumns(sql: SQL): Promise<ColumnRecord[]> {
  const rows = await sql<
    { table_name: string; column_name: string; type: string; not_null: boolean; generated: boolean }[]
  >`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null,
           a.attgenerated <> '' AS generated
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `;
  return rows.map((row) => ({
    table: row.table_name,
    column: row.column_name,
    type: row.type,
    notNull: row.not_null,
    generated: row.generated,
  }));
}

export async function listTriggers(sql: SQL): Promise<TriggerRecord[]> {
  const rows = await sql<{ table_name: string; trigger_name: string; definition: string }[]>`
    SELECT c.relname AS table_name,
           t.tgname AS trigger_name,
           pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  `;
  return rows.map((row) => ({
    table: row.table_name,
    trigger: row.trigger_name,
    definition: row.definition,
  }));
}

/** The stored expression behind a generated column — where KTD9's language shows up. */
export async function generatedExpression(
  sql: SQL,
  table: string,
  column: string,
): Promise<string | undefined> {
  const rows = await sql<{ expr: string }[]>`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ${table} AND a.attname = ${column}
  `;
  return rows[0]?.expr;
}

/** Every index on a table, by name and method, whatever it covers. */
export async function listIndexes(
  sql: SQL,
  table: string,
): Promise<{ index: string; method: string; definition: string }[]> {
  const rows = await sql<{ index_name: string; method: string; definition: string }[]>`
    SELECT i.relname AS index_name,
           am.amname AS method,
           pg_get_indexdef(ix.indexrelid) AS definition
    FROM pg_class t
    JOIN pg_index ix ON ix.indrelid = t.oid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_am am ON am.oid = i.relam
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = ${table}
    ORDER BY i.relname
  `;
  return rows.map((row) => ({
    index: row.index_name,
    method: row.method,
    definition: row.definition,
  }));
}
