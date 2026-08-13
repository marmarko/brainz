/**
 * KTD9's per-tenant full-text configuration — chosen at provisioning, never
 * defaulted, and checked in three directions.
 *
 * The failure this module exists to prevent is not an error. It is a Spanish
 * brain whose `to_tsvector` calls say `english`: every write succeeds, every
 * query returns rows, and the full-text arm of a hybrid search quietly stems the
 * wrong language forever. KTD9 forbids the silent English fallback, so the
 * language is substituted into the DDL rather than defaulted, the configuration
 * is checked against `pg_ts_config` in the tenant's own database before the DDL
 * runs, and — once a tenant exists — the language a migration is *asked* to use
 * is checked against the language the tenant is already indexed in.
 *
 * That third check is the one a migration runner needs and a first-time applier
 * does not. The language travels on the control-plane row; the tenant database
 * is where it was actually applied. If those two disagree, the honest outcome is
 * a refusal to migrate, because the alternative is a schema whose columns are
 * split across two stemmers with nothing to say which rows are which.
 */

import type { SQL } from 'bun';

import { FTS_LANGUAGE_PATTERN } from '../control/provision.ts';

/**
 * The token every DDL rung carries where its language belongs. There is no
 * default and no fallback: DDL that still holds this after substitution is DDL
 * nobody chose a language for, and DDL that never held it is DDL that hardcoded
 * one.
 */
export const FTS_LANGUAGE_PLACEHOLDER = '{{FTS_LANGUAGE}}';

/**
 * Substitutes the tenant's language into schema text.
 *
 * Validated against the same anchored pattern the control-plane domain uses
 * before it is interpolated — the language reaches DDL as an identifier inside a
 * string literal, so the alphabet is the only thing standing between a config
 * name and injected SQL.
 */
export function applyFtsLanguage(ddl: string, ftsLanguage: string): string {
  if (!FTS_LANGUAGE_PATTERN.test(ftsLanguage)) {
    throw new Error(
      `not a Postgres text-search configuration name: ${JSON.stringify(ftsLanguage.slice(0, 40))}`,
    );
  }
  return ddl.split(FTS_LANGUAGE_PLACEHOLDER).join(ftsLanguage);
}

/** True when the rung needs a language at all. Not every rung will. */
export function needsFtsLanguage(ddl: string): boolean {
  return ddl.includes(FTS_LANGUAGE_PLACEHOLDER);
}

/**
 * KTD9 forbids an English-default silent fallback, and Postgres will happily
 * provide one: an unknown configuration name only fails when a generated column
 * is first evaluated, which is on the tenant's first write rather than at
 * provisioning. Asking the catalog first moves that failure to the moment it is
 * cheap.
 */
export async function assertTextSearchConfigExists(sql: SQL, ftsLanguage: string): Promise<void> {
  const rows = await sql<{ cfgname: string }[]>`
    SELECT cfgname FROM pg_ts_config WHERE cfgname = ${ftsLanguage}
  `;
  if (rows.length === 0) {
    throw new Error(
      `the tenant database has no text-search configuration named ${JSON.stringify(ftsLanguage)}; provisioning must not fall back to a default`,
    );
  }
}

/**
 * Thrown when the language a caller brought disagrees with the one the tenant is
 * already indexed in. Typed, because the caller's remedy is to go and find out
 * which one is right — not to retry.
 */
export class FtsLanguageDriftError extends Error {
  readonly requested: string;
  readonly recorded: string;

  constructor(requested: string, recorded: string) {
    super(
      `this tenant is indexed in ${JSON.stringify(recorded)} but the caller asked to migrate it as ${JSON.stringify(requested)}. Migrating would split the tenant's text columns across two stemmers with nothing to say which rows are which.`,
    );
    this.name = 'FtsLanguageDriftError';
    this.requested = requested;
    this.recorded = recorded;
  }
}

/**
 * The language the tenant database is actually indexed in, read from a generated
 * column's stored expression.
 *
 * The catalog is the only witness that cannot drift: `tenant_setting` records
 * what someone *said*, and a v1 tenant predates that table entirely, but
 * `chunk.content_tsv` has carried its configuration name since rung one, in the
 * expression Postgres evaluates on every write.
 */
export async function observedFtsLanguage(sql: SQL): Promise<string | undefined> {
  const rows = await sql<{ expr: string }[]>`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'chunk' AND a.attname = 'content_tsv'
  `;
  const expression = rows[0]?.expr;
  if (expression === undefined) return undefined;

  // `to_tsvector('simple'::regconfig, content)` — the quoted name is the answer.
  const matched = /'([a-z][a-z_]{0,31})'::regconfig/.exec(expression);
  return matched?.[1];
}

/**
 * Refuses a migration whose language disagrees with the tenant's own.
 *
 * A tenant with no chunk table yet (a fresh database being provisioned) has
 * nothing to disagree with, and that is not drift — it is rung one about to run.
 */
export async function assertFtsLanguageMatches(sql: SQL, requested: string): Promise<void> {
  const observed = await observedFtsLanguage(sql);
  if (observed === undefined) return;
  if (observed !== requested) throw new FtsLanguageDriftError(requested, observed);
}
