/**
 * The `/admin` surface, and R11's `scope_denied`.
 *
 * **R11, verbatim:** *"The web app's `/admin` credential has zero content-read
 * scope, asserted by a CI case expecting `scope_denied` on `recall`."* And the
 * half that decides whether that case means anything: *"a `scope_denied` on
 * `recall` proves nothing if the same credential can read the connection string
 * and connect directly."*
 *
 * **Where `/admin` lives, and why it is here rather than in the tool surface.**
 * `src/mcp/tools/index.ts` declares `ENDPOINTS = ['mcp', 'openai']`. There is no
 * `admin` endpoint, and adding one is a change to a module U15 does not own. So
 * `/admin` is a web-app surface: it speaks the same nine tool names, and it
 * refuses the content ones itself.
 *
 * **The refusal is a scope decision, not a lookup miss.** That distinction is the
 * whole design of {@link ADMIN_TOOL_SCOPE}: `recall` is a name this surface
 * *knows*, listed beside every other tool name, and deliberately denied. A
 * surface that simply had no `recall` handler would answer `unknown_tool`, which
 * is what a typo answers — and a CI case asserting on it would pass forever, for
 * a reason that has nothing to do with scope.
 *
 * **The containment that makes the refusal worth asserting.** Three properties,
 * and each is a separate test:
 *
 *  1. This module never receives a tenant database handle. {@link AdminDeps}
 *     carries the control plane and nothing else, so there is no connection for a
 *     bug to reach content through — structural, not remembered.
 *  2. The admin identity holds no resolve permission on any tenant namespace
 *     (`secrets.ts`), so it cannot read a connection string and open one itself.
 *  3. The admin credential presented to the real `/mcp` dispatch is refused, and
 *     — the assertion that matters more than the refusal's wording — no tenant
 *     database is opened while it is refused.
 *
 * **What `/admin` may actually do.** Fleet operations over control-plane rows:
 * counts, states, spend totals, queue depth, pool depth. Every one of them is a
 * number about the fleet. None of them is a word a user wrote.
 */

import type { SQL } from 'bun';

/**
 * The nine names on the wire, plus `synthesize`, exactly as
 * `src/mcp/tools/index.ts` lists them.
 *
 * Restated here rather than imported so that this surface's refusal does not
 * depend on another unit's module being loadable — and pinned to that list by
 * `test/web/admin-scope.test.ts`, so a tenth tool cannot appear on the wire
 * without appearing here as a decision.
 */
export const WIRE_TOOL_NAMES: readonly string[] = [
  'recall',
  'search',
  'fetch',
  'entity',
  'briefing',
  'remember',
  'forget',
  'brain',
  'manage',
  'synthesize',
];

/**
 * What `/admin` may do with each tool name it recognises.
 *
 * `denied` for every tool that reads or writes a tenant's content, which is all
 * of them. `brain` and `manage` are denied too, and that is worth saying out
 * loud: `brain` returns counts and an attestation rather than content, and
 * `manage` changes a setting — but both are *tenant-scoped* operations, and an
 * operator surface that could run them for any tenant is an operator surface that
 * can pause a stranger's connector or mint a receipt in their name. Zero
 * content-read scope is the requirement; zero tenant scope is the design.
 */
export const ADMIN_TOOL_SCOPE: Readonly<Record<string, 'denied'>> = Object.freeze(
  Object.fromEntries(WIRE_TOOL_NAMES.map((name) => [name, 'denied'])) as Record<string, 'denied'>,
);

/** The fleet operations `/admin` may run. Every answer is a number or a state. */
export const ADMIN_OPERATIONS = [
  'fleet_status',
  'tenant_status',
  'pool_status',
  'queue_status',
] as const;

export type AdminOperation = (typeof ADMIN_OPERATIONS)[number];

export type AdminRefusalCode = 'scope_denied' | 'unknown_operation' | 'invalid_params';

export type AdminResult =
  | { readonly ok: true; readonly content: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly code: AdminRefusalCode;
      readonly message: string;
      /** Present when the refusal names a tool the wire knows. */
      readonly tool?: string;
    };

/**
 * The scope check, on its own, so R11's case can call exactly the thing that
 * decides.
 *
 * A recognised tool name answers `scope_denied`. An unrecognised name answers
 * `unknown_operation` — and the difference is the point: `recall` is refused
 * because of what it does, not because nobody here has heard of it.
 */
export function adminToolVerdict(name: string): AdminResult {
  if (Object.hasOwn(ADMIN_TOOL_SCOPE, name)) {
    return {
      ok: false,
      code: 'scope_denied',
      tool: name,
      message:
        `The /admin credential has no scope for ${JSON.stringify(name)}. ` +
        'This surface reads fleet counters and nothing inside a brain.',
    };
  }
  return {
    ok: false,
    code: 'unknown_operation',
    message: `No /admin operation named ${JSON.stringify(name)}.`,
  };
}

/**
 * What `/admin` is given.
 *
 * **The control plane and nothing else.** There is no tenant connection here, no
 * secret store, no gateway — not because a handler would be careless with them,
 * but because a capability that is absent cannot be misused, and R11 is a claim
 * about capability rather than about intent.
 */
export interface AdminDeps {
  readonly controlSql: SQL;
}

export interface AdminRequest {
  /** A tool name or an operation name; the caller does not get to say which. */
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

/**
 * The one entry point.
 *
 * Order: the wire tool names first, so a content read is refused as a *scope*
 * decision before anything else runs; then the fleet operations.
 */
export async function adminDispatch(deps: AdminDeps, request: AdminRequest): Promise<AdminResult> {
  if (Object.hasOwn(ADMIN_TOOL_SCOPE, request.name)) return adminToolVerdict(request.name);

  if (!(ADMIN_OPERATIONS as readonly string[]).includes(request.name)) {
    return adminToolVerdict(request.name);
  }

  switch (request.name as AdminOperation) {
    case 'fleet_status':
      return { ok: true, content: await fleetStatus(deps.controlSql) };
    case 'pool_status':
      return { ok: true, content: await poolStatus(deps.controlSql) };
    case 'queue_status':
      return { ok: true, content: await queueStatus(deps.controlSql) };
    case 'tenant_status': {
      const tenantId = request.args?.['tenant_id'];
      if (typeof tenantId !== 'string' || tenantId.length === 0) {
        return { ok: false, code: 'invalid_params', message: 'tenant_id is required.' };
      }
      const status = await tenantStatus(deps.controlSql, tenantId);
      return status === null
        ? { ok: false, code: 'invalid_params', message: 'No such tenant.' }
        : { ok: true, content: status };
    }
  }
}

async function fleetStatus(sql: SQL): Promise<Record<string, unknown>> {
  const rows = await sql<{ state: string; tier: string; n: number }[]>`
    SELECT state::text AS state, tier::text AS tier, count(*)::int AS n
    FROM control.tenant GROUP BY state, tier ORDER BY state, tier`;
  const spend = await sql<{ total: string | null }[]>`
    SELECT sum(spend_micro_usd)::bigint AS total FROM control.tenant`;
  return {
    tenants: rows.map((row) => ({ state: row.state, tier: row.tier, count: row.n })),
    spend_micro_usd: Number(spend[0]?.total ?? 0),
  };
}

async function poolStatus(sql: SQL): Promise<Record<string, unknown>> {
  const rows = await sql<{ state: string; n: number }[]>`
    SELECT state::text AS state, count(*)::int AS n
    FROM control.pool_project GROUP BY state ORDER BY state`;
  return { pool: rows.map((row) => ({ state: row.state, count: row.n })) };
}

async function queueStatus(sql: SQL): Promise<Record<string, unknown>> {
  const rows = await sql<{ state: string; kind: string; n: number }[]>`
    SELECT state::text AS state, kind::text AS kind, count(*)::int AS n
    FROM control.job GROUP BY state, kind ORDER BY state, kind`;
  return { jobs: rows.map((row) => ({ state: row.state, kind: row.kind, count: row.n })) };
}

/**
 * One tenant's operational state.
 *
 * Every column here is a number, a state or an instant. Notably absent:
 * `connection_secret_ref` and `bearer_secret_ref`. They are references rather
 * than secrets, and the schema's alphabets cannot hold a connection string — but
 * an operator surface that printed them would be handing a reader the namespace
 * to go and ask for, and this surface has no reason to name one.
 */
async function tenantStatus(sql: SQL, tenantId: string): Promise<Record<string, unknown> | null> {
  const rows = await sql<
    {
      tenant_id: string;
      state: string;
      tier: string;
      schema_version: number;
      pending_debt: number;
      spend_micro_usd: string;
      last_activity: Date | null;
      last_cycle_at: Date | null;
      next_due_at: Date | null;
    }[]
  >`
    SELECT tenant_id, state::text AS state, tier::text AS tier, schema_version,
           pending_debt, spend_micro_usd, last_activity, last_cycle_at, next_due_at
    FROM control.tenant WHERE tenant_id = ${tenantId}`;

  const found = rows[0];
  if (found === undefined) return null;
  return {
    tenant_id: found.tenant_id,
    state: found.state,
    tier: found.tier,
    schema_version: found.schema_version,
    pending_debt: found.pending_debt,
    spend_micro_usd: Number(found.spend_micro_usd),
    last_activity: found.last_activity,
    last_cycle_at: found.last_cycle_at,
    next_due_at: found.next_due_at,
  };
}
