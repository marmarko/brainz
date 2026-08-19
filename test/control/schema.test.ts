/**
 * The control plane's one defining property is that it is **content-free**, and
 * this file is where that stops being a promise and becomes a check.
 *
 * R10's register and U16's attestation both lean on it: the register says which
 * components touch more than one user's data, and the control plane is the one
 * component that touches *every* user while holding none of their words. That
 * claim is worth exactly as much as its enforcement, so the enforcement is
 * mechanical rather than editorial.
 *
 * **What "content-free" means mechanically here.** Not a grep for the word
 * "content" — a column called `note` would sail past that. The rule is a shape
 * rule on the declared types:
 *
 *   1. A column typed by a non-textual builtin (`integer`, `timestamptz`,
 *      `boolean`, …) cannot hold a sentence. Safe by type.
 *   2. A column typed by an enum declared in this schema can only hold one of a
 *      finite set of labels written down in the file. Safe by construction.
 *   3. A column typed by a **domain** declared in this schema is safe only if
 *      that domain bounds its length *and* pins its alphabet with an anchored
 *      regex `CHECK`. The regex is then compiled and run against prose probes:
 *      a domain permissive enough to store "a note about the meeting" fails.
 *   4. Everything else — raw `text`, raw `varchar(200)`, `json`/`jsonb`,
 *      `bytea`, an unrecognized type name — is free-text-shaped and fails,
 *      unless it appears on the justified allowlist below.
 *
 * A length bound alone is not a content guarantee (200 characters is plenty of
 * prose), which is why the alphabet check carries the weight and the bound is
 * only the belt. And the claim the guard actually earns is bounded too: **no
 * column in this schema can store a sentence, a document, a blob or a
 * structured payload.** A single bare token is shaped like a slug and always
 * will be; what keeps a bearer out of the control plane is that these columns
 * are *references*, which is U2's business, not the schema's.
 *
 * **Known gap, stated rather than papered over:** nothing in the blocking suite
 * executes this DDL. A Postgres syntax error survives every test here. The
 * structural sanity test at the bottom narrows that gap; it does not close it.
 * Validity is established when U2's provisioning applies the file for real on
 * the scheduled, secret-gated real-substrate workflow (U1 approach step 7).
 * That split is deliberate: the blocking suite's promise is determinism.
 */

import { describe, expect, test } from 'bun:test';

import { importSealingKey, seal } from '../../src/control/sealed.ts';
import { isValidTenantId } from '../../src/control/secrets.ts';

const SRC_DIR = `${import.meta.dir}/../../src`;
const CONTROL_SCHEMA = 'control/schema.sql';
const SCHEMA_PATH = `${SRC_DIR}/${CONTROL_SCHEMA}`;
const SCHEMA_SQL = await Bun.file(SCHEMA_PATH).text();

/**
 * Every SQL file in `src/`, enumerated rather than listed. The guard below used
 * to read one hardcoded path, so a future *column* could not slip past it but a
 * future *file* escaped it entirely — and this schema's own header says U10's
 * typed job table is expected to land later. A file that nobody classified is a
 * file nobody guarded.
 */
const SQL_FILES: readonly string[] = [
  ...new Bun.Glob('**/*.sql').scanSync({ cwd: SRC_DIR }),
]
  .map((name) => name.split('\\').join('/'))
  .sort();

const SQL_SOURCES: ReadonlyMap<string, string> = new Map(
  await Promise.all(
    SQL_FILES.map(
      async (name): Promise<[string, string]> => [name, await Bun.file(`${SRC_DIR}/${name}`).text()],
    ),
  ),
);

// ---------------------------------------------------------------------------
// A small, deliberately fail-closed SQL reader.
//
// It recognizes the handful of statement kinds this schema uses and reports
// anything else as a finding. A parser that shrugs at what it does not
// understand is a guard that can be switched off by writing unusual DDL.
// ---------------------------------------------------------------------------

interface ColumnDecl {
  readonly table: string;
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultExpr: string | undefined;
}

interface ConstraintDecl {
  readonly table: string;
  readonly name: string | undefined;
  readonly kind: 'primary key' | 'unique' | 'check' | 'foreign key' | 'exclude';
  readonly expr: string;
}

interface TableDecl {
  readonly name: string;
  readonly columns: readonly ColumnDecl[];
  readonly constraints: readonly ConstraintDecl[];
}

interface EnumDecl {
  readonly name: string;
  readonly labels: readonly string[];
}

interface DomainDecl {
  readonly name: string;
  readonly baseType: string;
  readonly checks: readonly string[];
}

interface IndexDecl {
  readonly name: string;
  readonly table: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly predicate: string | undefined;
}

interface Schema {
  readonly tables: readonly TableDecl[];
  readonly enums: readonly EnumDecl[];
  readonly domains: readonly DomainDecl[];
  readonly indexes: readonly IndexDecl[];
  /** Statements the reader did not recognize. Findings, never silence. */
  readonly unrecognized: readonly string[];
}

function readGroup(s: string, start: number): { text: string; next: number } {
  let depth = 0;
  let inString = false;
  let text = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    text += ch;
    if (inString) {
      if (ch === "'") {
        if (s[i + 1] === "'") {
          text += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { text, next: i + 1 };
    }
  }
  return { text, next: s.length };
}

function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += "''";
            i += 2;
            continue;
          }
          out += "'";
          i++;
          break;
        }
        out += sql[i];
        i++;
      }
      continue;
    }
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === '/*') {
          depth++;
          i += 2;
          continue;
        }
        if (sql.slice(i, i + 2) === '*/') {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Splits on `;` at paren depth zero and outside string literals. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed !== '') out.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail !== '') out.push(tail);
  return out;
}

/** Splits a parenthesized body on top-level commas. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (body[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed !== '') out.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail !== '') out.push(tail);
  return out;
}

/**
 * Word/group tokenizer. A parenthesized group glued to the preceding word joins
 * it (`varchar` + `(63)` → `varchar(63)`); a detached one stands alone
 * (`CHECK (…)`).
 */
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      const group = readGroup(s, i);
      const previous = s[i - 1];
      const glued = tokens.length > 0 && previous !== undefined && !/\s/.test(previous);
      if (glued) tokens[tokens.length - 1] += group.text;
      else tokens.push(group.text);
      i = group.next;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s(]/.test(s[j]!)) j++;
    tokens.push(s.slice(i, j));
    i = j;
  }
  return tokens;
}

function isInsideString(s: string, index: number): boolean {
  let inString = false;
  for (let i = 0; i < index; i++) {
    if (s[i] === "'") {
      if (inString && s[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
    }
  }
  return inString;
}

/**
 * Finds every `CHECK (…)` expression in a fragment, whether or not a space
 * separates the keyword from its parenthesis. Formatting must not be able to
 * hide a constraint from the reader — or, worse, hide its *absence*.
 */
function extractCheckExpressions(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const at = lower.indexOf('check', i);
    if (at === -1) break;
    const before = at === 0 ? ' ' : s[at - 1]!;
    const after = s[at + 5] ?? ' ';
    if (/[a-z0-9_]/i.test(before) || /[a-z0-9_]/i.test(after) || isInsideString(s, at)) {
      i = at + 5;
      continue;
    }
    let j = at + 5;
    while (j < s.length && /\s/.test(s[j]!)) j++;
    if (s[j] !== '(') {
      i = at + 5;
      continue;
    }
    const group = readGroup(s, j);
    out.push(group.text);
    i = group.next;
  }
  return out;
}

const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  'not',
  'null',
  'default',
  'primary',
  'unique',
  'check',
  'references',
  'constraint',
  'generated',
  'collate',
  'deferrable',
  'initially',
]);

const TABLE_CONSTRAINT_STARTS = /^(constraint|primary\s+key|foreign\s+key|unique|check|exclude)\b/i;

function unquote(name: string): string {
  return name.replace(/"/g, '').toLowerCase();
}

function parseColumn(table: string, item: string): ColumnDecl {
  const tokens = tokenize(item);
  const name = unquote(tokens[0] ?? '');
  const typeTokens: string[] = [];
  let i = 1;
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (COLUMN_CONSTRAINT_KEYWORDS.has(token.toLowerCase())) break;
    typeTokens.push(token);
  }
  const rest = tokens.slice(i).join(' ');
  const defaultMatch = /\bdefault\s+(.+?)(?=\s+(?:not\s+null|null|check|unique|primary|references|constraint)\b|$)/i.exec(
    rest,
  );
  return {
    table,
    name,
    type: typeTokens.join(' ').toLowerCase(),
    notNull: /\bnot\s+null\b/i.test(rest),
    defaultExpr: defaultMatch?.[1]?.trim(),
  };
}

function parseTableConstraint(table: string, item: string): ConstraintDecl | undefined {
  let rest = item.trim();
  let name: string | undefined;
  const named = /^constraint\s+("?[a-z0-9_]+"?)\s+([\s\S]*)$/i.exec(rest);
  if (named) {
    name = unquote(named[1]!);
    rest = named[2]!.trim();
  }
  const kindMatch = /^(primary\s+key|foreign\s+key|unique|check|exclude)\b([\s\S]*)$/i.exec(rest);
  if (!kindMatch) return undefined;
  const kind = kindMatch[1]!.toLowerCase().replace(/\s+/g, ' ') as ConstraintDecl['kind'];
  return { table, name, kind, expr: kindMatch[2]!.trim() };
}

function parseSchema(rawSql: string): Schema {
  const tables: TableDecl[] = [];
  const enums: EnumDecl[] = [];
  const domains: DomainDecl[] = [];
  const indexes: IndexDecl[] = [];
  const unrecognized: string[] = [];

  for (const statement of splitStatements(stripComments(rawSql))) {
    const flat = statement.replace(/\s+/g, ' ').trim();

    if (/^create\s+schema\b/i.test(flat)) continue;
    if (/^set\b/i.test(flat)) continue;
    if (/^comment\s+on\b/i.test(flat)) continue;

    const enumMatch = /^create\s+type\s+([\w."]+)\s+as\s+enum\s*\(/i.exec(flat);
    if (enumMatch) {
      const open = statement.indexOf('(');
      const group = readGroup(statement, open);
      const labels = [...group.text.matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
        m[1]!.replace(/''/g, "'"),
      );
      enums.push({ name: unquote(enumMatch[1]!), labels });
      continue;
    }

    const domainMatch = /^create\s+domain\s+([\w."]+)\s+as\s+([\s\S]+)$/i.exec(statement.trim());
    if (domainMatch) {
      const body = domainMatch[2]!;
      const tokens = tokenize(body);
      const typeTokens: string[] = [];
      for (const token of tokens) {
        if (COLUMN_CONSTRAINT_KEYWORDS.has(token.toLowerCase())) break;
        if (/^check\s*\(/i.test(token)) break;
        typeTokens.push(token);
      }
      domains.push({
        name: unquote(domainMatch[1]!),
        baseType: typeTokens.join(' ').toLowerCase(),
        checks: extractCheckExpressions(body),
      });
      continue;
    }

    const tableMatch = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/i.exec(flat);
    if (tableMatch) {
      const name = unquote(tableMatch[1]!);
      const open = statement.indexOf('(');
      const group = readGroup(statement, open);
      const body = group.text.slice(1, -1);
      const columns: ColumnDecl[] = [];
      const constraints: ConstraintDecl[] = [];
      for (const item of splitTopLevel(body)) {
        if (TABLE_CONSTRAINT_STARTS.test(item)) {
          const constraint = parseTableConstraint(name, item);
          if (constraint) constraints.push(constraint);
          else unrecognized.push(item);
          continue;
        }
        const column = parseColumn(name, item);
        columns.push(column);
        for (const expr of extractCheckExpressions(item)) {
          constraints.push({ table: name, name: undefined, kind: 'check', expr });
        }
      }
      tables.push({ name, columns, constraints });
      continue;
    }

    const indexMatch =
      /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w."]+)\s+on\s+([\w."]+)\s*\(([^)]*)\)\s*(?:where\s+([\s\S]+))?$/i.exec(
        flat,
      );
    if (indexMatch) {
      indexes.push({
        name: unquote(indexMatch[2]!),
        table: unquote(indexMatch[3]!),
        unique: indexMatch[1] !== undefined,
        columns: indexMatch[4]!.split(',').map((c) => unquote(c.trim())),
        predicate: indexMatch[5]?.trim(),
      });
      continue;
    }

    unrecognized.push(flat);
  }

  return { tables, enums, domains, indexes, unrecognized };
}

// ---------------------------------------------------------------------------
// The content-free guard.
// ---------------------------------------------------------------------------

/**
 * Types that cannot hold prose no matter what is written into them. Numbers,
 * instants, booleans and machine identifiers. Note the omissions: `bytea` is a
 * blob, `json`/`jsonb` is a structured payload, and `tsvector` is derived text
 * — all three are content and none is on this list.
 */
const NON_TEXTUAL_BUILTINS = new Set([
  'smallint',
  'integer',
  'int',
  'int2',
  'int4',
  'int8',
  'bigint',
  'numeric',
  'decimal',
  'real',
  'double precision',
  'float4',
  'float8',
  'boolean',
  'bool',
  'uuid',
  'date',
  'timestamptz',
  'timestamp',
  'timestamp with time zone',
  'timestamp without time zone',
  'time',
  'timetz',
  'interval',
  'inet',
  'cidr',
  'macaddr',
]);

/** Types that hold a user's words, bytes or documents. Never safe bare. */
const TEXTUAL_BUILTINS = new Set([
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'bpchar',
  'json',
  'jsonb',
  'xml',
  'bytea',
  'tsvector',
  'hstore',
  'citext',
  'name',
]);

/**
 * The ceiling on a text domain's length. It is a belt, not the trousers: 256
 * characters is plenty of prose, so the anchored-alphabet CHECK is what
 * actually excludes content. The bound exists so a domain cannot quietly grow
 * into a document store while still passing its regex.
 */
const MAX_TEXT_DOMAIN_LENGTH = 256;

interface AllowlistEntry {
  readonly table: string;
  readonly column: string;
  /** Why this column may be free-text-shaped and still be content-free. */
  readonly because: string;
}

/**
 * The escape hatch, and it is **deliberately empty**.
 *
 * Every identifier the control plane holds — tenant id, provider ids, secret
 * references, the object-storage prefix, the FTS language — is expressible as a
 * domain that names its alphabet, so none of them needs an exemption. An empty
 * allowlist is a stronger statement than a justified one, and the mechanism is
 * kept (and exercised by the fixtures below) because the first entry will
 * arrive under deadline pressure and should have to argue for itself.
 *
 * **The bar for adding an entry**, written down now while nobody wants one:
 * the column must be structurally incapable of holding a user's words — not
 * merely intended not to — and the entry must say how that is guaranteed
 * elsewhere. "The write path only ever puts an id there" is not a guarantee;
 * it is the sentence that precedes every incident.
 *
 * Two things that will push on this and must not win: U10's typed job table
 * lands in this same file and will want a `jsonb` payload (it gets typed
 * columns or an enum instead), and any temptation to store a human-readable
 * label, email or display name (identity lives in U15's own store, not here).
 */
const CONTENT_FREE_ALLOWLIST: readonly AllowlistEntry[] = [];

interface SealedDomainEntry {
  /** The domain's declared name, as written in the SQL. */
  readonly domain: string;
  /** Why a domain longer than a paragraph is still content-free. */
  readonly because: string;
  /**
   * The ceiling THIS domain may reach, when {@link MAX_SEALED_DOMAIN_LENGTH} is
   * not enough — and the entry has to say why in {@link SealedDomainEntry.because}.
   *
   * Declared per entry rather than by raising the shared constant, which is the
   * point: a registry where one envelope needs more room must not silently hand
   * that room to every other one. Still bounded from above by
   * {@link MAX_SEALED_ENTRY_LENGTH}, which is what stops "it needed a bit more"
   * from becoming a payload column.
   */
  readonly maxLength?: number;
}

/**
 * The sealed-envelope registry — the one way past the prose ceiling, and a
 * **narrowing** of the old rule rather than a hole in it.
 *
 * The control plane's claim used to be "it holds ids, counters, timestamps and
 * references", and this file's own header admitted the honest gap in it: *"a
 * high-entropy bearer is shaped exactly like a slug, so no alphabet can exclude
 * it… what keeps a bearer out is that these columns are references, which is
 * U2's business, not the schema's."* That is a promise about the write path, and
 * a promise about the write path is the sentence that precedes every incident.
 *
 * The durable secret store (`src/control/secret-store.sql`) had to put tenant
 * credentials in this database — the file store cannot be shared between two
 * container fleets, and a tenant whose credential lives in one container's
 * temporary directory is a brain nobody can open once that container is
 * replaced. So the rule generalises: **the control plane holds nothing a reader
 * of the control plane can use.** A registered domain may exceed the prose
 * ceiling, and in exchange it must reject, mechanically:
 *
 *   * every prose probe, as every text domain here must;
 *   * every URL-shaped secret, as every text domain here must;
 *   * and — new, and the part the old rule could not do — a **bare bearer
 *     grant**, because the envelope shape requires a version prefix and two
 *     segments that a slug does not have.
 *
 * The bar for an entry is the {@link CONTENT_FREE_ALLOWLIST}'s bar: the column
 * must be structurally incapable of holding a user's words, and the entry must
 * say where that is guaranteed. Note what the CHECK does and does not establish
 * — it proves the *shape* of an envelope, not that the bytes inside were ever
 * encrypted. What pays for that is that one module writes this column
 * (`src/control/secret-pg.ts`, which seals through `src/control/sealed.ts`) and
 * that `test/control/secret-durability.test.ts` opens what it wrote.
 */
const SEALED_ENVELOPE_DOMAINS: readonly SealedDomainEntry[] = [
  // Ordered by the file the domain is declared in, because that is the order
  // `textDomains()` walks (`SQL_FILES` is sorted, and `control/connector-store.sql`
  // sorts before `control/oauth-store.sql` sorts before `control/secret-store.sql`).
  // The registry test compares the two lists element by element, so a new entry
  // goes where its file goes.
  {
    domain: 'control.connector_envelope',
    maxLength: 4096,
    because:
      'it holds an AES-256-GCM envelope over one `ConnectorState`, under the same key and the same module as `control.sealed_envelope`, bound by AAD to `connector/<tenant>/<source>` so a row lifted onto another tenant — or onto the same tenant\'s other source — fails to open rather than handing one mailbox\'s cursor to another. **Both a confidentiality and a storability argument, and they are separate sentences.** The confidentiality one: the record carries the provider\'s own sync token, which is the thing a control-plane dump must not yield. The storability one: `ConnectorState.accountKey` is the mailbox the provider names, which is an address, and this guard makes an address structurally unstorable in the clear. **The bound is 4096 rather than 2048 and the extra is argued rather than assumed:** the sealed record carries a provider continuation token whose length is the provider\'s business (a Drive resume cursor is two opaque tokens joined) and base64url expands it by a third, while the CHECK that would fire fires on a *cursor advance* at the end of a successful poll — a connector that works once and then wedges. That is the outage class the entry below widened itself to avoid, one field further along',
  },
  {
    domain: 'control.oauth_envelope',
    because:
      "it holds an AES-256-GCM envelope under the same key and the same module as `control.sealed_envelope`, bound by AAD to its own row key (`oauth-client/<id>`, `oauth-code/<digest>`, `oauth-refresh/<digest>`) so a row transplanted onto another key fails to open. **The argument for registering it is a storability one, not a confidentiality one, and the two are not the same sentence.** An OAuth client here is public by construction — `token_endpoint_auth_method: none`, no client secret, and its redirect URIs are already the deployment's own allowlist — so nothing about it is secret; it is sealed because a `redirect_uri` is a URL and a `client_name` is prose, and this guard makes both structurally unstorable in the clear. The code and refresh bodies carry the grant (tenant, fence origins, write origin) and do have a confidentiality argument on top. What the codes and refresh tokens THEMSELVES are is not stored at all: only `sha256` of them, in `control.oauth_digest`, which is the rule `account.session` already applies. The bound is 2048 for the reason the entry below gives",
  },
  {
    domain: 'control.sealed_envelope',
    because:
      'it holds an AES-256-GCM envelope whose key lives only in the fleets\' environment and is never written to this database, so a dump, a backup or a leaked control-plane DSN yields ciphertext; the anchored pattern admits base64url and the two separators only — no `:`, no `@`, no `/`, no whitespace — so a connection string is unstorable, and the required `v1.` prefix plus two segments means a bare bearer grant is unstorable too, which is the class the reference columns could never exclude. The bound is 2048 rather than 256 because an envelope over a DSN and a bearer is ~360 characters and a rotation that violated a CHECK would be an outage; `src/control/secret-pg.ts` refuses an oversized plaintext before the column sees it',
  },
];

/**
 * The ceiling a sealed domain may reach. Still a bound, and still far below a
 * document: it is sized for one envelope, not for a payload column that grew.
 */
const MAX_SEALED_DOMAIN_LENGTH = 2048;

/**
 * The ceiling on a per-entry {@link SealedDomainEntry.maxLength}.
 *
 * The escape hatch has to have a floor under it or it is not a ceiling at all.
 * 4096 is one envelope over one small record with an opaque provider token in
 * it; anything that wants more is asking to be a payload column and should have
 * to argue that here, in this constant, rather than in a row of the registry.
 */
const MAX_SEALED_ENTRY_LENGTH = 4096;

function sealedEntryFor(domain: string): SealedDomainEntry | undefined {
  return SEALED_ENVELOPE_DOMAINS.find(
    (entry) => entry.domain === domain || bareName(entry.domain) === bareName(domain),
  );
}

interface TypeRef {
  readonly base: string;
  readonly args: readonly string[];
  readonly isArray: boolean;
}

function parseTypeRef(type: string): TypeRef {
  let text = type.trim().toLowerCase();
  let isArray = false;
  while (text.endsWith('[]')) {
    isArray = true;
    text = text.slice(0, -2).trim();
  }
  const open = text.indexOf('(');
  if (open === -1) return { base: text, args: [], isArray };
  const close = text.lastIndexOf(')');
  const args = text
    .slice(open + 1, close)
    .split(',')
    .map((a) => a.trim());
  return { base: text.slice(0, open).trim(), args, isArray };
}

/** `control.tenant_id` and `tenant_id` address the same declaration. */
function bareName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

type CheckShape =
  | { readonly kind: 'regex'; readonly pattern: string }
  | { readonly kind: 'in-list'; readonly values: readonly string[] }
  | { readonly kind: 'unsupported'; readonly why: string };

/**
 * POSIX regexes and JavaScript regexes agree on plain anchors, literals and
 * character classes, which is all these domains use. Anything that could mean
 * two different things in the two dialects is refused rather than guessed at —
 * a guard that mistranslates a pattern is worse than no guard, because it
 * reports a pass it did not establish.
 */
function isTranslatablePattern(pattern: string): boolean {
  return !/\\|\[\[:|\(\?/.test(pattern);
}

function parseCheckShape(rawExpr: string): CheckShape {
  let expr = rawExpr.trim();
  while (expr.startsWith('(') && readGroup(expr, 0).next === expr.length) {
    expr = expr.slice(1, -1).trim();
  }
  const regex = /^value\s*~\s*'((?:[^']|'')*)'$/i.exec(expr);
  if (regex) return { kind: 'regex', pattern: regex[1]!.replace(/''/g, "'") };
  const inList = /^value\s+in\s*\(([\s\S]*)\)$/i.exec(expr);
  if (inList) {
    const values = [...inList[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) =>
      m[1]!.replace(/''/g, "'"),
    );
    return { kind: 'in-list', values };
  }
  return { kind: 'unsupported', why: expr };
}

interface DomainVerdict {
  readonly safe: boolean;
  readonly why: string;
  /** Present only for a domain the guard could fully understand. */
  readonly accepts: ((value: string) => boolean) | undefined;
}

function judgeDomain(domain: DomainDecl): DomainVerdict {
  const type = parseTypeRef(domain.baseType);
  if (type.isArray) {
    return { safe: false, why: `domain ${domain.name} is an array domain`, accepts: undefined };
  }
  if (NON_TEXTUAL_BUILTINS.has(type.base)) {
    return { safe: true, why: `domain ${domain.name} is non-textual`, accepts: undefined };
  }
  if (!TEXTUAL_BUILTINS.has(type.base)) {
    return {
      safe: false,
      why: `domain ${domain.name} has unclassified base type '${domain.baseType}'`,
      accepts: undefined,
    };
  }
  if (type.base !== 'varchar' && type.base !== 'character varying') {
    return {
      safe: false,
      why: `domain ${domain.name} is built on unbounded '${type.base}'`,
      accepts: undefined,
    };
  }
  const lengthArg = type.args[0];
  const length = lengthArg === undefined ? Number.NaN : Number.parseInt(lengthArg, 10);
  if (!Number.isFinite(length)) {
    return { safe: false, why: `domain ${domain.name} declares no length bound`, accepts: undefined };
  }
  // A registered sealed domain is the one thing allowed past the prose ceiling,
  // and it buys that with the probes below — including the bearer-shaped ones
  // no other domain here is asked to reject. An unregistered domain that wants
  // 2048 characters is refused exactly as before.
  const registered = sealedEntryFor(domain.name);
  const ceiling =
    registered === undefined
      ? MAX_TEXT_DOMAIN_LENGTH
      : Math.min(registered.maxLength ?? MAX_SEALED_DOMAIN_LENGTH, MAX_SEALED_ENTRY_LENGTH);
  if (length > ceiling) {
    return {
      safe: false,
      why: `domain ${domain.name} allows ${length} characters (ceiling ${ceiling})`,
      accepts: undefined,
    };
  }

  const shapes = domain.checks.map(parseCheckShape);
  if (shapes.length === 0) {
    return {
      safe: false,
      why: `text domain ${domain.name} pins no alphabet — a bound alone holds prose`,
      accepts: undefined,
    };
  }
  const unsupported = shapes.find((s) => s.kind === 'unsupported');
  if (unsupported && unsupported.kind === 'unsupported') {
    return {
      safe: false,
      why: `domain ${domain.name} carries a CHECK this guard cannot read: ${unsupported.why}`,
      accepts: undefined,
    };
  }

  const predicates: ((value: string) => boolean)[] = [];
  for (const shape of shapes) {
    if (shape.kind === 'regex') {
      if (!shape.pattern.startsWith('^') || !shape.pattern.endsWith('$')) {
        return {
          safe: false,
          why: `domain ${domain.name} has an unanchored pattern '${shape.pattern}' — it constrains nothing about the rest of the value`,
          accepts: undefined,
        };
      }
      if (!isTranslatablePattern(shape.pattern)) {
        return {
          safe: false,
          why: `domain ${domain.name} has a pattern this guard will not translate: '${shape.pattern}'`,
          accepts: undefined,
        };
      }
      const compiled = new RegExp(shape.pattern);
      predicates.push((value) => compiled.test(value));
    } else if (shape.kind === 'in-list') {
      const values = new Set(shape.values);
      predicates.push((value) => values.has(value));
    }
  }

  const accepts = (value: string): boolean =>
    value.length <= length && predicates.every((p) => p(value));
  return { safe: true, why: `domain ${domain.name} is bounded and alphabet-pinned`, accepts };
}

interface TypeIndex {
  readonly enums: ReadonlyMap<string, EnumDecl>;
  readonly domains: ReadonlyMap<string, DomainDecl>;
  readonly verdicts: ReadonlyMap<string, DomainVerdict>;
}

function indexTypes(schema: Schema): TypeIndex {
  const enums = new Map<string, EnumDecl>();
  for (const declared of schema.enums) {
    enums.set(declared.name, declared);
    enums.set(bareName(declared.name), declared);
  }
  const domains = new Map<string, DomainDecl>();
  const verdicts = new Map<string, DomainVerdict>();
  for (const declared of schema.domains) {
    const verdict = judgeDomain(declared);
    for (const key of [declared.name, bareName(declared.name)]) {
      domains.set(key, declared);
      verdicts.set(key, verdict);
    }
  }
  return { enums, domains, verdicts };
}

/**
 * The guard proper. Returns one finding per column that could hold content.
 * An empty array is the only passing result.
 */
function findContentShapedColumns(
  schema: Schema,
  allowlist: readonly AllowlistEntry[] = CONTENT_FREE_ALLOWLIST,
): string[] {
  const types = indexTypes(schema);
  const findings: string[] = [];
  const allowed = new Set(allowlist.map((e) => `${e.table}.${e.column}`));

  for (const table of schema.tables) {
    for (const column of table.columns) {
      const where = `${table.name}.${column.name}`;
      if (allowed.has(where)) continue;
      const ref = parseTypeRef(column.type);
      const key = types.enums.has(ref.base) || types.domains.has(ref.base) ? ref.base : bareName(ref.base);

      if (types.enums.has(key)) continue;

      const verdict = types.verdicts.get(key);
      if (verdict) {
        if (!verdict.safe) findings.push(`${where}: ${verdict.why}`);
        continue;
      }
      if (NON_TEXTUAL_BUILTINS.has(ref.base)) {
        if (ref.isArray) findings.push(`${where}: array columns are not classified by this guard`);
        continue;
      }
      if (TEXTUAL_BUILTINS.has(ref.base)) {
        findings.push(
          `${where}: raw '${column.type}' — a textual column must be typed by a domain that names its alphabet`,
        );
        continue;
      }
      findings.push(`${where}: unclassified type '${column.type}' — failing closed`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Probes. Values the control plane must be incapable of storing.
// ---------------------------------------------------------------------------

/**
 * Prose. If any text domain accepts one of these, some column in the schema can
 * hold a sentence, and the control plane is not content-free.
 */
const PROSE_PROBES: readonly string[] = [
  'a note about the meeting',
  'Hello, world.',
  'x y',
  'It was the best of times, it was the worst of times.',
  'multi\nline',
  'Subject: lunch tomorrow?',
  '   ',
  'a'.repeat(400),
];

/**
 * Secret material. The control plane stores a *reference* to a connection
 * string; the string itself lives in the secret store (R11, `secrets.ts`). A
 * connection string is a URL, and no alphabet here admits `:` or `@`, so the
 * column cannot hold one even by mistake.
 *
 * The honest limit: a high-entropy bearer is shaped exactly like a slug, so no
 * alphabet can exclude it. What keeps it out is that these columns are
 * references and U2 writes references — which is why this probe set stops at
 * the class the schema really can exclude.
 */
const SECRET_SHAPED_PROBES: readonly string[] = [
  'postgres://tenant:redacted@db.example.invalid/brainz',
  'postgresql://user:pw@ep.example.invalid:5432/brainz?sslmode=require',
  'https://api.example.invalid/v2/projects',
];

/**
 * Bare credentials, in the shape this system actually mints.
 *
 * The paragraph above admits that no alphabet can exclude a high-entropy bearer
 * from a *reference* column, because a bearer looks like a slug. A sealed
 * envelope column can exclude it, and must: the whole argument for letting
 * secret material into this database is that only a sealed envelope fits, and a
 * column that would also accept the plaintext it seals has not made that
 * argument. `mintTenantBearer` produces the first shape; the others are what a
 * hurried operator or a half-written migration would paste.
 */
/**
 * An envelope the shipped sealing module actually produced, over a payload the
 * size the store really holds. Built here rather than hand-written, so the SQL
 * and `src/control/sealed.ts` cannot drift apart without this file noticing.
 */
const SAMPLE_ENVELOPE = await seal(
  await importSealingKey('A'.repeat(43)),
  'tenant/t-0000000000000000000000',
  JSON.stringify({
    connectionString:
      'postgresql://brainz_owner:npg_0000000000000000@ep-example-00000000.eu-central-1.aws.neon.invalid/brainz?sslmode=require',
    bearerGrant: 't-0000000000000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }),
);

const BEARER_SHAPED_PROBES: readonly string[] = [
  // The `<tenant-id>.<random>` shape `mintTenantBearer` produces. The id half
  // is all zeroes on purpose: this repository is public, and a real tenant id
  // is an account identifier even when the token beside it is invented.
  't-0000000000000000000000.aGVsbG8gdGhlcmUgZnJpZW5kIHRoaXMgaXMgbm90IHJlYWw',
  'brz-this-is-not-a-credential-0000',
  'sk-this-is-not-a-credential-00000',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
];

// ---------------------------------------------------------------------------
// Fixtures for the go-red cases. A guard that has only ever been green has not
// been shown to guard anything (the discipline `check-ledger.test.ts` sets).
// ---------------------------------------------------------------------------

const FIXTURE_PRELUDE = `
CREATE DOMAIN control.tenant_id AS varchar(63)
  CONSTRAINT tenant_id_is_a_slug CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');
`;

function fixture(columns: string): Schema {
  return parseSchema(`${FIXTURE_PRELUDE}
CREATE TABLE control.tenant (
  tenant_id control.tenant_id NOT NULL,
  ${columns}
  CONSTRAINT tenant_pkey PRIMARY KEY (tenant_id)
);
`);
}

// ---------------------------------------------------------------------------

const schema = parseSchema(SCHEMA_SQL);
const typeIndex = indexTypes(schema);

function table(name: string): TableDecl {
  const found = schema.tables.find((t) => t.name === name || bareName(t.name) === name);
  if (!found) throw new Error(`schema declares no table '${name}'`);
  return found;
}

function column(tableName: string, columnName: string): ColumnDecl {
  const found = table(tableName).columns.find((c) => c.name === columnName);
  if (!found) throw new Error(`table '${tableName}' declares no column '${columnName}'`);
  return found;
}

function domainVerdict(name: string): DomainVerdict {
  const verdict = typeIndex.verdicts.get(name);
  if (!verdict) throw new Error(`schema declares no domain '${name}'`);
  return verdict;
}

interface ProbeableDomain {
  readonly name: string;
  readonly accepts: (value: string) => boolean;
}

function textDomainsOf(parsed: Schema): ProbeableDomain[] {
  const out: ProbeableDomain[] = [];
  for (const declared of parsed.domains) {
    const verdict = judgeDomain(declared);
    if (verdict.accepts) out.push({ name: declared.name, accepts: verdict.accepts });
  }
  return out;
}

/**
 * Every text domain in **every** control-plane SQL file, not just this one.
 *
 * The probe tests used to read `schema.sql` alone, which was the same gap the
 * per-file enumeration closed for columns: a future control-plane file — and
 * `src/control/secret-store.sql` is now one — could declare a domain no probe
 * ever ran at. A guard that only inspects the file it was written for is a guard
 * with an expiry date.
 */
function textDomains(): ProbeableDomain[] {
  const out: ProbeableDomain[] = [];
  for (const [path, sql] of SQL_SOURCES) {
    if (!path.startsWith(CONTROL_PREFIX)) continue;
    for (const domain of textDomainsOf(parseSchema(sql))) out.push(domain);
  }
  return out;
}

const TENANT_TABLE = 'control.tenant';

describe('the control plane is content-free', () => {
  test('no column in the schema is content-shaped', () => {
    expect(findContentShapedColumns(schema)).toEqual([]);
  });

  test('the schema actually declares columns to check', () => {
    // Guards against the parser silently reading nothing and reporting a pass.
    expect(schema.tables.length).toBeGreaterThan(0);
    expect(table(TENANT_TABLE).columns.length).toBeGreaterThanOrEqual(20);
    expect(schema.unrecognized).toEqual([]);
  });

  test('every text domain rejects prose', () => {
    const failures: string[] = [];
    for (const domain of textDomains()) {
      for (const probe of PROSE_PROBES) {
        if (domain.accepts(probe)) failures.push(`${domain.name} accepts ${JSON.stringify(probe)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('no column can hold a connection string or any other URL-shaped secret', () => {
    const failures: string[] = [];
    for (const domain of textDomains()) {
      for (const probe of SECRET_SHAPED_PROBES) {
        if (domain.accepts(probe)) failures.push(`${domain.name} accepts ${JSON.stringify(probe)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('every enum label is identifier-shaped, not a phrase', () => {
    const failures: string[] = [];
    for (const declared of schema.enums) {
      for (const label of declared.labels) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(label)) {
          failures.push(`${declared.name} declares label ${JSON.stringify(label)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('the allowlist is empty, and any future entry must carry a justification', () => {
    expect(CONTENT_FREE_ALLOWLIST).toEqual([]);
    for (const entry of CONTENT_FREE_ALLOWLIST) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
  });
});

describe('a sealed envelope is the only secret the control plane may hold', () => {
  function sealedDomains(): ProbeableDomain[] {
    return textDomains().filter((domain) => sealedEntryFor(domain.name) !== undefined);
  }

  test('the registry is not empty, and every entry argues for itself', () => {
    // The mirror of the empty-allowlist test: an empty registry here would mean
    // the rule below is being asserted about nothing.
    expect(SEALED_ENVELOPE_DOMAINS.length).toBeGreaterThan(0);
    for (const entry of SEALED_ENVELOPE_DOMAINS) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
    expect(sealedDomains().map((d) => d.name)).toEqual(
      SEALED_ENVELOPE_DOMAINS.map((entry) => entry.domain),
    );
  });

  test('an entry that asks for more room than the registry’s default argues for it, and is still bounded', () => {
    // The escape hatch inside the escape hatch. A registry where one envelope
    // needs 4096 characters must not hand 4096 to every other one, and "it
    // needed a bit more" must not become a payload column: the extra is declared
    // per entry, and the per-entry declaration is itself capped.
    for (const entry of SEALED_ENVELOPE_DOMAINS) {
      if (entry.maxLength === undefined) continue;
      expect(entry.maxLength).toBeGreaterThan(MAX_SEALED_DOMAIN_LENGTH);
      expect(entry.maxLength).toBeLessThanOrEqual(MAX_SEALED_ENTRY_LENGTH);
      // The argument for the extra room has to be in the entry, not in a commit
      // message: the default bound is already justified, so a domain that wants
      // past it owes a longer sentence than one that does not.
      expect(entry.because).toContain('bound is');
    }
  });

  test('a sealed domain rejects a bare bearer grant, which no reference column can', () => {
    const failures: string[] = [];
    for (const domain of sealedDomains()) {
      for (const probe of BEARER_SHAPED_PROBES) {
        if (domain.accepts(probe)) failures.push(`${domain.name} accepts ${JSON.stringify(probe)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('a sealed domain accepts what the sealing module actually produces', () => {
    // The other direction, and it is not symmetry for its own sake: a pattern
    // tightened until nothing fits would pass every rejection test above and
    // fail every insert in production. This is the pairing between the SQL and
    // `src/control/sealed.ts` — one of them cannot move without the other.
    const sealed = sealedDomains();
    expect(sealed.length).toBeGreaterThan(0);
    for (const domain of sealed) {
      expect(domain.accepts(SAMPLE_ENVELOPE)).toBe(true);
    }
  });

  test('no sealed column lives on the tenant row', () => {
    // The tenant row keeps `connection_secret_ref` and `bearer_secret_ref`, and
    // they still cannot hold a secret. Secret material lives in its own table
    // with its own lifetime — a revoke is a DELETE there and leaves the tenant
    // row intact — and putting an envelope on this row would make the two
    // inseparable again.
    const sealedNames = new Set(SEALED_ENVELOPE_DOMAINS.map((entry) => bareName(entry.domain)));
    const found = table(TENANT_TABLE)
      .columns.filter((c) => sealedNames.has(bareName(parseTypeRef(c.type).base)))
      .map((c) => c.name);
    expect(found).toEqual([]);
  });
});

describe('the content-free guard goes red', () => {
  test('a raw text column fails, whatever it is called', () => {
    for (const name of ['summary', 'note', 'harmless_looking_id']) {
      expect(findContentShapedColumns(fixture(`${name} text,`))).toEqual([
        `control.tenant.${name}: raw 'text' — a textual column must be typed by a domain that names its alphabet`,
      ]);
    }
  });

  test('a jsonb payload column fails', () => {
    expect(findContentShapedColumns(fixture('payload jsonb,'))).toHaveLength(1);
  });

  test('a bytea column fails', () => {
    expect(findContentShapedColumns(fixture('blob bytea,'))).toHaveLength(1);
  });

  test('an unbounded varchar column fails', () => {
    expect(findContentShapedColumns(fixture('label varchar,'))).toHaveLength(1);
  });

  test('a bounded varchar column fails — a length bound is not a content guarantee', () => {
    // The case a naive guard passes: 200 characters holds a whole paragraph.
    expect(findContentShapedColumns(fixture('note varchar(200),'))).toHaveLength(1);
  });

  test('a registered domain cannot declare its way past the per-entry cap', () => {
    // The mutation to fear on the per-entry bound: an entry raises its own
    // `maxLength` to whatever its column happens to declare, and the cap becomes
    // a value that follows the schema instead of constraining it.
    const declared = SEALED_ENVELOPE_DOMAINS.map((entry) => entry.maxLength ?? MAX_SEALED_DOMAIN_LENGTH);
    expect(Math.max(...declared)).toBeLessThanOrEqual(MAX_SEALED_ENTRY_LENGTH);

    const oversized = parseSchema(`
CREATE DOMAIN control.connector_envelope AS varchar(${MAX_SEALED_ENTRY_LENGTH + 1})
  CONSTRAINT connector_envelope_is_a_v1_envelope
  CHECK (VALUE ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$');
`);
    const verdict = judgeDomain(oversized.domains[0]!);
    expect(verdict.safe).toBe(false);
    expect(verdict.why).toContain(`ceiling ${MAX_SEALED_ENTRY_LENGTH}`);
  });

  test('an unregistered domain cannot buy itself the sealed ceiling', () => {
    const oversized = parseSchema(`
CREATE DOMAIN control.roomy AS varchar(2048)
  CONSTRAINT roomy_is_pinned CHECK (VALUE ~ '^[A-Za-z0-9_-]{1,2048}$');
`);
    const verdict = judgeDomain(oversized.domains[0]!);
    expect(verdict.safe).toBe(false);
    expect(verdict.why).toContain(`ceiling ${MAX_TEXT_DOMAIN_LENGTH}`);
  });

  test('a sealed domain loosened to admit a connection string fails the probes', () => {
    // The mutation to fear on this rule: somebody widens the alphabet to "fix"
    // a value that would not store, and the column silently becomes able to
    // hold the plaintext it exists to keep out.
    const loosened = parseSchema(`
CREATE DOMAIN control.sealed_envelope AS varchar(2048)
  CONSTRAINT sealed_envelope_is_a_v1_envelope CHECK (VALUE ~ '^[ -~]{1,2048}$');
`);
    const verdict = judgeDomain(loosened.domains[0]!);
    expect(verdict.safe).toBe(true); // … it satisfies the structural rule …
    expect(verdict.accepts?.(SECRET_SHAPED_PROBES[0]!)).toBe(true); // … and the probe catches it
    expect(verdict.accepts?.(BEARER_SHAPED_PROBES[0]!)).toBe(true);
  });

  test('a sealed domain tightened until nothing fits fails the acceptance case', () => {
    const useless = parseSchema(`
CREATE DOMAIN control.sealed_envelope AS varchar(2048)
  CONSTRAINT sealed_envelope_is_a_v1_envelope CHECK (VALUE ~ '^v2[.][A-Za-z0-9_-]{16}$');
`);
    expect(judgeDomain(useless.domains[0]!).accepts?.(SAMPLE_ENVELOPE)).toBe(false);
  });

  test('a domain permissive enough to hold prose fails the probes', () => {
    const permissive = parseSchema(`
CREATE DOMAIN control.free_text AS varchar(200)
  CONSTRAINT looks_constrained CHECK (VALUE ~ '^.*$');
`);
    const verdict = judgeDomain(permissive.domains[0]!);
    expect(verdict.safe).toBe(true); // it satisfies the *structural* rule …
    expect(verdict.accepts?.('a note about the meeting')).toBe(true); // … and the probe catches it
  });

  test('an unanchored domain pattern fails', () => {
    const unanchored = parseSchema(`
CREATE DOMAIN control.sloppy AS varchar(63)
  CONSTRAINT sloppy_check CHECK (VALUE ~ '[a-z0-9-]+');
`);
    expect(judgeDomain(unanchored.domains[0]!).safe).toBe(false);
  });

  test('a text domain with no alphabet at all fails', () => {
    const bare = parseSchema('CREATE DOMAIN control.bare AS varchar(63);');
    expect(judgeDomain(bare.domains[0]!).safe).toBe(false);
  });

  test('a CHECK the guard cannot read is a failure, not a pass', () => {
    const opaque = parseSchema(`
CREATE DOMAIN control.opaque AS varchar(63)
  CONSTRAINT opaque_check CHECK (length(VALUE) < 40);
`);
    expect(judgeDomain(opaque.domains[0]!).safe).toBe(false);
  });

  test('a CHECK written without a space is still seen', () => {
    // Formatting must not be able to hide a constraint — or its absence.
    const tight = parseSchema(
      "CREATE DOMAIN control.tight AS varchar(63) CHECK(VALUE ~ '^[a-z]{1,63}$');",
    );
    expect(tight.domains[0]!.checks).toHaveLength(1);
    expect(judgeDomain(tight.domains[0]!).safe).toBe(true);
  });

  test('an unrecognized type fails closed', () => {
    expect(findContentShapedColumns(fixture('mystery some_undeclared_type,'))).toEqual([
      "control.tenant.mystery: unclassified type 'some_undeclared_type' — failing closed",
    ]);
  });

  test('a second table inherits the guard — U10 cannot smuggle a payload past it', () => {
    // The schema header claims U10's typed job table lands in this same file
    // and gets typed columns rather than a `jsonb` payload. That claim is only
    // worth something if the guard reads every table, not just the tenant row.
    const withJobs = parseSchema(`${FIXTURE_PRELUDE}
CREATE TABLE control.tenant (
  tenant_id control.tenant_id NOT NULL,
  CONSTRAINT tenant_pkey PRIMARY KEY (tenant_id)
);
CREATE TABLE control.job (
  tenant_id control.tenant_id NOT NULL,
  payload jsonb NOT NULL
);
`);
    expect(withJobs.tables).toHaveLength(2);
    expect(findContentShapedColumns(withJobs)).toEqual([
      "control.job.payload: raw 'jsonb' — a textual column must be typed by a domain that names its alphabet",
    ]);
  });

  test('the allowlist mechanism works, and the same column fails without an entry', () => {
    const withNote = fixture('note text,');
    expect(findContentShapedColumns(withNote, [])).toHaveLength(1);
    expect(
      findContentShapedColumns(withNote, [
        {
          table: 'control.tenant',
          column: 'note',
          because: 'fixture only — exercises the escape hatch so it is not dead code',
        },
      ]),
    ).toEqual([]);
  });
});

describe('nullability follows the invariant, and every column is classified', () => {
  /**
   * NOT NULL because the row is meaningless without them: identity, lifecycle
   * state, and every counter a later unit reads without a null check. A
   * nullable counter is a null-propagation bug in U10's scheduler query and a
   * silently skipped cap in U20's metering.
   */
  const REQUIRED_NOT_NULL: readonly string[] = [
    'tenant_id',
    'state',
    'tier',
    'schema_version',
    'fts_language',
    'pending_debt',
    'rank1_score_sum',
    'rank1_sample_count',
    'spend_micro_usd',
    'spend_window_started_at',
    // R22's half of the same window. NOT NULL for the same reason its sibling
    // is: a null here is a hosted-COGS total that reads as "unknown" the moment
    // one tenant is missing from a `sum()`, which is indistinguishable from a
    // margin nobody can account for.
    'hosted_cogs_micro_usd',
    'created_at',
    'updated_at',
    'provisioning_started_at',
    'provisioning_attempts',
    // The fencing token. NOT NULL because "which attempt owns this row" has an
    // answer from the moment the row exists: a nullable lease would make the
    // compare-and-set that protects a live tenant silently skippable.
    'provisioning_lease',
  ];

  /**
   * Nullable **on purpose**, and the purpose is always "this has not happened
   * yet". These are what make a half-provisioned tenant expressible: the seven
   * provisioning artifacts are absent until their step succeeds, so a run that
   * dies mid-sequence leaves a row that says exactly how far it got. The four
   * timestamps distinguish "never" from "long ago", which U10's debounce needs
   * and a zero default would erase. `spend_cap_micro_usd` NULL means "platform
   * default", and `failure_code` is set only in the failed state.
   */
  const NULLABLE_BY_DESIGN: readonly string[] = [
    'neon_project_id',
    'neon_branch_id',
    'neon_database',
    'neon_role',
    'connection_secret_ref',
    'bearer_secret_ref',
    'storage_prefix',
    'last_activity',
    'last_cycle_at',
    'next_due_at',
    'spend_cap_micro_usd',
    'ready_at',
    'failure_code',
  ];

  test('every required column is NOT NULL', () => {
    const failures = REQUIRED_NOT_NULL.filter((name) => !column(TENANT_TABLE, name).notNull);
    expect(failures).toEqual([]);
  });

  test('every deliberately-absent column is nullable', () => {
    const failures = NULLABLE_BY_DESIGN.filter((name) => column(TENANT_TABLE, name).notNull);
    expect(failures).toEqual([]);
  });

  test('every column in the table is classified as one or the other', () => {
    // The ledger discipline applied to columns: a capability may be declined
    // but never silently forgotten. A new column must land in one of the two
    // lists above, which forces its author to state the invariant.
    const classified = new Set([...REQUIRED_NOT_NULL, ...NULLABLE_BY_DESIGN]);
    const declared = table(TENANT_TABLE).columns.map((c) => c.name);
    expect(declared.filter((name) => !classified.has(name))).toEqual([]);
    expect([...classified].filter((name) => !declared.includes(name))).toEqual([]);
  });

  test('the reader notices when a required column loses its NOT NULL', () => {
    const relaxed = parseSchema(`${FIXTURE_PRELUDE}
CREATE TABLE control.tenant (
  tenant_id control.tenant_id NOT NULL,
  pending_debt integer DEFAULT 0,
  CONSTRAINT tenant_pkey PRIMARY KEY (tenant_id)
);
`);
    const relaxedColumn = relaxed.tables[0]!.columns.find((c) => c.name === 'pending_debt');
    expect(relaxedColumn?.notNull).toBe(false);
  });
});

describe('a half-provisioned tenant is distinct from a ready one', () => {
  const PROVISIONING_ARTIFACTS: readonly string[] = [
    'neon_project_id',
    'neon_branch_id',
    'neon_database',
    'neon_role',
    'connection_secret_ref',
    'bearer_secret_ref',
    'storage_prefix',
    'ready_at',
  ];

  function tenantCheck(name: string): ConstraintDecl {
    const found = table(TENANT_TABLE).constraints.find((c) => c.name === name);
    if (!found) throw new Error(`table declares no constraint '${name}'`);
    return found;
  }

  test('the lifecycle states name every stage provisioning can stop at', () => {
    const states = schema.enums.find((e) => bareName(e.name) === 'tenant_state');
    expect(states?.labels).toEqual(['provisioning', 'ready', 'failed', 'deleting']);
  });

  test('a freshly inserted row is provisioning, never ready', () => {
    // Provisioning is a sequence; the row exists before the sequence finishes,
    // so the default has to be the incomplete state or a crash mid-sequence
    // leaves a row that claims to be servable.
    expect(column(TENANT_TABLE, 'state').defaultExpr).toBe("'provisioning'");
  });

  test('ready requires every provisioning artifact to be present', () => {
    const check = tenantCheck('ready_tenants_are_fully_provisioned');
    for (const artifact of PROVISIONING_ARTIFACTS) {
      expect(check.expr).toContain(artifact);
    }
    expect(check.expr.replace(/\s+/g, ' ')).toContain("state <> 'ready'");
  });

  test('the failed state names a machine-readable code, never a message', () => {
    // The obvious design is `failure_reason text`, and it is exactly how user
    // content — a filename, a query, a connection string in an error body —
    // gets into a content-free database. An enum cannot carry a payload.
    const check = tenantCheck('failed_tenants_name_a_code');
    expect(check.expr).toContain('failure_code');
    expect(bareName(column(TENANT_TABLE, 'failure_code').type)).toBe('provisioning_failure');
    expect(typeIndex.enums.has('provisioning_failure')).toBe(true);
  });

  test('a stale half-provisioned row is findable so U2 can clean up after itself', () => {
    const reaper = schema.indexes.find((i) => i.predicate?.includes("'provisioning'"));
    expect(reaper?.columns).toContain('provisioning_started_at');
    expect(column(TENANT_TABLE, 'provisioning_attempts').notNull).toBe(true);
  });

  test('the artifacts are nullable, which is what makes the half state expressible', () => {
    for (const artifact of PROVISIONING_ARTIFACTS) {
      expect(column(TENANT_TABLE, artifact).notNull).toBe(false);
    }
  });
});

describe('isolation invariants are schema facts, not conventions', () => {
  test('no two tenants can share a Neon project (R9, structural isolation)', () => {
    const index = schema.indexes.find((i) => i.columns.includes('neon_project_id'));
    expect(index?.unique).toBe(true);
    expect(index?.predicate).toBe('neon_project_id IS NOT NULL');
  });

  test('no two tenants can share an object-storage prefix', () => {
    const index = schema.indexes.find((i) => i.columns.includes('storage_prefix'));
    expect(index?.unique).toBe(true);
    expect(index?.predicate).toBe('storage_prefix IS NOT NULL');
  });

  /**
   * The measured hazard, `scripts/probes/r2-boundary/RESULT.md`: R2 matches
   * `prefixes` **literally**, so a credential scoped to `tenant-a` read
   * `tenant-abc/` and got the sibling tenant's object back. The platform
   * enforces the string it was given, not a boundary at the separator. The
   * terminator is therefore a required control, and this is the cheapest place
   * to make it unforgeable: a prefix without its trailing `/` is not a value
   * this column can hold.
   */
  test('an object prefix without its trailing separator is not storable', () => {
    const verdict = domainVerdict('control.object_prefix');
    expect(verdict.safe).toBe(true);
    const accepts = verdict.accepts;
    expect(accepts).toBeDefined();
    if (!accepts) return;

    // The layouts the storage accessor may legitimately derive: a bare tenant
    // segment, or one under a root segment. The column stores what the accessor
    // derived; it does not re-derive it (see the note on the CHECK below).
    expect(accepts('tenant-a/')).toBe(true);
    expect(accepts('tenants/tenant-a/')).toBe(true);

    // The terminator, and the traversal shapes, stay refused.
    expect(accepts('tenant-a')).toBe(false);
    expect(accepts('tenants/tenant-a')).toBe(false);
    expect(accepts('tenant-abc')).toBe(false);
    expect(accepts('tenant-a/../tenant-b/')).toBe(false);
    expect(accepts('tenant-a//')).toBe(false);
    expect(accepts('/tenant-a/')).toBe(false);
  });

  /**
   * The prefix belongs to this tenant — but the *layout* is the storage
   * accessor's to decide, not this column's. `src/README.md` and U2 approach
   * step 4 both put derivation in one accessor; a schema that re-derived it
   * would be a second derivation site, which is the thing the invariant exists
   * to prevent. So the constraint pins the property that matters (the final
   * segment is this tenant's id, which is what kills the `alice` / `alice2`
   * sibling hazard) and stays silent on everything above it.
   */
  test('the prefix ends in this tenant, whatever layout the accessor chose', () => {
    const check = table(TENANT_TABLE).constraints.find(
      (c) => c.name === 'storage_prefix_belongs_to_this_tenant',
    );
    const expr = check?.expr.replace(/\s+/g, ' ');
    expect(expr).toContain("storage_prefix = tenant_id || '/'");
    expect(expr).toContain("storage_prefix LIKE '%/' || tenant_id || '/'");
  });

  test('the tenant id alphabet excludes the LIKE wildcards that CHECK relies on', () => {
    // The constraint above builds a LIKE pattern out of `tenant_id`. That is
    // only sound while `%` and `_` cannot appear in a tenant id — otherwise a
    // crafted id would widen its own constraint. The alphabet is pinned to
    // `secrets.ts` by the test below; this is the reason it must stay pinned.
    const accepts = domainVerdict('control.tenant_id').accepts;
    expect(accepts).toBeDefined();
    if (!accepts) return;

    expect(accepts('tenant%a')).toBe(false);
    expect(accepts('tenant_a')).toBe(false);
    expect(accepts('%')).toBe(false);
  });

  test('the tenant id domain agrees with the secret store on what a tenant id is', () => {
    // `secrets.ts` turns a tenant id into a secret-store namespace; this column
    // is the same id. If the two disagree, an id that is legal in one is
    // unaddressable in the other, and the disagreement surfaces mid-provision.
    const verdict = domainVerdict('control.tenant_id');
    const accepts = verdict.accepts;
    expect(accepts).toBeDefined();
    if (!accepts) return;

    const samples = [
      'tenant-a',
      'a',
      'a1-b2-c3',
      'x'.repeat(63),
      'x'.repeat(64),
      '',
      'Tenant-A',
      '-leading-dash',
      'tenant_a',
      'tenant a',
      '../tenant-b',
      'tenant-a/../tenant-b',
    ];
    const disagreements = samples.filter((s) => accepts(s) !== isValidTenantId(s));
    expect(disagreements).toEqual([]);
  });
});

describe('the file is structurally sound', () => {
  test('every statement is a kind the reader recognizes', () => {
    expect(schema.unrecognized).toEqual([]);
  });

  test('the last statement is terminated', () => {
    expect(stripComments(SCHEMA_SQL).trim().endsWith(';')).toBe(true);
  });

  test('parentheses balance outside string literals', () => {
    const text = stripComments(SCHEMA_SQL);
    let depth = 0;
    let inString = false;
    let lowest = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "'") {
          if (text[i + 1] === "'") i++;
          else inString = false;
        }
        continue;
      }
      if (ch === "'") inString = true;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      lowest = Math.min(lowest, depth);
    }
    expect({ depth, lowest, inString }).toEqual({ depth: 0, lowest: 0, inString: false });
  });

  test('every declared type is used by a column', () => {
    // The other direction — a column typed by something undeclared — is not
    // checked here because it is not a style issue: `findContentShapedColumns`
    // fails it closed as an unclassified type.
    const used = new Set(
      schema.tables.flatMap((t) => t.columns.map((c) => bareName(parseTypeRef(c.type).base))),
    );
    const declared = [...schema.enums, ...schema.domains].map((d) => bareName(d.name));
    expect(declared.filter((name) => !used.has(name))).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// Which SQL files this guard covers, and what happens to one it does not.
//
// The content-free rule belongs to the *control plane*, not to SQL in general:
// U3's `src/schema/tenant.sql` holds the user's own words by design, and a
// guard that failed on it would be deleted rather than obeyed. So every SQL
// file in `src/` is enumerated and then classified — under `src/control/` it is
// content-free-guarded, and anywhere else it must be named here with a reason.
// An unclassified file is a finding, which means a new schema file cannot be
// added silently in either direction: the author either accepts the guard or
// writes down why it does not apply.
// ---------------------------------------------------------------------------

interface ContentBearingEntry {
  readonly path: string;
  readonly because: string;
}

const CONTENT_BEARING_SQL: readonly ContentBearingEntry[] = [
  {
    path: 'schema/tenant.sql',
    because:
      "the per-tenant schema holds the user's own chunks and their text by design, one database per tenant; the content-free rule is the control plane's property, not a property of SQL in general, and a guard that failed on this file would be deleted rather than obeyed",
  },
  {
    path: 'schema/migrations/v2-knowledge-core.sql',
    because:
      "U3's knowledge core — pages, facts, entities, edges and contradiction reports — is the same per-tenant database as the file above, one rung further up the ladder; it holds the user's own documents and the statements extracted from them by design, and it is the tenant's database rather than the control plane's",
  },
  {
    path: 'schema/migrations/v3-consolidation.sql',
    because:
      "U11's consolidation rung — run records, per-phase checkpoints, entity cards, commitments, the review queue and the deterministic tier's clusters — is the same per-tenant database two rungs further up; the cards and commitments quote the user's own documents by design, and the run and checkpoint tables sit beside them in the tenant rather than in the control plane",
  },
  {
    path: 'schema/migrations/v4-briefing.sql',
    because:
      "U12's briefing rung holds no user content at all — a grant-derived caller key, two timestamps and a band number — so the content-free rule would pass over it; it is named here rather than exempted because the classification list is what makes a new schema file impossible to add silently, and a file that happens to be content-free today is exactly the one a later column gets added to",
  },
  {
    path: 'schema/migrations/v5-occurred-at.sql',
    because:
      "the event-time rung adds one column to the tenant's own `page` table, and what it holds is content: a `Date` header, a calendar start, a Drive `modifiedTime`, each asserted by whoever sent the item; it belongs to the same per-tenant database as the rungs above and nothing about it reaches the control plane",
  },
  {
    path: 'schema/migrations/v6-attachment-external-ref.sql',
    because:
      "the deletion-handle rung adds one column to the tenant's own `attachment` table, and a provider's id for a provider's object is content in the same sense `occurred_at` is: the sender chose it, it decides nothing about access, and it names a file inside one tenant's own database; the control plane holds ids, counters, timestamps, tier and connection-string references, and a Drive file id is none of those",
  },
  {
    path: 'schema/migrations/v7-panel-settings.sql',
    because:
      "U14's panel-settings rung holds no user content: a policy name from a closed set, a connector name from a closed set, a timestamp, and which surface authorised a pause. It is named here rather than exempted for the reason rung 4 gives — a file that happens to be content-free today is exactly the one a later column gets added to — and it lives in the tenant rather than the control plane because a user's own preference is theirs, and the spend cap, which genuinely is a control-plane counter, stays on the control-plane row where it already was",
  },
  {
    path: 'schema/migrations/v8-search-path-pinned.sql',
    because:
      "H6's rung adds no table and no column at all: eight trigger functions with `SET search_path` pinned, and one twin trigger per trigger that called an unpinned one. So it holds no content in the sense this list means — but it is emphatically the tenant's database rather than the control plane's, because what it pins is R15's origin fence, and the origin fence is the mechanism that decides which of a user's own rows a fenced read may reach. It is named here rather than exempted for the reason rung 4 gives, and with one extra: a rung whose whole subject is an enforcement mechanism is the last one that should be able to arrive without a sentence from its author",
  },
  {
    path: 'schema/migrations/v10-severance.sql',
    because:
      "U18's severance rung holds no user content and is emphatically the tenant's own database. One append-only table: the origin severed, the instant it happened, two count objects, and the origins that survived — every column a record of something observed, which is the rule rungs 5, 6, 7 and 9 each restate. It is named here rather than exempted for the reason rung 4 gives, and with rung 8's extra: what it records is the outcome of an operation that changes which of a user's rows a fenced read may reach, so it carries R15's scalar origin, the immutability trigger and rung 8's pinned twin. The counts could in principle narrow to content — a count of one over a brain of one is a fact about that row — which is precisely why they are counts of tables rather than of anything a user typed, and why the recompute worklist is DERIVED from this row rather than stored as a flag on the rows themselves",
  },
  {
    path: 'schema/migrations/v11-alias-origin.sql',
    because:
      "the alias-provenance rung adds one column to the tenant's own `entity_alias` table, and what that table holds is content: `resolveOrCreateEntity` plants the normalized surface form taken from the text of the page being ingested, so every row in it is a spelling somebody wrote in a message. The column itself is an origin rather than content — it is R15's union, and it arrives with the immutability trigger and rung 8's pinned twin for the reason rung 8 gives, that a rung whose whole subject is an enforcement mechanism is the last one that should arrive without a sentence from its author. It is emphatically the tenant's database: the origin fence is what decides which of a user's own rows a fenced read may reach, and this column is what lets the entity card decide it for the alias vocabulary, which previously it could not",
  },
  {
    path: 'schema/migrations/v12-severed-alias.sql',
    because:
      "rung 12 holds content, and the same content rung 11 classified: `severed_alias` is where an alias goes while a context severance is undoable, and every row in it is a spelling somebody wrote in a message — `resolveOrCreateEntity` plants the normalized surface form taken from the text being ingested. It is the tenant's own database emphatically: it exists because `entity_alias` is the one derived table this schema deliberately lets be narrower than its parent, so it is the one table whose exact-origin rows can outlive a severance the entity survives, and it carries R15's origin union with the immutability trigger and rung 8's pinned twin for the reason rung 8 gives. Its `severed_at` is deliberately not spelled `deleted_at`: presence in this table IS the retraction, and the tombstone census in `src/mcp/tombstone.ts` neither claims it nor should",
  },
  {
    path: 'schema/migrations/v13-embedding-seat-1024.sql',
    because:
      "rung 13 holds content, in the one form this schema's content most often takes: an embedding is a lossy but real encoding of the user's own words, which is why `chunk.embedding` has always lived in the tenant's database and not the control plane's, and this rung adds a second column of exactly that kind beside it on `chunk` and on `fact`. It is the tenant's database emphatically — the vectors are what a fenced read ranks, so the rows carrying them carry R15's origin through their existing tables and inherit the immutability trigger those tables already have. The rung adds no table and therefore no `COMMENT ON TABLE`, which is why it is named here rather than caught by the per-table class rule: it is two `ADD COLUMN`s and two indexes on tables rungs 1 and 2 already classified, and a rung that adds a column to a content table is adding content",
  },
  {
    path: 'schema/migrations/v14-fact-seat-nullable.sql',
    because:
      "rung 14 holds content in exactly the sense rung 13 does, and touches it in the one way this schema otherwise forbids: it relaxes `fact.embedding`'s NOT NULL so a fact embedded by the 1024 seat can exist at all, and replaces the invariant that constraint was carrying with `fact_embedded_in_some_seat`, a CHECK across both seats' columns. The rows are the user's own claims and their vectors, so they are emphatically the tenant's database and carry R15's origin union through `fact`, with the immutability trigger that table already has. It adds no table and therefore no `COMMENT ON TABLE`, which is why it is named here rather than caught by the per-table class rule. What is worth a reader's attention is not the content class but the action: `ALTER COLUMN … DROP NOT NULL` is the one action of that family the expand-only scanner admits, because it widens what the table accepts and rewrites nothing a live previous release queries — `test/schema/fleet-surface.ts:FLEET_13_SURFACE` is what pays for that claim rather than the sentence you are reading",
  },
  {
    path: 'schema/migrations/v15-fleet-auth-failure.sql',
    because:
      "rung 15 holds no user content and adds no column: it drops and re-adds one CHECK on the tenant's own `ingest_log`, widening `failure_code`'s alphabet by one label so a run can record that brainz's own fleet-wide credential failed to mint rather than that this user's grant was revoked. It is named here rather than exempted for the reason rung 4 gives — a rung that happens to be content-free today is exactly the one a later column gets added to — and it is emphatically the tenant's database, because `ingest_log` is where a poll's own record of what it fetched lives and the control plane holds only the counters and codes derived from it. What is worth a reader's attention is the action rather than the class: `DROP CONSTRAINT` is admitted by the expand-only scanner only as half of a same-name re-add, because a CHECK cannot be widened any other way, and `test/schema/fleet-surface.ts:FLEET_14_SURFACE` is what pays for the claim that the replacement is wider rather than the sentence you are reading",
  },
  {
    path: 'schema/migrations/v17-embed-cause-split.sql',
    because:
      "rung 17 holds no user content and adds no column: like rungs 15 and 16 it drops and re-adds one CHECK on the tenant's own `ingest_log`, widening `failure_code`'s alphabet by two labels so a run can record WHICH way the embedder was unreachable — a credential that would not resolve, which is an operator's configuration and which waiting never fixes, or a provider that refused, which usually fixes itself. Under the single rung-16 code those two were indistinguishable, and looking in the wrong one is expensive. `embed_unavailable` is kept rather than replaced, because it is the honest answer for an embed failure that is neither and because rewriting existing rows to a cause inferred after the fact would be inventing history. It is emphatically the tenant's database, `ingest_log` being where a poll's own record lives, and `DROP CONSTRAINT` is admitted by the expand-only scanner only as half of a same-name re-add",
  },
  {
    path: 'schema/migrations/v16-embed-unavailable.sql',
    because:
      "rung 16 holds no user content and adds no column: like rung 15 it drops and re-adds one CHECK on the tenant's own `ingest_log`, widening `failure_code`'s alphabet by one label so a run can record that the embedding gateway could not be reached at all rather than that one item's provider refused it. The distinction is not cosmetic — the embed backlog is a query over every chunk in the tenant with no source filter, so an unanswerable gateway stops gmail, calendar and drive in the same tick, and under the old single code that picture was indistinguishable from three unrelated bad items. It is named here rather than exempted for the reason rung 4 gives, and it is emphatically the tenant's database because `ingest_log` is where a poll's own record lives. `DROP CONSTRAINT` is admitted by the expand-only scanner only as half of a same-name re-add, because a CHECK cannot be widened any other way, and the replacement is a strict superset of the seven-label constraint it replaces",
  },
  {
    path: 'schema/migrations/v18-retraction.sql',
    because:
      "rung 18 holds no user content and is deliberately built so that it cannot start to: `retraction` is one row per `forget` carrying the instant, which of four id kinds was retracted, the origins the fence had already read, and the cascade's own counts — no title, no statement, no excerpt, and no id pointing at what went, because an id into the thing a user asked to be rid of tells a human nothing and would invite a per-record restore the executor cannot perform. It exists because the 72-hour window had a recovery key and no way to be entered: `restoreForgotten` answers 'undo this instant' and nothing could answer 'what may I undo', and the set of instants derivable from the content tables mixes in subject erasure, which stamps the same seven tables and which a restore structurally cannot undo. So provenance is positively sourced from this table rather than filtered from another. It is emphatically the tenant's database — it carries R15's origin union with the immutability trigger and rung 8's pinned twin, because it is the row a restore surface reads to decide what it may offer — and its lifetime is bounded by the purge on the same cutoff as the rows it describes, which is the condition on which a record of what somebody retracted is allowed to exist at all. Its instant is spelled `retracted_at` rather than `deleted_at` for the reason rung 12 spells its own `severed_at`: this table carries no tombstone, and the census in `src/mcp/tombstone.ts` neither claims it nor should. The rung also adds one nullable column to `severance`, so a restored severance stops being offered while the append-only audit row it is derived from survives",
  },
  {
    path: 'schema/migrations/v19-cycle-resume.sql',
    because:
      "rung 19 holds no user content, adds no table and adds no column: one widened CHECK on `consolidation_run`, which rung 3 already classified as operational and which carries counters, an instant and a label from a closed enum. It is named here rather than exempted for the reason rung 4 gives — a rung that is content-free today is exactly the one a later column gets added to, and the temptation on this table specifically is real: the obvious 'improvement' is to record *what* a phase was working on, and a page title in an operational table is a leak with a plausible motive. An earlier draft of this rung did add a position column to `consolidation_checkpoint` so an interrupted free tier could resume; it was removed with the machinery that read it, which is why the file is one statement long and the checkpoint's subject stays what rung 3 made it. `DROP CONSTRAINT` appears and is admitted by the expand-only scanner only as half of a same-name re-add, because a CHECK cannot be widened any other way, and the replacement adds exactly one label — `out_of_time`, for a cycle that stopped on the attempt's wall clock with work left rather than because a cap fired or a provider was down",
  },
  {
    path: 'schema/migrations/v20-stopped-phase.sql',
    because:
      "rung 20 holds no user content and adds two columns to `consolidation_run`, which rung 3 already classified as operational: which phase a cycle stopped in and the code that phase stopped with. Both are labels from closed sets the code can enumerate — `CYCLE_PHASES` and `PHASE_STOPS` in `src/worker/consolidate/phases.ts` — and each is guarded by a CHECK that spells the whole alphabet out, which is the point rather than a formality. This is the table rung 19's entry warned about by name: the obvious 'improvement' on 'synopsis stopped' is to record *what it was summarising*, and a page title in an operational table is a leak with a plausible motive. Twelve phase names and five stop codes cannot become one. It is emphatically the tenant's database because the run record has always lived beside the work it describes, and the rung exists because a production brain sat at `stop_reason = 'phase_failed'` with a flat fact count while everything that named the cause lived only in the worker's memory and on a container's stdout nothing outside the container can read. The third CHECK pairs the two columns — half an attribution is either a stop with no stated reason or the aggregate reason under a second name — and nothing here is tied to `stop_reason` or `dreamt`, deliberately: with a lookahead of one rung the previous release resumes and completes runs this one attributed, and a cross-column CHECK would refuse the UPDATE it has always issued",
  },
  {
    path: 'schema/migrations/v21-unreadable-page.sql',
    because:
      "rung 21 adds two columns to `page`, which is the most content-bearing table in the schema, and neither of them holds any: `consolidation_refusals` is a count of how many times a model phase durably refused that page, and `quarantine_reason` is one label from a two-member subset of `PHASE_STOPS` spelled out in a CHECK. The temptation rung 19 warned about and rung 20 met is at its sharpest here, because this time the row IS the user's document — the obvious 'improvement' on 'this page was retired' is to say what it was about or to keep the provider's sentence explaining why, and either would put an excerpt beside the excerpt-free codes the rest of the cycle records. A CHECK against two words is the refusal, held by the database rather than by whoever writes the next materializer. It is emphatically the tenant's database because `page` is where the user's own documents live. The rung exists because the skip that let one unreadable page be stepped over only deferred the freeze it was written to fix: a skipped page writes nothing, so the candidate set converges onto the unreadable pages until they are all that is left and the phase's consecutive bound trips on its first three calls every cycle — so a page has to be able to LEAVE the set, and these two columns are what make that defensible rather than silent. The counter in particular is the safety property and not bookkeeping: quarantining on a transient failure would drop a good page from consolidation forever with no symptom at all, so a page must accumulate durable refusals across independent cycles before it goes, and an operator un-quarantines by clearing all three columns together. The rung also drops and re-adds `consolidation_run_stopped_phase_code_is_known` under the same name, which is the only way a CHECK is widened and the one shape the expand-only scanner admits, to add `input_rejected` — the provider refusing the request rather than the connection, which is the distinction that licenses everything above",
  },
  {
    path: 'schema/migrations/v9-lifecycle.sql',
    because:
      "U17's lifecycle rung holds content, and one of its four tables holds the most of any table in the schema: `page_version` stores whole document bodies, because `page` has no body column and a version a revert cannot read is not a version. It is the tenant's database emphatically — it is a second copy of every document the user has, so it carries R15's scalar origin, the immutability trigger and rung 8's pinned twin, and a fenced read reaches it exactly as it reaches `page`. The other three are content-free by shape and are named here anyway, for the reason rung 4 gives: `self_export` is a destination name from a closed set plus timestamps and a digest; `self_export_nag` is a grant-derived caller key, a timestamp and a band number; and `erased_subject` is deliberately a **digest** of a correspondent's identifier rather than the identifier, because a tombstone whose purpose is that we hold nothing about someone must not be the one place we kept their address",
  },
];

const CONTROL_PREFIX = 'control/';

function findUnclassifiedSql(
  paths: readonly string[],
  classified: readonly ContentBearingEntry[] = CONTENT_BEARING_SQL,
): string[] {
  const named = new Set(classified.map((entry) => entry.path));
  const findings: string[] = [];

  for (const path of paths) {
    if (path.startsWith(CONTROL_PREFIX)) continue;
    if (named.has(path)) continue;
    findings.push(
      `${path}: no classification — say whether the control plane's content-free rule applies to it`,
    );
  }

  return findings;
}

describe('every SQL file in the tree is accounted for', () => {
  test('the enumeration finds the control-plane schema', () => {
    // An empty glob must fail rather than pass: a guard that enumerates nothing
    // reports green for everything.
    expect(SQL_FILES.length).toBeGreaterThanOrEqual(1);
    expect(SQL_FILES).toContain(CONTROL_SCHEMA);
    expect(SQL_SOURCES.get(CONTROL_SCHEMA)).toBe(SCHEMA_SQL);
  });

  test('no SQL file in src/ is unclassified', () => {
    expect(findUnclassifiedSql(SQL_FILES)).toEqual([]);
  });

  test('every control-plane SQL file is content-free, not just this one', () => {
    const findings: string[] = [];
    for (const [path, sql] of SQL_SOURCES) {
      if (!path.startsWith(CONTROL_PREFIX)) continue;
      const parsed = parseSchema(sql);
      // Same fail-closed reading the primary file gets: a parser that shrugged
      // at an unfamiliar statement would be a guard that unusual DDL disables.
      for (const statement of parsed.unrecognized) {
        findings.push(`${path}: unrecognized statement ${JSON.stringify(statement.slice(0, 60))}`);
      }
      for (const finding of findContentShapedColumns(parsed)) findings.push(`${path}: ${finding}`);
    }
    expect(findings).toEqual([]);
  });

  test('a future SQL file outside the control plane is a finding until someone classifies it', () => {
    // `schema/tenant.sql` was the concrete case and is now classified above, so
    // the example moves to a file that does not exist yet — U21's media path is
    // the next schema expected outside the control plane. The point of the test
    // is unchanged: a new schema file stops this suite until its author states,
    // in writing, whether it holds user content on purpose.
    expect(findUnclassifiedSql(['control/schema.sql', 'schema/media.sql'])).toEqual([
      "schema/media.sql: no classification — say whether the control plane's content-free rule applies to it",
    ]);
  });

  test('a classified file is accepted, and its justification is not a shrug', () => {
    const classified: ContentBearingEntry[] = [
      {
        path: 'schema/tenant.sql',
        because:
          'the per-tenant schema holds the user\'s own documents and chunks by design; the content-free rule is the control plane\'s, not this file\'s',
      },
    ];
    expect(findUnclassifiedSql(['schema/tenant.sql'], classified)).toEqual([]);
    for (const entry of [...classified, ...CONTENT_BEARING_SQL]) {
      expect(entry.because.length).toBeGreaterThan(40);
    }
  });

  test('a future control-plane SQL file is guarded without being listed anywhere', () => {
    // The half the hardcoded path could not do. U10's job table is expected to
    // land in this directory, and it inherits the guard by living there.
    const jobs = parseSchema(`
CREATE DOMAIN control.tenant_id AS varchar(63)
  CONSTRAINT tenant_id_is_a_slug CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');
CREATE TABLE control.job (
  tenant_id control.tenant_id NOT NULL,
  payload jsonb,
  CONSTRAINT job_pkey PRIMARY KEY (tenant_id)
);
`);
    expect(findContentShapedColumns(jobs)).toHaveLength(1);
    expect(findUnclassifiedSql(['control/jobs.sql'])).toEqual([]);
  });
});
