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
 *     carries the control plane and one address-free port, so there is no
 *     connection for a bug to reach content through — structural, not
 *     remembered. The port ({@link BrainOwnerDirectory}) reaches the *identity*
 *     database, which is a different claim and a much smaller one: that store
 *     holds no brain content by its own schema rule, and what crosses the port
 *     is a domain and a digest rather than a mailbox. What `/admin` may know
 *     about a person is decided by that type, not by this file's discipline.
 *  2. The admin identity holds no resolve permission on any tenant namespace
 *     (`secrets.ts`), so it cannot read a connection string and open one itself.
 *  3. The admin credential presented to the real `/mcp` dispatch is refused, and
 *     — the assertion that matters more than the refusal's wording — no tenant
 *     database is opened while it is refused.
 *
 * **What `/admin` may actually do.** Fleet operations over control-plane rows:
 * counts, states, spend totals, queue depth, pool depth — plus one listing that
 * says which of those rows a person owns ({@link tenantDirectory}), because an
 * operator who cannot answer that deletes brains by prefix and finds out
 * afterwards, and one that says why a tenant's connector is not polling
 * ({@link connectorStatus}), because before it the answer was a job row reading
 * `handler_error` and then nothing. Every one of them is a number, a state, or
 * an identifier the fleet minted. None of them is a word a user wrote.
 *
 * **Property 1 above survives {@link connectorStatus}, and that is the reason it
 * is shaped the way it is.** The detail it reports is written by the worker into
 * a content-free control-plane table rather than read out of the tenant's
 * database through a port — so this module still receives no tenant handle, and
 * the containment stays structural rather than becoming a projection somebody
 * has to keep narrow. `src/control/connector-health.sql` argues the trade.
 */

import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import { grantOperatorTier, revokeOperatorTier } from '../control/billing.ts';
import { causeOf, readConnectorHealth } from '../control/connector-health.ts';
import { discardConnectorLanes } from '../control/connector-lanes.ts';
import { CONNECTOR_SOURCES, isConnectorSource } from '../ingest/cursor.ts';

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

/**
 * The fleet operations `/admin` may run. Every answer is a number, a state or a
 * tenant id, and every argument is a tenant id or a count — never a word a user
 * wrote.
 *
 * `tenant_directory` is the one that answers a question none of the others can,
 * and it is the only one that reaches past the control plane. See
 * {@link BrainOwnerDirectory} for what it may say about a person, and
 * {@link tenantDirectory} for why it exists at all.
 *
 * The last three write, and they are the only writes on this surface. See
 * {@link ADMIN_WRITE_OPERATIONS}. Two of them move one column on
 * `control.tenant`; `requeue_connector` moves one column on `control.job`, and
 * `src/control/connector-lanes.ts` carries what that column means — this surface
 * decides who may ask, not what a state transition is.
 */
export const ADMIN_OPERATIONS = [
  'fleet_status',
  'tenant_directory',
  'tenant_status',
  'pool_status',
  'queue_status',
  'connector_status',
  'requeue_connector',
  'grant_internal_tier',
  'revoke_internal_tier',
] as const;

export type AdminOperation = (typeof ADMIN_OPERATIONS)[number];

/**
 * The operations that change something, and the only ones a GET may not run.
 *
 * **Why the distinction is enforced here rather than left to the router.** This
 * surface is authenticated by a bearer credential in a header, so a browser
 * cannot be tricked into presenting it and CSRF is not the hazard — the hazard
 * is a *link*. A grant reachable by GET is a grant that can be issued by a
 * bookmark, a shell-history recall, a copied URL in a ticket, or a retry of a
 * request an operator meant to make once; and the tenant id sits in the query
 * string of all of them. Requiring the method to say "this changes something"
 * costs one flag and makes the operator's command say what it does.
 *
 * The refusal is `invalid_params` rather than a new code: the caller asked for a
 * write in a shape this surface does not accept, which is what that code already
 * means, and widening `AdminRefusalCode` for one case would put a fourth value
 * in a union three call sites branch on.
 *
 * **`tenant_directory` is deliberately NOT in this set, and the reasoning above
 * is what decides it.** The hazard the method gate answers is a link that
 * *acts*: a URL somebody bookmarks, retries, or pastes into a ticket, which then
 * issues a grant. A read cannot act, so requiring POST of it would buy nothing
 * — and would cost the thing an operator surface most needs, which is that the
 * safe step is the easy one. An operator who has to construct a POST to find out
 * whose brain a tenant is will skip finding out.
 *
 * But the second half of that argument does apply to a read, in a different
 * shape. The directory's own hazard is not the link, it is the **artifact**: the
 * response lands in shell history, in a scrollback, in a screenshot, in a ticket,
 * in a prompt. A customer list is the most portable privacy incident this fleet
 * could produce, and a POST would not have kept it out of any of those places.
 * So the containment is in what comes back rather than in the verb — no address
 * is emitted, and none is accepted as an argument either, so neither the request
 * nor the response is a thing worth exfiltrating. See {@link BrainOwnerDirectory}.
 */
export const ADMIN_WRITE_OPERATIONS: ReadonlySet<string> = new Set<string>([
  'requeue_connector',
  'grant_internal_tier',
  'revoke_internal_tier',
]);

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
 * How many hex characters of the owner digest are published.
 *
 * Enough that two mailboxes in one fleet do not collide by accident, short
 * enough to read off a terminal and compare by eye. `docs/deploy.md` carries the
 * recipe that reproduces it; `test/web/tenant-directory.test.ts` recomputes it
 * from an address, so the two cannot drift apart silently.
 */
export const OWNER_DIGEST_CHARS = 12;

/**
 * One brain's owner, reduced to what an operator may see.
 *
 * **There is no address on this type, and that is the point.** The redaction
 * does not happen in the handler that answers the request — it happens in
 * {@link createBrainOwnerDirectory}, the only function in this module that ever
 * holds an identity-database handle, and everything downstream of it is
 * type-incapable of naming a mailbox. A future operation added to the switch
 * below cannot leak an address by forgetting to redact one, because it is never
 * given one.
 */
export interface BrainOwner {
  readonly tenantId: string;
  /** Everything after the last `@`, verbatim. */
  readonly emailDomain: string;
  /** {@link OWNER_DIGEST_CHARS} hex characters of SHA-256 over the lowercased address. */
  readonly emailDigest: string;
}

/**
 * **`ok: false` is a first-class answer and not an error to swallow.**
 *
 * "I could not see the owners" and "nobody owns these" are different sentences,
 * and an operator acts on them identically if the surface prints the same thing
 * for both. Since the thing they act on is a deletion, the difference is the
 * whole safety property — so the lookup says which it means, and
 * {@link tenantDirectory} refuses rather than guessing.
 */
export type BrainOwnerLookup =
  | { readonly ok: true; readonly owners: readonly BrainOwner[] }
  | { readonly ok: false };

/**
 * Whose brain is whose, with the addresses already gone.
 *
 * **The privacy ruling this type encodes, and the argument for it.** This is a
 * new place personal data flows to, so the question is not "may an operator see
 * an email" — the operator holding this credential can read the identity
 * database directly, and pretending otherwise would be theatre. The question is
 * *what this surface should put into the world*, because what it returns becomes
 * a shell-history line, a ticket attachment, a screenshot and a pasted prompt.
 *
 * So: **a domain and a digest, never a local part.** The domain is the half that
 * answers the operator's actual question — a real mailbox at a real provider,
 * versus a tenant nobody owns — and it is organisational rather than personal.
 * The local part is the half that is the person (`firstname.lastname`,
 * `initial.surname`, a handle they use elsewhere), it identifies them across
 * every other service they hold, and no operator decision needs it.
 *
 * **The digest is containment, not anonymisation, and this file will not
 * overclaim it.** A truncated SHA-256 over a bounded-alphabet address is
 * brute-forceable by anyone motivated, and it is personal data. What it buys is
 * that the *artifact* — the thing that outlives the terminal session — is twelve
 * hex characters instead of a customer list, while an operator who already holds
 * an address can still answer "is this that person's brain?" by computing the
 * same digest locally. The address never enters the request, so it never enters
 * the shell history either; and it never enters the response, so it never enters
 * the ticket.
 *
 * R11 is untouched by any of this. This is the identity database, whose own
 * schema header records that it holds no brain content and is held to the
 * control plane's content-free rule by `test/control/schema.test.ts`. No tenant
 * connection reaches this module, no secret namespace is resolvable from it, and
 * `scope_denied` on `recall` still means what it meant.
 */
export interface BrainOwnerDirectory {
  owners(): Promise<BrainOwnerLookup>;
}

/**
 * An address, reduced to the two fields {@link BrainOwner} allows.
 *
 * **A value with no `@` yields an empty domain rather than itself.** The column's
 * own CHECK makes that unreachable through the database, but the fallback a
 * careless implementation reaches for — "no separator, so the whole string is
 * the domain" — publishes the local part on exactly the input that was odd
 * enough to get there. Exported so the rule is a tested property rather than a
 * line somebody has to notice.
 */
export function redactOwnerEmail(email: string): { emailDomain: string; emailDigest: string } {
  const at = email.lastIndexOf('@');
  return {
    emailDomain: at < 0 ? '' : email.slice(at + 1),
    // Lowercased here as well as by the column, so the digest an operator
    // computes from an address they typed matches whatever case they typed it in.
    emailDigest: createHash('sha256')
      .update(email.toLowerCase())
      .digest('hex')
      .slice(0, OWNER_DIGEST_CHARS),
  };
}

/**
 * The one function in this module that holds an identity-database handle.
 *
 * It reads `account.brain` joined to the account that owns it — the join
 * direction matters and is asserted: driving from `account.account` would emit a
 * row for every account that never provisioned, with nothing in the tenant
 * column. The address is redacted before the row leaves this function, so the
 * handle's reach and the surface's reach are two different things.
 *
 * A failed read answers `{ ok: false }` rather than throwing or returning an
 * empty list. An empty list is a legitimate fleet state — a deployment whose
 * tenants are all canaries — so it cannot also be how failure is spelled.
 */
export function createBrainOwnerDirectory(identitySql: SQL): BrainOwnerDirectory {
  return {
    async owners(): Promise<BrainOwnerLookup> {
      try {
        const rows = await identitySql<{ tenant_id: string; email: string }[]>`
          SELECT b.tenant_id, a.email
            FROM account.brain b
            JOIN account.account a ON a.account_id = b.account_id`;
        return {
          ok: true,
          owners: rows.map((row) => ({ tenantId: row.tenant_id, ...redactOwnerEmail(row.email) })),
        };
      } catch {
        // Deliberately nothing from the error. A driver error carries the DSN it
        // was handed, and this is the module that must not name one.
        return { ok: false };
      }
    },
  };
}

/**
 * What `/admin` is given.
 *
 * **The control plane, and one port that has already forgotten the addresses.**
 * There is still no tenant connection here, no secret store, no gateway — not
 * because a handler would be careless with them, but because a capability that
 * is absent cannot be misused, and R11 is a claim about capability rather than
 * about intent.
 *
 * {@link BrainOwnerDirectory} is the one widening, and it is narrowed to the
 * shape it is for that reason: an `SQL` handle on the identity database would
 * put every account's address one `SELECT` away from every operation on this
 * surface, forever, for the sake of one that needs a domain and a digest. The
 * port answers exactly {@link BrainOwner}, so the widening is bounded by the
 * type rather than by whoever writes the next operation.
 */
export interface AdminDeps {
  readonly controlSql: SQL;
  readonly owners: BrainOwnerDirectory;
}

export interface AdminRequest {
  /** A tool name or an operation name; the caller does not get to say which. */
  readonly name: string;
  readonly args?: Record<string, unknown>;
  /**
   * Whether the caller's transport authorised a state change — `POST`, and
   * nothing else. Absent reads as `false`, which is the direction that matters:
   * a caller that forgot to pass it gets a refusal on the write operations
   * rather than a grant.
   */
  readonly write?: boolean;
  /** Injected so a grant's `updated_at` is the request's instant, not the row's. */
  readonly now?: Date;
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

  // Before the switch, so a write requested in a readable shape is refused
  // without reaching the statement that would perform it.
  if (ADMIN_WRITE_OPERATIONS.has(request.name) && request.write !== true) {
    return {
      ok: false,
      code: 'invalid_params',
      message: `${JSON.stringify(request.name)} changes something and is only accepted over POST.`,
    };
  }

  const now = request.now ?? new Date();

  switch (request.name as AdminOperation) {
    case 'fleet_status':
      return { ok: true, content: await fleetStatus(deps.controlSql) };
    case 'tenant_directory':
      return tenantDirectory(deps.controlSql, deps.owners, requestedLimit(request));
    case 'pool_status':
      return { ok: true, content: await poolStatus(deps.controlSql) };
    case 'queue_status':
      return { ok: true, content: await queueStatus(deps.controlSql) };
    case 'connector_status': {
      const tenantId = namedTenant(request);
      if (tenantId === null) {
        return { ok: false, code: 'invalid_params', message: 'tenant_id is required.' };
      }
      return { ok: true, content: await connectorStatus(deps.controlSql, tenantId) };
    }
    /**
     * **The way back from a dead lane, and the only one that does not cost the
     * user a re-authorization.**
     *
     * A dead-lettered `ingest_pull` row stands in the cadence's anti-join
     * forever, so the source is never polled again by anything —
     * `src/control/connector-lanes.ts` carries the whole argument. The user's
     * remedy is disconnect-and-reconnect, which now clears it too; but when the
     * lane died of a fleet-wide defect of ours, asking every affected person to
     * re-consent at their provider to recover from a bug we shipped and fixed is
     * not a remedy. This clears the lane without touching the grant, and the
     * cadence enqueues a fresh job on its next tick.
     *
     * It does not enqueue one itself. The cadence already decides whether a
     * source is due, whether it is paused, and whether a lane is open; a second
     * enqueuer beside it would be a second copy of all three.
     */
    case 'requeue_connector': {
      const tenantId = namedTenant(request);
      if (tenantId === null) {
        return { ok: false, code: 'invalid_params', message: 'tenant_id is required.' };
      }
      const source = request.args?.['source'];
      if (typeof source !== 'string' || !isConnectorSource(source)) {
        // The vocabulary, never the argument. A message that echoed the caller's
        // string would carry a word somebody wrote onto this surface, which is
        // the one thing it does not do.
        return {
          ok: false,
          code: 'invalid_params',
          message: `source is required and must be one of: ${CONNECTOR_SOURCES.join(', ')}.`,
        };
      }
      const cleared = await discardConnectorLanes(deps.controlSql, {
        tenantId,
        source,
        now,
      });
      return {
        ok: true,
        content: {
          tenant_id: tenantId,
          source,
          // A count, not the ids: a job id is fleet-minted and content-free, but
          // an operator reading this wants to know whether anything was stuck,
          // and a list invites somebody to build a second surface keyed on it.
          lanes_cleared: cleared.length,
        },
      };
    }
    case 'tenant_status': {
      const tenantId = namedTenant(request);
      if (tenantId === null) {
        return { ok: false, code: 'invalid_params', message: 'tenant_id is required.' };
      }
      const status = await tenantStatus(deps.controlSql, tenantId);
      return status === null
        ? { ok: false, code: 'invalid_params', message: 'No such tenant.' }
        : { ok: true, content: status };
    }
    case 'grant_internal_tier': {
      const tenantId = namedTenant(request);
      if (tenantId === null) {
        return { ok: false, code: 'invalid_params', message: 'tenant_id is required.' };
      }
      // Through `billing.ts`, which is the only module allowed to write that
      // column — see `grantOperatorTier`. This surface decides *who may ask*;
      // it does not carry a second copy of what the column means.
      const granted = await grantOperatorTier(deps.controlSql, { tenantId, now });
      return granted.ok
        ? {
            ok: true,
            content: {
              tenant_id: granted.tenantId,
              tier: granted.tier,
              // Said out loud in the answer, because an operator granting this
              // is granting model spend and connector access at once, and the
              // second one is the half that is easy to forget.
              grants: ['consolidation_model_phases', 'connected_accounts'],
            },
          }
        : { ok: false, code: 'invalid_params', message: refusalText(granted.reason) };
    }
    case 'revoke_internal_tier': {
      const tenantId = namedTenant(request);
      if (tenantId === null) {
        return { ok: false, code: 'invalid_params', message: 'tenant_id is required.' };
      }
      const revoked = await revokeOperatorTier(deps.controlSql, { tenantId, now });
      return revoked.ok
        ? { ok: true, content: { tenant_id: revoked.tenantId, tier: revoked.tier } }
        : { ok: false, code: 'invalid_params', message: refusalText(revoked.reason) };
    }
  }
}

function namedTenant(request: AdminRequest): string | null {
  const tenantId = request.args?.['tenant_id'];
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null;
}

/**
 * How many rows {@link tenantDirectory} may return.
 *
 * The cap is the point and the argument is only there so a smaller page can be
 * asked for: this is the one operation on the surface whose answer grows with
 * the fleet, and an operator endpoint that materialises every tenant into one
 * JSON body is a container that falls over on the day it is most needed.
 *
 * Clamped rather than refused. A caller who typed a silly number wants the
 * biggest list this surface will give them, and answering `invalid_params` to
 * `limit=999999` would be a refusal whose only effect is a second round-trip.
 */
export const TENANT_DIRECTORY_LIMIT = 500;

/**
 * Exported so the cap is a tested property rather than a number in a private
 * helper: the fleet a cap protects is by definition bigger than the one any
 * fixture can afford to seed, so if this is only reachable through the query it
 * is only reachable on the day it stops working.
 *
 * `''` is its own case, because these arguments arrive from a query string and
 * `Number('')` is `0` — a bare `&limit=` would otherwise clamp to one row and
 * read as a fleet with one tenant in it.
 */
export function resolveDirectoryLimit(asked: unknown): number {
  if (asked === undefined || asked === null || asked === '') return TENANT_DIRECTORY_LIMIT;
  const wanted = Number(asked);
  if (!Number.isFinite(wanted)) return TENANT_DIRECTORY_LIMIT;
  return Math.min(Math.max(1, Math.floor(wanted)), TENANT_DIRECTORY_LIMIT);
}

function requestedLimit(request: AdminRequest): number {
  return resolveDirectoryLimit(request.args?.['limit']);
}

/** A sentence per refusal code. No tenant id, no row content — the caller sent
 * the id and does not need it read back to them. */
function refusalText(reason: 'unknown_tenant' | 'not_ready' | 'not_granted'): string {
  switch (reason) {
    case 'unknown_tenant':
      return 'No such tenant.';
    case 'not_ready':
      return 'That tenant is not ready; a tier on a half-provisioned brain is spend nobody can use.';
    case 'not_granted':
      return 'That tenant carries no operator grant. A paid subscription is the vendor’s to cancel.';
  }
}

async function fleetStatus(sql: SQL): Promise<Record<string, unknown>> {
  const rows = await sql<{ state: string; tier: string; n: number }[]>`
    SELECT state::text AS state, tier::text AS tier, count(*)::int AS n
    FROM control.tenant GROUP BY state, tier ORDER BY state, tier`;
  // Both totals, because the interesting number is the difference. R22 excludes
  // BYOK calls from hosted COGS, so metered spend above what the platform paid
  // is exactly the work users are funding themselves — and reporting only the
  // first makes every BYOK tenant look like a cost centre they are not.
  const spend = await sql<{ total: string | null; cogs: string | null }[]>`
    SELECT sum(spend_micro_usd)::bigint AS total,
           sum(hosted_cogs_micro_usd)::bigint AS cogs
      FROM control.tenant`;
  return {
    tenants: rows.map((row) => ({ state: row.state, tier: row.tier, count: row.n })),
    spend_micro_usd: Number(spend[0]?.total ?? 0),
    hosted_cogs_micro_usd: Number(spend[0]?.cogs ?? 0),
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
 * **What exists, and whose it is.** The list an operator reads before deleting
 * anything.
 *
 * **The gap this closes.** Every other operation on this surface takes a tenant
 * id the operator already has. None of them answers "what exists?", and none of
 * them answers "whose is this?" — so the list an operator actually deleted from
 * was the substrate vendor's console, where a tenant's project name is derived
 * from its id and nothing else. A throwaway and a person's brain are the same
 * string there. One deployment's worth of tenants was deleted by prefix on that
 * basis and one of them was a real user's.
 *
 * `BRAINZ_TENANT_ID_PREFIX` exists for this and does not reach it: it marks the
 * tenants a *deployment* mints, and the throwaways were minted by the same
 * deployment as the brain that mattered. A prefix cannot separate two tenants it
 * gives the same prefix to.
 *
 * **Why there is no `safe_to_delete` column, and the incident is the argument.**
 * The brain that was deleted had never been used: no activity, no content, a
 * `last_activity` of never. Every heuristic such a column could be built from
 * would have said *disposable*, and it was the founder's. The one fact that
 * separated it from the three throwaways beside it is that somebody owned it. So
 * this operation grades nothing. It puts the owner next to the id and lets the
 * operator read it — and it sorts by tenant id, because a stable order is what a
 * `diff` and a `grep` both want, and because ordering by any notion of risk
 * would be the same discredited heuristic wearing a different hat.
 *
 * **`owner: null` is the brain-link fact as well as the ownership fact.** A
 * non-null owner means an `account.brain` row names this tenant, which is the
 * entire surface between the identity database and the control plane; `state` is
 * separately what the brain's own provisioning says about it. A tenant can be
 * `ready` and owned by nobody (a canary), and it can be `provisioning` and
 * belong to somebody who signed up ninety seconds ago — the second of those is
 * the row this whole operation exists to keep alive.
 */
async function tenantDirectory(
  sql: SQL,
  directory: BrainOwnerDirectory,
  limit: number,
): Promise<AdminResult> {
  const found = await directory.owners();
  if (!found.ok) {
    // **The refusal that matters more than the answer.** Reporting every tenant
    // as unowned because the owner lookup was unreachable is the incident again,
    // with the operator's own tooling telling them it was safe.
    return {
      ok: false,
      code: 'invalid_params',
      message:
        'The owner lookup is unavailable, so this cannot say which brains belong to somebody. ' +
        'Refusing rather than reporting them all as unowned.',
    };
  }
  const byTenant = new Map(found.owners.map((owner) => [owner.tenantId, owner]));

  const total = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM control.tenant`;
  const rows = await sql<
    { tenant_id: string; state: string; tier: string; last_activity: Date | null }[]
  >`
    SELECT tenant_id, state::text AS state, tier::text AS tier, last_activity
      FROM control.tenant ORDER BY tenant_id LIMIT ${limit}`;

  const counted = total[0]?.n ?? rows.length;
  return {
    ok: true,
    content: {
      tenants: rows.map((row) => {
        const owner = byTenant.get(row.tenant_id);
        return {
          tenant_id: row.tenant_id,
          state: row.state,
          tier: row.tier,
          last_activity: row.last_activity,
          // `null`, never an absent key: a row whose owner field is missing
          // reads as a row nobody looked at, and `jq` prints nothing for it.
          owner: owner === undefined ? null : { domain: owner.emailDomain, digest: owner.emailDigest },
        };
      }),
      // The fleet's count, not the page's. "3 of 47" is what somebody about to
      // delete by prefix needs; "3" is the number that tells them the fleet is
      // smaller than it is.
      total: counted,
      truncated: counted > rows.length,
    },
  };
}

/**
 * **Why one connector is not polling, without a shell on a container.**
 *
 * **The gap this closes.** `queue_status` counts jobs by state and kind, which
 * answers "is the fleet moving" and nothing else; `tenant_status` reads the
 * tenant row, which knows nothing about connectors. So the operator's answer to
 * "my mail stopped arriving" was `control.job.failure_code` — the string
 * `handler_error`, the runner's bucket for any handler that threw — and after
 * that, nothing, anywhere. The run's own detail lives in the tenant's
 * `ingest_log`, which needs a tenant connection this surface does not have and
 * must not acquire.
 *
 * **So the detail comes the other way.** `control.connector_health` is written
 * by the worker at the end of every attempt, from inside the process that
 * already holds the tenant handle — `src/control/connector-health.sql` carries
 * the argument, including why that beats a read-through port. This operation is
 * two content-free control-plane reads joined in memory, and R11 is untouched:
 * no tenant connection, no secret namespace, `scope_denied` on `recall` still
 * means what it meant.
 *
 * **The two halves answer different questions and both are needed.** The queue
 * says whether the lane is moving — how many attempts it has spent, whether it
 * dead-lettered, when it next runs. The health record says why the last attempt
 * did not work, in the vocabulary of whichever layer knew: the ingest log's when
 * a run got far enough to record one, the queue's when it did not. A lane
 * retrying under backoff has a `due` row that looks exactly like a healthy one,
 * and only the pair tells them apart.
 *
 * Every field is a code from a closed set, a count, or an instant. There is no
 * item id here and no message text: `ingest_log.external_ref` is the provider's
 * own id for one of somebody's messages, and it stays in their database.
 */
async function connectorStatus(sql: SQL, tenantId: string): Promise<Record<string, unknown>> {
  const lanes = await sql<
    {
      target: string;
      state: string;
      attempts: number;
      max_attempts: number;
      run_at: Date;
      failure_code: string | null;
      finished_at: Date | null;
      dead_lettered_at: Date | null;
    }[]
  >`
    SELECT target::text AS target, state::text AS state, attempts, max_attempts, run_at,
           failure_code::text AS failure_code, finished_at, dead_lettered_at
      FROM control.job
     WHERE tenant_id = ${tenantId} AND kind = 'ingest_pull'
       AND state IN ('due', 'running', 'dead')
     ORDER BY target, run_at DESC`;

  const health = await readConnectorHealth(sql, { tenantId });

  return {
    tenant_id: tenantId,
    // The open and dead lanes only. `done` rows accumulate one per poll per
    // source and an operator reading a connector does not want a poll history —
    // when the last attempt worked is `last_success_at` below, in one field.
    lanes: lanes.map((lane) => ({
      source: lane.target,
      state: lane.state,
      attempts: lane.attempts,
      max_attempts: lane.max_attempts,
      run_at: lane.run_at,
      // Named for what it is. This is the runner's reading, and on a pull that
      // reached the provider and was refused it says `handler_error` — which is
      // true and is not the cause. The cause is in `last_attempt` below.
      job_failure_code: lane.failure_code,
      finished_at: lane.finished_at,
      dead_lettered_at: lane.dead_lettered_at,
    })),
    connectors: [...health.values()]
      .map((record) => ({
        source: record.source,
        last_attempt_at: record.lastAttemptAt,
        last_success_at: record.lastSuccessAt,
        run_outcome: record.runOutcome,
        // Both codes, unmerged. Which vocabulary answered is itself the fact an
        // operator reads: an ingest code means the attempt reached the provider,
        // and a job code means it never got that far.
        ingest_failure_code: record.ingestFailureCode,
        job_failure_code: record.jobFailureCode,
        cause: causeOf(record),
        items_written: record.itemsWritten,
        items_failed: record.itemsFailed,
      }))
      .sort((left, right) => left.source.localeCompare(right.source)),
  };
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
      hosted_cogs_micro_usd: string;
      last_activity: Date | null;
      last_cycle_at: Date | null;
      next_due_at: Date | null;
    }[]
  >`
    SELECT tenant_id, state::text AS state, tier::text AS tier, schema_version,
           pending_debt, spend_micro_usd, hosted_cogs_micro_usd,
           last_activity, last_cycle_at, next_due_at
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
    // What this tenant cost the platform, which is not what they spent the
    // moment they bring their own key (R22).
    hosted_cogs_micro_usd: Number(found.hosted_cogs_micro_usd),
    last_activity: found.last_activity,
    last_cycle_at: found.last_cycle_at,
    next_due_at: found.next_due_at,
  };
}
