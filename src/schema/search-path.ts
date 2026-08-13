/**
 * H6 — pinning the schema the fence resolves its own names in.
 *
 * `docs/porting-hazards.md` H6: a trigger function that resolves unqualified
 * names through the calling session's `search_path` is a check whose enforcement
 * belongs to whoever calls it. brainz declared eight trigger functions and
 * pinned none of them, and seven of the eight are R15's origin fence.
 *
 * **Measured, not inferred.** None of the eight is `SECURITY DEFINER`
 * (`prosecdef = false` on all eight), so this was never the privilege-escalation
 * form of the bug — there is no definer's-rights body to aim a hostile path at.
 * It was the other one, and it had a working exploit: with a schema holding an
 * empty table named `page` in front of `public`, `assert_fact_page_origin`
 * inspected the wrong table and admitted a `fact` claiming `{personal}` off a
 * `work` page. KTD5 fences reads on origin alone, so that row then reads out to
 * a personal-scoped grant. `test/schema/search-path.test.ts` replays all of it.
 *
 * **Why the pin is exactly `pg_catalog, public, pg_temp`.** Each position is
 * load-bearing and two of the three are easy to get wrong:
 *
 *   * `pg_catalog` **first and named**. `refuse_origin_change` touches no table
 *     — only `to_jsonb` and `->` — which looks immune, because an unlisted
 *     `pg_catalog` is searched before everything else. Listing it *later* is
 *     what defeats it, and a shadow `to_jsonb` returning a constant makes OLD
 *     and NEW compare equal. Naming it first removes the demotion.
 *   * `public`, because the fence's own tables live there.
 *   * `pg_temp` **last and named**. This is the one a careless pin omits. When
 *     `pg_temp` is not listed, Postgres searches it **first** for relation names
 *     — ahead of `pg_catalog` — so a pin of `pg_catalog, public` leaves the
 *     union checks defeatable by `CREATE TEMP TABLE page`, which needs no
 *     `CREATE` privilege on any schema. That is a strictly cheaper attack than
 *     the one being fixed.
 *
 * **Why rung 8 expands instead of rewriting.** The direct fix is
 * `ALTER FUNCTION … SET search_path`, and it is unavailable:
 * `findExpandContractViolations` admits only additive statement shapes, and
 * `ALTER FUNCTION` is not one of them (nor does `CREATE OR REPLACE FUNCTION`
 * match `/^CREATE FUNCTION\b/`). So rung 8 creates a pinned twin of each
 * function and a twin trigger for each trigger that called one. Both fire; the
 * unpinned arm can be fooled and the pinned arm cannot, and a check that raises
 * is a check that raises. The contract rung that drops the originals is a later
 * one, gated on every fleet instance having been replaced.
 *
 * **Two halves, because each is blind to the other's failure** — the same
 * division `origin-fence.ts` makes for the same reason:
 *
 *   * {@link findUnpinnedFunctionDeclarations} reads DDL. It is what stops a
 *     *ninth* function landing unpinned, and it needs no database.
 *   * {@link findUnpinnedFenceCoverage} reads the catalog. It is what sees a
 *     twin trigger that was dropped, disabled, or never written for a table
 *     added later — none of which is visible in a rung's text.
 *
 * A third half is behavioural and lives in the test, not here: replaying the
 * three bypasses against a pinned database. A structural guard that passes while
 * the exploit still works is precisely what the H6 card warns about.
 */

import type { SQL, TransactionSQL } from 'bun';

import { readLadderDdl } from './migrations.ts';

/**
 * The rung that pins. Below it a tenant has the unpinned functions and no twins,
 * which is not tampering — it is a tenant that has not been migrated yet.
 */
export const SEARCH_PATH_PINNED_SINCE = 8;

/**
 * The one pinned value. A constant rather than a per-function choice: eight
 * functions with eight paths is eight chances to write `pg_catalog, public` and
 * leave the temp-table door open.
 */
export const PINNED_SEARCH_PATH = 'pg_catalog, public, pg_temp';

/** How a pinned twin is named. One rule, so the twin is derivable, not looked up. */
export const PINNED_SUFFIX = '_pinned';

/**
 * The functions that predate the pin, named rather than tolerated.
 *
 * Closed, and the test that reads it is what closes it: an entry here is only
 * accepted when the ladder also declares its `_pinned` successor, so this list
 * cannot be used to wave a new unpinned function through. It exists because
 * rungs 2 and 3 are committed history — a rung is never edited — and the
 * alternative to naming them is a scanner that skips whatever it was pointed at
 * first.
 */
export const SUPERSEDED_UNPINNED_FUNCTIONS: readonly string[] = [
  'assert_commitment_origin_union',
  'assert_edge_origin_union',
  'assert_entity_card_origin_union',
  'assert_fact_page_origin',
  'assert_inverse_is_involutive',
  'assert_origin_union',
  'assert_report_origin_union',
  'refuse_origin_change',
];

const SUPERSEDED = new Set(SUPERSEDED_UNPINNED_FUNCTIONS);

export class SearchPathUnpinnedError extends Error {
  readonly findings: readonly string[];

  constructor(findings: readonly string[]) {
    super(
      `a trigger function on this tenant resolves its own names through the caller's search_path: ${findings.join('; ')}. R15's fence is what enforces origin, and a fence that resolves \`page\` through the calling session is a fence the caller decides the meaning of (H6).`,
    );
    this.name = 'SearchPathUnpinnedError';
    this.findings = findings;
  }
}

/**
 * Every `CREATE FUNCTION` in `ddl` that declares no `SET search_path`.
 *
 * The header is scanned, not the body: a function whose *body text* happens to
 * contain the words `SET search_path` is not a pinned function, and a scanner
 * that searched the whole statement would call it one. So the region examined
 * runs from the closing parenthesis of the argument list to the opening
 * dollar-quote of the body, which is exactly where the clause is legal.
 *
 * **The parse is checked for having happened.** A regex that matches nothing
 * returns an empty finding list, which reads identically to a clean sheet — the
 * failure this whole module exists to refuse. So every `CREATE FUNCTION`
 * occurrence is counted independently and a shortfall is itself a finding.
 */
export function findUnpinnedFunctionDeclarations(ddl: string): string[] {
  const findings: string[] = [];
  const code = stripSqlComments(ddl);

  const declaration =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)([\s\S]*?)\$[A-Za-z_]*\$/g;

  let parsed = 0;
  for (const match of code.matchAll(declaration)) {
    parsed += 1;
    const name = match[1] ?? '<unnamed>';
    const header = match[2] ?? '';
    if (!/\bSET\s+search_path\s*=/i.test(header)) {
      findings.push(
        `${name} declares no SET search_path — it resolves its own names through whatever path the calling session set`,
      );
    }
  }

  const occurrences = (code.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi) ?? []).length;
  if (occurrences !== parsed) {
    findings.push(
      `the declaration scanner read ${parsed} of ${occurrences} CREATE FUNCTION statements — the rest are in a shape it does not parse, and an unparsed function is an unchecked one`,
    );
  }

  return findings;
}

/**
 * `ddl` with its comments removed, so prose cannot be read as declaration.
 *
 * Written because the scanner above found it: rung 8's header explains why
 * `ALTER FUNCTION` was unavailable, which means the words `CREATE FUNCTION`
 * appear twice in a comment, and the completeness counter reported ten
 * declarations where eight were parsed. Loosening the counter would have been
 * the wrong repair — the counter was right and the input was wrong.
 *
 * Dollar-quoted bodies and single-quoted literals are skipped rather than
 * scanned, because a `--` inside either is data. This is deliberately the same
 * shape as `splitStatements` in the migration runner, and deliberately not an
 * import of it: `src/control/migrate.ts` already imports this directory, and a
 * schema module reaching back into the control plane would close that loop.
 */
function stripSqlComments(ddl: string): string {
  let out = '';
  let index = 0;

  while (index < ddl.length) {
    const rest = ddl.slice(index);

    const lineComment = /^--[^\n]*/.exec(rest);
    if (lineComment) {
      index += lineComment[0].length;
      continue;
    }

    const blockComment = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (blockComment) {
      index += blockComment[0].length;
      continue;
    }

    const dollarOpen = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollarOpen) {
      const tag = dollarOpen[0];
      const close = ddl.indexOf(tag, index + tag.length);
      const end = close === -1 ? ddl.length : close + tag.length;
      out += ddl.slice(index, end);
      index = end;
      continue;
    }

    if (ddl[index] === "'") {
      // `''` is an escaped quote, not a close — the fence's own HINT strings
      // contain one, and a scanner that ended the literal there would resume
      // reading prose as SQL.
      let scan = index + 1;
      while (scan < ddl.length) {
        if (ddl[scan] === "'" && ddl[scan + 1] === "'") {
          scan += 2;
          continue;
        }
        if (ddl[scan] === "'") {
          scan += 1;
          break;
        }
        scan += 1;
      }
      out += ddl.slice(index, scan);
      index = scan;
      continue;
    }

    out += ddl[index];
    index += 1;
  }

  return out;
}

/**
 * The same scan over the whole committed ladder, minus the superseded eight.
 *
 * Rung-scoped rather than one concatenated blob, so a finding names the rung
 * that introduced it.
 */
export async function findLadderPinViolations(): Promise<string[]> {
  const findings: string[] = [];

  for (const { migration, ddl } of await readLadderDdl()) {
    for (const finding of findUnpinnedFunctionDeclarations(ddl)) {
      const name = finding.split(' ')[0] ?? '';
      if (SUPERSEDED.has(name)) continue;
      findings.push(`rung ${migration.version} (${migration.name}): ${finding}`);
    }
  }

  return findings;
}

interface TriggerRecord {
  readonly table_name: string;
  readonly trigger_name: string;
  readonly function_name: string;
  readonly enabled: boolean;
  readonly definition: string;
  readonly pinned: boolean;
}

interface FunctionRecord {
  readonly function_name: string;
  readonly pinned: boolean;
}

/**
 * The catalog half: what this database will actually execute.
 *
 * Three findings, and the second is the one no static scan can produce:
 *
 *   1. A trigger function in `public` that pins nothing and is not one of the
 *      superseded eight — a ninth that reached a database.
 *   2. An enabled trigger calling a superseded function with **no enabled
 *      pinned twin of the same shape on the same table**. This is what sees a
 *      twin that was dropped or disabled, and a table added after rung 8 whose
 *      author copied the unpinned trigger from a rung above.
 *   3. Nothing at all — no trigger functions in `public` — which would otherwise
 *      report a clean sheet over a database with no schema in it.
 */
export async function findUnpinnedFenceCoverage(sql: SQL | TransactionSQL): Promise<string[]> {
  const findings: string[] = [];

  const functions = await sql.unsafe<FunctionRecord[]>(`
    SELECT p.proname AS function_name,
           EXISTS (
             SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
             WHERE cfg LIKE 'search_path=%'
           ) AS pinned
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prorettype = 'trigger'::regtype
    ORDER BY p.proname
  `);

  if (functions.length === 0) {
    findings.push(
      'this database declares no trigger functions at all — either the schema is not applied or R15 has been removed wholesale',
    );
    return findings;
  }

  for (const fn of functions) {
    if (fn.pinned || SUPERSEDED.has(fn.function_name)) continue;
    findings.push(
      `${fn.function_name}: a trigger function with no search_path in proconfig, and not one of the functions rung ${SEARCH_PATH_PINNED_SINCE} superseded`,
    );
  }

  const triggers = await sql.unsafe<TriggerRecord[]>(`
    SELECT c.relname AS table_name,
           t.tgname   AS trigger_name,
           p.proname  AS function_name,
           -- 'D' is DISABLED: the one bit of trigger state that does not appear
           -- in the trigger's own definition text.
           (t.tgenabled <> 'D') AS enabled,
           pg_get_triggerdef(t.oid) AS definition,
           EXISTS (
             SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) AS cfg
             WHERE cfg LIKE 'search_path=%'
           ) AS pinned
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
    ORDER BY c.relname, t.tgname
  `);

  // Keyed on (table, shape) so a twin is matched by what it *does*, not by its
  // name. A twin attached BEFORE INSERT would otherwise satisfy a BEFORE UPDATE
  // requirement by sharing a suffix.
  const pinnedShapes = new Set(
    triggers
      .filter((trigger) => trigger.pinned && trigger.enabled)
      .map((trigger) => `${trigger.table_name} ${triggerShape(trigger.definition)}`),
  );

  for (const trigger of triggers) {
    if (trigger.pinned || !trigger.enabled) continue;
    if (!SUPERSEDED.has(trigger.function_name)) continue;

    const expected = triggerShape(
      trigger.definition.replace(
        new RegExp(`EXECUTE FUNCTION ${trigger.function_name}\\(`),
        `EXECUTE FUNCTION ${trigger.function_name}${PINNED_SUFFIX}(`,
      ),
    );

    if (pinnedShapes.has(`${trigger.table_name} ${expected}`)) continue;

    findings.push(
      `${trigger.table_name}.${columnOf(trigger.definition) ?? trigger.trigger_name}: ${trigger.trigger_name} calls the unpinned ${trigger.function_name} and no enabled pinned twin covers the same rows`,
    );
  }

  return findings;
}

/**
 * A trigger's definition with its own name removed.
 *
 * Everything that matters about a twin — timing, events, the column list, the
 * deferral, the arguments, the function — survives; the identifier that must
 * differ does not. Comparing whole definitions would never match; comparing
 * function names alone would accept a twin attached to the wrong event.
 */
function triggerShape(definition: string): string {
  return definition
    .replace(/^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+\S+\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The fenced column, for a finding that reads like `origin-fence.ts`'s. */
function columnOf(definition: string): string | undefined {
  return /BEFORE UPDATE OF (\w+) ON /i.exec(definition)?.[1];
}

/**
 * Both halves against a live tenant, plus the ladder scan that needs no database.
 *
 * Throws {@link SearchPathUnpinnedError} with every finding rather than the
 * first, because an operator reading this after a failed migration wants the set
 * — a fence half-pinned is a different problem from a fence not pinned.
 */
export async function assertSearchPathPinned(sql: SQL | TransactionSQL): Promise<void> {
  const findings = [...(await findLadderPinViolations()), ...(await findUnpinnedFenceCoverage(sql))];
  if (findings.length > 0) throw new SearchPathUnpinnedError(findings);
}
