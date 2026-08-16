/**
 * The canary tenant — U16's externally-runnable isolation check.
 *
 * ```
 * bun evals/isolation-canary.ts --endpoint https://<host>/mcp --token <bearer>
 * bun evals/isolation-canary.ts --endpoint … --token … --database-url postgres://…
 * ```
 *
 * **Two jobs in one command, and they belong together.** For an outside party
 * it is the check that brainz's isolation claims are still true on the live
 * deployment: a published known record they can ask for and compare, and a
 * signed attestation they can verify against a published key. For an operator it
 * is the post-deploy path check — extensions, GUCs, vector indexes, the job
 * queue — because the things that quietly stop being true after a deploy are the
 * same things a stranger's read depends on.
 *
 * **`deferred` is never `pass`, and this is the whole discipline.** Every check
 * a run could not make reports `deferred` with the reason and the thing it
 * needed. A run with nothing gradeable exits non-zero rather than returning a
 * green tick for having checked nothing — the rule `evals/canary.ts` already
 * applies to the model-judged tier and `evals/gates.ts` applies to a deferred
 * floor that would pass. Without an `--endpoint` **every** check is deferred, so
 * a bare invocation is honest about being an inventory rather than a result.
 *
 * **It needs no credential of ours.** The token is the caller's own — theirs, on
 * their own tenant, or the canary tenant's published read-only bearer. Nothing
 * here embeds a secret, which is what makes "an outside party can run it from
 * the published docs" true rather than aspirational.
 *
 * **What is deferred until there is a deployment**, listed once so no result is
 * mistaken for it: there is no provisioned canary tenant yet, no published
 * verification key (the attestation signer is a fake — see the
 * `attestation-signing-key` entry in `docs/register.md`), and no nightly
 * schedule. The checks are written and runnable; what they need is a host.
 */

import {
  isSigned,
  verifyAttestation,
  type AttestationSigner,
  type SignedAttestation,
} from '../src/mcp/attestation.ts';
import { HNSW_EF_SEARCH_DEFAULT } from '../src/schema/vector-query.ts';
import { INDEXED_VECTOR_COLUMNS } from '../src/schema/vector-index.ts';

export type Outcome = 'pass' | 'fail' | 'deferred';

/** What a check needs before it can produce anything but `deferred`. */
export type Requirement =
  | 'mcp_endpoint'
  | 'database_url'
  | 'control_database_url'
  | 'published_verification_key';

export interface CanaryCheck {
  readonly id: string;
  /** What is being asserted, in the words a stranger would need. */
  readonly asserts: string;
  readonly needs: Requirement;
  /** Why it is worth checking after every deploy. */
  readonly why: string;
}

export interface CheckResult {
  readonly id: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

export interface CanaryReport {
  readonly ok: boolean;
  readonly endpoint: string | null;
  readonly results: readonly CheckResult[];
  readonly counts: { readonly pass: number; readonly fail: number; readonly deferred: number };
}

/**
 * The published known record.
 *
 * **A canary whose expected answer is private is a canary only we can read.**
 * These exact bytes are what the canary tenant holds and what a stranger's
 * `recall` must return, so they live in the published source rather than in a
 * fixture nobody outside can see. They deliberately contain no person, no
 * company and nothing anyone could mistake for real content — the canary tenant
 * is a public brain, and a public brain that quoted a real message would be the
 * privacy failure H5 cards.
 */
export const CANARY_KNOWN_RECORD = {
  title: 'brainz canary record',
  /** The query a caller sends. */
  query: 'canary record marker',
  /** The substring the answer must contain, verbatim. */
  marker: 'BRAINZ-CANARY-0001 this record exists so a stranger can check that reads still work',
} as const;

export const CANARY_CHECKS: readonly CanaryCheck[] = [
  {
    id: 'attestation.present',
    asserts: 'every response carries the `brainz.app/brain` receipt in `_meta`',
    needs: 'mcp_endpoint',
    why: 'A claim you have to ask for proves a claim; one stamped on every response is a property. If it stops riding along, every other assertion here becomes unverifiable without anybody noticing.',
  },
  {
    id: 'attestation.tenant',
    asserts: 'the receipt names the tenant the presented credential belongs to',
    needs: 'mcp_endpoint',
    why: 'A receipt naming a different tenant is either a routing bug or a fleet serving one tenant’s data under another’s credential, which is the failure the whole product is against.',
  },
  {
    id: 'attestation.signed',
    asserts: 'the receipt is signed, and its signature verifies against the published verification key',
    needs: 'published_verification_key',
    why: 'An unsigned receipt is a claim. A signed one is a proof only if the key is not the fleet’s to read — see `docs/register.md`, `attestation-signing-key`. And it is only a proof if somebody checked the signature: matching the key *id* is something anyone who has seen one receipt can do, so a receipt named right and signed by nothing must never grade as a pass.',
  },
  {
    id: 'boundary.database',
    asserts: 'the receipt reports the database boundary as `structural`, with the tenant’s own endpoint host and database name',
    needs: 'mcp_endpoint',
    why: 'R9: one Neon project, one branch, one database, one role per tenant — verifiable by connection string. The receipt is where a tenant gets to check that against the string they were given.',
  },
  {
    id: 'boundary.storage.not_overclaimed',
    asserts: 'the storage boundary is reported as conditional on prefix derivation, and NOT as unconditionally structural',
    needs: 'mcp_endpoint',
    why: 'R9 measured the object store matching prefixes literally rather than at a separator. A deploy that started reporting this as plain `structural` would be a receipt that keeps verifying after the property stops holding — so the over-claim is the failure, not the under-claim.',
  },
  {
    id: 'known_record.readable',
    asserts: 'the published canary record comes back from a read, byte for byte',
    needs: 'mcp_endpoint',
    why: 'The end-to-end check a stranger can make: the fleet is up, the tenant’s database is reachable, the schema is servable, retrieval returns, and the bytes are the published ones.',
  },
  {
    id: 'definitions.digest',
    asserts: 'the advertised tool definitions hash to the digest the receipt reports',
    needs: 'mcp_endpoint',
    why: 'A silent change to a tool’s name, description, schema or annotations is a change to what an enterprise admin approved. The digest makes it visible instead of a surprise at review time.',
  },
  {
    id: 'path.extensions',
    asserts: 'the tenant database has the `vector` extension installed',
    needs: 'database_url',
    why: 'Post-deploy path check. A tenant provisioned without it answers every semantic read by failing, and the failure looks like an empty brain.',
  },
  {
    id: 'path.guc.ef_search',
    asserts: '`hnsw.ef_search` is a REGISTERED setting, so the `SET LOCAL` every vector scan issues is honoured rather than accepted and ignored',
    needs: 'database_url',
    why: 'H1, the hazard that opens `docs/porting-hazards.md`. brainz does not rely on a database default — `withVectorScan` raises `ef_search` per transaction — so checking the default would measure the wrong thing. What can silently be wrong is whether the setting EXISTS: Postgres accepts any `prefix.name` custom GUC, so on a database where pgvector is not loaded `SET LOCAL hnsw.ef_search = 200` succeeds, changes nothing, and every read truncates at 40 with no error anywhere.',
  },
  {
    id: 'path.indexes',
    asserts: 'every indexed vector column really carries an HNSW index',
    needs: 'database_url',
    why: 'H2. A missing index does not break anything: the query plans as a sequential scan, returns correct rows, and gets slower with every write until it times out.',
  },
  {
    id: 'path.queue',
    asserts: 'the job queue is present and not wedged — no lease older than an hour',
    needs: 'control_database_url',
    why: 'Consolidation, embedding backfill and connector pulls all run through it. A wedged queue is a brain that stops learning while continuing to answer, which no read-side check can see.',
  },
  {
    id: 'path.search_path_pinned',
    asserts: 'every trigger function pins `search_path` (H6)',
    needs: 'database_url',
    why: 'R15’s origin fence resolves its own table references. Unpinned, its enforcement is a property of whoever is calling it — and the fence is what decides which of a user’s rows a fenced read may reach.',
  },
];

/** The minimal JSON-RPC client. No dependency, no secret, no cleverness. */
async function callTool(
  endpoint: string,
  token: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ content: unknown; meta: Record<string, unknown> }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });

  if (!response.ok) throw new Error(`${tool}: HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: { content?: unknown; structuredContent?: unknown; _meta?: Record<string, unknown> };
    error?: { message?: string };
  };
  if (body.error !== undefined) throw new Error(`${tool}: ${body.error.message ?? 'rpc error'}`);
  return {
    content: body.result?.structuredContent ?? body.result?.content ?? null,
    meta: body.result?._meta ?? {},
  };
}

export interface CanaryOptions {
  readonly endpoint?: string | undefined;
  readonly token?: string | undefined;
  readonly databaseUrl?: string | undefined;
  /**
   * The control plane, which is a DIFFERENT database from the tenant's.
   *
   * `control.job` lives there, not in the tenant — KTD1 puts one database per
   * tenant and the queue is fleet-wide by construction. The first version of this
   * probe asked the tenant database for a `job` table and reported a failure that
   * meant nothing; running it for real is what found that.
   */
  readonly controlDatabaseUrl?: string | undefined;
  readonly tenantId?: string | undefined;
  /**
   * The published verification key's identifier, when one is published.
   *
   * **On its own this can only ever produce `fail` or `deferred`.** A key id
   * says which key a receipt *names*; it says nothing about whether that key
   * signed. A mismatch is decisive — the receipt names some other key — and a
   * match is not, so a match without {@link CanaryOptions.verifier} defers.
   */
  readonly verificationKey?: string | undefined;
  /**
   * What can actually check the MAC.
   *
   * A verifier rather than raw key bytes, for the reason `attestation.ts` gives:
   * the shipped signer is symmetric, and an API taking a key would invite a
   * caller to pass the *signing* key around as though it were public. It is
   * injected — like `call` and `query` — because who can verify depends on the
   * scheme. An outside party holding only the published digest of an HMAC key
   * cannot verify anything and gets a `deferred` that says so; a deployment
   * whose signer publishes a real public key hands one in and earns the pass.
   */
  readonly verifier?: Pick<AttestationSigner, 'verify'> | undefined;
  /** Injected so the suite can drive this without a network. */
  readonly call?: typeof callTool;
  /** Injected so the suite can drive the database half without a database. */
  readonly query?: (sql: string) => Promise<Record<string, unknown>[]>;
  readonly controlQuery?: (sql: string) => Promise<Record<string, unknown>[]>;
}

/** `deferred`, with the reason stated in the words the check itself used. */
function deferFor(check: CanaryCheck): CheckResult {
  const reason: Record<Requirement, string> = {
    mcp_endpoint: 'no --endpoint was given, so nothing was asked of a running deployment',
    database_url:
      'no --database-url was given. This half is the post-deploy path check and needs database access, which an outside party is not expected to have',
    control_database_url:
      'no --control-database-url was given. The job queue lives in the control plane, which is a different database from any tenant\'s',
    published_verification_key:
      'no verification key is published yet: the attestation signer that ships is a fake, and its custody entry in docs/register.md says so',
  };
  return { id: check.id, outcome: 'deferred', detail: reason[check.needs] };
}

export async function runCanary(options: CanaryOptions = {}): Promise<CanaryReport> {
  const call = options.call ?? callTool;
  const results: CheckResult[] = [];

  const byId = new Map(CANARY_CHECKS.map((check) => [check.id, check]));
  const push = (id: string, outcome: Outcome, detail: string): void => {
    results.push({ id, outcome, detail });
  };
  const defer = (id: string): void => {
    const check = byId.get(id);
    if (check !== undefined) results.push(deferFor(check));
  };

  const { endpoint, token } = options;

  if (endpoint === undefined || token === undefined) {
    for (const check of CANARY_CHECKS) {
      // The database halves defer themselves below, and they defer for a
      // different reason. Deferring them here too would double-count them, which
      // the "everything deferred exactly once" assertion caught.
      if (check.needs === 'database_url' || check.needs === 'control_database_url') continue;
      results.push(deferFor(check));
    }
  } else {
    let receipt: SignedAttestation | undefined;
    try {
      const brain = await call(endpoint, token, 'brain');
      receipt = brain.meta['brainz.app/brain'] as SignedAttestation | undefined;

      if (receipt === undefined) {
        push('attestation.present', 'fail', 'the response carried no `brainz.app/brain` stamp in `_meta`');
      } else {
        push('attestation.present', 'pass', 'the receipt rode `_meta` on a `brain` call');
      }

      if (receipt === undefined) {
        push('attestation.tenant', 'fail', 'no receipt to read a tenant from');
        push('boundary.database', 'fail', 'no receipt to read a boundary from');
        push('boundary.storage.not_overclaimed', 'fail', 'no receipt to read a boundary from');
      } else {
        const expected = options.tenantId;
        if (expected === undefined) {
          push(
            'attestation.tenant',
            'deferred',
            'no --tenant was given, so the receipt’s tenant id was read but not compared to one the caller already knew',
          );
        } else if (receipt.tenant_id === expected) {
          push('attestation.tenant', 'pass', `the receipt names ${expected}`);
        } else {
          push(
            'attestation.tenant',
            'fail',
            `the receipt names ${receipt.tenant_id}, and the caller expected ${expected}`,
          );
        }

        push(
          'boundary.database',
          receipt.boundaries.database === 'structural' &&
            receipt.database.name.length > 0 &&
            receipt.project.endpoint_host.length > 0
            ? 'pass'
            : 'fail',
          `database=${receipt.database.name} host=${receipt.project.endpoint_host} boundary=${receipt.boundaries.database}`,
        );

        // The over-claim is the failure. A receipt reporting plain `structural`
        // here would be asserting a property R9 measured as conditional.
        push(
          'boundary.storage.not_overclaimed',
          receipt.boundaries.storage === 'structural_conditional_on_prefix_derivation'
            ? 'pass'
            : 'fail',
          `storage boundary reported as ${JSON.stringify(receipt.boundaries.storage)}`,
        );
      }

      const content = brain.content as { definitions_digest?: string } | null;
      if (receipt === undefined || content?.definitions_digest === undefined) {
        push('definitions.digest', 'fail', 'the `brain` body carried no definitions digest');
      } else {
        push(
          'definitions.digest',
          content.definitions_digest === receipt.definitions_digest ? 'pass' : 'fail',
          `body=${content.definitions_digest} receipt=${receipt.definitions_digest}`,
        );
      }
    } catch (error) {
      for (const id of [
        'attestation.present',
        'attestation.tenant',
        'boundary.database',
        'boundary.storage.not_overclaimed',
        'definitions.digest',
      ]) {
        push(id, 'fail', `the endpoint could not be read: ${String(error)}`);
      }
    }

    try {
      const read = await call(endpoint, token, 'recall', { query: CANARY_KNOWN_RECORD.query });
      const serialized = JSON.stringify(read.content ?? '');
      push(
        'known_record.readable',
        serialized.includes(CANARY_KNOWN_RECORD.marker) ? 'pass' : 'fail',
        serialized.includes(CANARY_KNOWN_RECORD.marker)
          ? 'the published marker came back verbatim'
          : 'the published marker was not in the answer — either this is not the canary tenant, or its record is gone',
      );
    } catch (error) {
      push('known_record.readable', 'fail', `the read failed: ${String(error)}`);
    }

    // Signing is deferred rather than failed while no key is published: a
    // `fail` here would say the deployment is wrong, and what is missing is a
    // key nobody has minted.
    if (options.verificationKey === undefined && options.verifier === undefined) {
      defer('attestation.signed');
    } else if (receipt === undefined) {
      push('attestation.signed', 'fail', 'no receipt to verify');
    } else if (!isSigned(receipt.signature)) {
      push('attestation.signed', 'fail', `the receipt is unsigned: ${receipt.signature.reason}`);
    } else if (
      options.verificationKey !== undefined &&
      receipt.signature.key_id !== options.verificationKey
    ) {
      // Decisive in this direction and only this one: a receipt naming another
      // key was not signed by the published one, whoever else it was signed by.
      push(
        'attestation.signed',
        'fail',
        `signed under ${receipt.signature.key_id}, which is not the published key`,
      );
    } else if (options.verifier === undefined) {
      // **The name matches and nothing has been verified.** This is the branch
      // the check used to call a pass, and calling it one is how the whole R10
      // story became a string comparison: a receipt carrying the right key id
      // and a signature of zeroes read as proof. Whether the MAC is right is
      // simply not answerable from a key id — and for the symmetric signer that
      // ships it is not answerable by an outside party at all, because what is
      // published is a digest of the key rather than the key. So it defers, and
      // this file's first rule is that `deferred` is never `pass`.
      push(
        'attestation.signed',
        'deferred',
        'the receipt names the published key and nothing verified its signature: a key id is not a proof, ' +
          'and the shipped signer is symmetric, so what is published is a digest of the key rather than a key ' +
          'an outside party could check against',
      );
    } else {
      // `verifyAttestation` splits the payload back out of the receipt rather
      // than trusting the two to have stayed together, so a body edited after
      // signing verifies against the edited body and fails.
      const verified = await verifyAttestation(receipt, options.verifier);
      push(
        'attestation.signed',
        verified ? 'pass' : 'fail',
        verified
          ? `the signature under key ${receipt.signature.key_id} verifies against this receipt`
          : `the signature under key ${receipt.signature.key_id} does not verify against this receipt — ` +
            'either it was not signed by that key, or the body was edited after it was',
      );
    }
  }

  results.push(...(await databaseChecks(options)));

  const counts = {
    pass: results.filter((result) => result.outcome === 'pass').length,
    fail: results.filter((result) => result.outcome === 'fail').length,
    deferred: results.filter((result) => result.outcome === 'deferred').length,
  };

  // Green requires something graded AND nothing failed. A run that graded
  // nothing is not a pass, which is the rule the whole file is built on.
  return {
    ok: counts.fail === 0 && counts.pass > 0,
    endpoint: endpoint ?? null,
    results,
    counts,
  };
}

/**
 * One connection for the whole half, opened lazily and closed once.
 *
 * **A connection per query is wrong here, not merely wasteful**, and running
 * this against a real database is what showed it. `path.guc.ef_search` issues a
 * statement whose entire purpose is to make pgvector's library load and register
 * its GUCs — a side effect that belongs to the *session*. With a fresh
 * connection per query, the next statement asked a session where the load had
 * never happened, and the check reported a missing setting on a database that
 * had it. The bug reported the exact hazard it was written to find, which is the
 * worst way for a probe to be wrong.
 */
function connectionRunner(dsn: string): {
  readonly run: (sql: string) => Promise<Record<string, unknown>[]>;
  readonly close: () => Promise<void>;
} {
  let connection: { unsafe(sql: string): unknown; close(): Promise<void> } | undefined;

  return {
    async run(sql: string) {
      if (connection === undefined) {
        const { SQL } = await import('bun');
        connection = new SQL(dsn, { max: 1 }) as unknown as typeof connection;
      }
      return (await connection?.unsafe(sql)) as Record<string, unknown>[];
    },
    async close() {
      await connection?.close();
      connection = undefined;
    },
  };
}

async function databaseChecks(options: CanaryOptions): Promise<CheckResult[]> {
  const results: CheckResult[] = [...(await controlChecks(options))];

  const dbChecks = CANARY_CHECKS.filter((check) => check.needs === 'database_url');
  const query = options.query;

  if (query === undefined && options.databaseUrl === undefined) {
    return [...results, ...dbChecks.map(deferFor)];
  }

  const connection = query === undefined ? connectionRunner(options.databaseUrl ?? '') : undefined;
  const run = query ?? connection?.run;
  if (run === undefined) return [...results, ...dbChecks.map(deferFor)];

  const attempt = async (id: string, body: () => Promise<CheckResult>): Promise<void> => {
    try {
      results.push(await body());
    } catch (error) {
      results.push({ id, outcome: 'fail', detail: `the check could not run: ${String(error)}` });
    }
  };

  await attempt('path.extensions', async () => {
    const rows = await run(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    return {
      id: 'path.extensions',
      outcome: rows.length === 1 ? 'pass' : 'fail',
      detail: rows.length === 1 ? 'the vector extension is installed' : 'no vector extension',
    };
  });

  await attempt('path.guc.ef_search', async () => {
    // The library registers its GUCs when it loads, and it loads when something
    // touches a vector column — so the read below is meaningless on a connection
    // that has not. This statement is the load, and it doubles as proof the
    // tenant schema is there at all.
    await run(`SELECT count(*)::int AS n FROM chunk`);

    const rows = await run(
      `SELECT setting, boot_val FROM pg_settings WHERE name = 'hnsw.ef_search'`,
    );
    const registered = rows.length === 1;
    return {
      id: 'path.guc.ef_search',
      outcome: registered ? 'pass' : 'fail',
      detail: registered
        ? `hnsw.ef_search is a registered setting (default ${String(rows[0]?.['boot_val'] ?? HNSW_EF_SEARCH_DEFAULT)}), so the SET LOCAL every scan issues is honoured`
        : `hnsw.ef_search is not a registered setting on this database — Postgres accepts any prefixed custom GUC, so the SET LOCAL each scan issues succeeds, changes nothing, and every read truncates at ${HNSW_EF_SEARCH_DEFAULT} candidates with no error (H1)`,
    };
  });

  await attempt('path.indexes', async () => {
    const rows = await run(`
      SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am ON am.oid = ic.relam
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE am.amname = 'hnsw'
    `);
    const present = new Set(rows.map((row) => `${String(row['table_name'])}.${String(row['column_name'])}`));
    const missing = INDEXED_VECTOR_COLUMNS.filter(
      (column) => !present.has(`${column.table}.${column.column}`),
    ).map((column) => `${column.table}.${column.column}`);
    return {
      id: 'path.indexes',
      outcome: missing.length === 0 ? 'pass' : 'fail',
      detail:
        missing.length === 0
          ? `${present.size} HNSW indexes present`
          : `no HNSW index on ${missing.join(', ')} — reads still return, by sequential scan (H2)`,
    };
  });

  await attempt('path.search_path_pinned', async () => {
    const { findUnpinnedFenceCoverage } = await import('../src/schema/search-path.ts');
    // The guard reads the catalog through a `sql.unsafe`-shaped call, which is
    // exactly what `run` is. Reusing it rather than restating the query: a
    // canary with its own copy of a guard is a second guard nobody maintains.
    const findings = await findUnpinnedFenceCoverage({
      unsafe: run,
    } as unknown as Parameters<typeof findUnpinnedFenceCoverage>[0]);
    return {
      id: 'path.search_path_pinned',
      outcome: findings.length === 0 ? 'pass' : 'fail',
      detail:
        findings.length === 0
          ? 'every trigger function pins search_path, and every origin column has an enabled pinned trigger'
          : findings.join('; '),
    };
  });

  await connection?.close();
  return results;
}

/**
 * The control plane's half — one check, its own database.
 *
 * Separate because it IS separate: KTD1 gives every tenant its own database and
 * the job queue is fleet-wide, so `control.job` is not in any tenant. The first
 * version of this probe asked a tenant database for a `job` table and reported a
 * failure that meant nothing. Running the artifact for real is what found it,
 * which is the argument for shipping it runnable rather than as a plan.
 */
async function controlChecks(options: CanaryOptions): Promise<CheckResult[]> {
  const checks = CANARY_CHECKS.filter((check) => check.needs === 'control_database_url');
  const query = options.controlQuery;

  if (query === undefined && options.controlDatabaseUrl === undefined) return checks.map(deferFor);
  const connection = query === undefined ? connectionRunner(options.controlDatabaseUrl ?? '') : undefined;
  const run = query ?? connection?.run;
  if (run === undefined) return checks.map(deferFor);

  try {
    const rows = await run(`
      SELECT count(*) FILTER (WHERE lease_expires_at < now() - interval '1 hour')::int AS wedged,
             count(*)::int AS total
      FROM control.job
    `);
    const wedged = Number(rows[0]?.['wedged'] ?? 0);
    return [
      {
        id: 'path.queue',
        outcome: wedged === 0 ? 'pass' : 'fail',
        detail:
          wedged === 0
            ? `the queue is present, ${String(rows[0]?.['total'] ?? 0)} rows, nothing wedged`
            : `${wedged} job(s) hold a lease over an hour old — the brain answers while it has stopped learning`,
      },
    ];
  } catch (error) {
    return [{ id: 'path.queue', outcome: 'fail', detail: `the check could not run: ${String(error)}` }];
  } finally {
    await connection?.close();
  }
}

export function renderReport(report: CanaryReport): string {
  const lines: string[] = [];
  const rule = '─'.repeat(78);
  lines.push(rule);
  lines.push(` brainz isolation canary — ${report.endpoint ?? 'no endpoint given'}`);
  lines.push(rule);

  const glyph: Record<Outcome, string> = { pass: '  ok  ', fail: ' FAIL ', deferred: 'defer ' };
  for (const result of report.results) {
    lines.push(`[${glyph[result.outcome]}] ${result.id}`);
    lines.push(`          ${result.detail}`);
  }

  lines.push(rule);
  lines.push(
    ` ${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts.deferred} deferred.`,
  );
  if (report.counts.pass === 0) {
    lines.push(' Nothing was graded, so this is not a pass. A green tick for having checked');
    lines.push(' nothing is the failure this command is built against.');
  }
  lines.push(rule);
  return lines.join('\n');
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
  const inline = argv.find((entry) => entry.startsWith(`--${name}=`));
  return inline?.slice(`--${name}=`.length);
}

export async function main(argv: readonly string[]): Promise<number> {
  const report = await runCanary({
    endpoint: argOf(argv, 'endpoint'),
    token: argOf(argv, 'token'),
    databaseUrl: argOf(argv, 'database-url'),
    controlDatabaseUrl: argOf(argv, 'control-database-url'),
    tenantId: argOf(argv, 'tenant'),
    verificationKey: argOf(argv, 'verification-key'),
  });

  console.log(renderReport(report));
  return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
