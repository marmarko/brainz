/**
 * Shared dispatch — authentication, origin scoping, and the access log, below
 * every handler.
 *
 * **This module is critical gap 6's answer.** Three surfaces with no shared
 * dispatch is the inlined-per-handler pattern that produced cross-source leaks
 * upstream; under a product whose central claim is isolation, that is not a
 * detail. So the order below is fixed and there is exactly one of it: resolve
 * the credential, derive the fence *from the credential*, open the tenant's
 * database with an identity that can reach no other tenant, and only then call a
 * handler — which receives the fence as a value and has no way to widen it.
 * `test/mcp/guards.test.ts` scans the handler directory to keep it that way.
 *
 * **The fence is derived, never parameterised.** A tenant's own provisioned
 * bearer grants the whole brain: every origin the substrate holds, plus the
 * agent write origin so that a brand-new tenant can store its first memory and
 * read it back before any connector exists (R2a's activation loop, which
 * precedes OAuth rather than following it). An OAuth grant carries its origins
 * in the token, signed, so narrowing is a property of the credential.
 *
 * **Every call is logged, including the refusals.** A log of successes answers
 * "what worked"; the question after an incident is "was my data reached", and
 * the refusals are half that answer. Content-free by shape rather than by
 * discipline — see `access-log.ts`.
 *
 * **The control-plane signals issue after the response is assembled.** They are
 * KTD11's trigger inputs and they must not land on `entity`'s warm-p99 promise,
 * so they accumulate in memory and flush on a throttle. A control plane having a
 * bad night makes a tenant's consolidation late, never their read fail.
 */

import type { ModelGateway } from '../ai/gateway.ts';
import {
  assertServableSchema,
  TenantSchemaBehindError,
  UnservableTenantSchemaError,
} from '../control/migrate.ts';
import { fleetIdentity, type TenantSecretStore } from '../control/secrets.ts';
import type { Grant } from '../core/search/fence.ts';
import type { AccessLog, ResultClass } from './access-log.ts';
import type { ControlSignals } from './control-signals.ts';
import { mintDelimiter, type NonceSource } from './demarcation.ts';
import {
  buildEnvelope,
  envelopeViolations,
  type Degraded,
  type Envelope,
  type IndexState,
  type NextCall,
  type SetupHint,
} from './envelope.ts';
import {
  classifyToken,
  deriveSigningKey,
  hashToken,
  stripBearer,
  tenantOfToken,
  verifyAccessToken,
  verifyTenantBearer,
  type AuthorizationStore,
  type GrantClaims,
} from './oauth.ts';
import { brainOrigins, indexState } from './reads.ts';
import type { TenantConnections } from './tenant-db.ts';
import { briefing, entity, fetchOne, recall, search } from './tools/read.ts';
import { attestation, brain, manage, synthesize } from './tools/meta.ts';
import { forget, remember } from './tools/write.ts';
import type { Handler, ToolContext } from './tools/context.ts';
import { isDispatchable, toolByName, type Endpoint } from './tools/index.ts';

/**
 * Where a `remember` arriving over `/mcp` lands.
 *
 * A constant rather than a parameter, and first-party by construction — the
 * `agent` surface is on `demarcation.ts`'s first-party list, so a memory the
 * user dictated to their assistant is not returned to them wrapped as untrusted
 * mail. R12a still refuses to let it *corroborate* anything, which is the
 * separate question of whether the same assistant that read the attacker's mail
 * can vouch for what it repeats.
 */
export const DEFAULT_WRITE_ORIGIN = 'personal:agent';

/**
 * The one sentence every failure to authenticate answers with.
 *
 * Exported so a test can assert the surface has exactly one of these rather
 * than asserting a string it copied. The rule it encodes: a refusal must not
 * distinguish "no such tenant" from "wrong secret for a tenant that exists" —
 * the second is an existence oracle over the fleet's tenant list, reachable
 * with no credential at all and leaving no content in any log.
 */
export const UNAUTHORIZED_MESSAGE = 'That credential is not one this server issued.';

export interface PanelNonces {
  verify(nonce: string, tenantId: string, nowMs: number): boolean;
}

export interface DispatchDeps {
  readonly endpoint: Endpoint;
  readonly secrets: TenantSecretStore;
  readonly connections: TenantConnections;
  readonly store: AuthorizationStore;
  readonly accessLog: AccessLog;
  readonly signals: ControlSignals;
  readonly gateway: ModelGateway;
  readonly now: () => Date;
  readonly nonceSource?: NonceSource;
  readonly panelNonces?: PanelNonces;
  readonly writeOrigin?: string;
}

export interface DispatchRequest {
  readonly authorization: string | null;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /**
   * False for work a person did not cause — connector cadence, background
   * jobs. KTD11: only user-originated calls stamp `last_activity`, or a busy
   * mailbox starves the inactivity debounce forever.
   */
  readonly userOriginated?: boolean;
}

export interface DispatchError {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly resultClass: ResultClass;
  readonly content: unknown;
  readonly envelope: Envelope;
  /** The client lane. Invisible to the model; carries the attestation. */
  readonly meta: Record<string, unknown>;
  readonly error?: DispatchError;
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  recall,
  search,
  fetch: fetchOne,
  entity,
  briefing,
  remember,
  forget,
  brain,
  manage,
  synthesize,
};

/** The one entry point. Every surface — HTTP, panel, test — comes through here. */
export async function dispatch(
  deps: DispatchDeps,
  request: DispatchRequest,
): Promise<DispatchResult> {
  const now = deps.now();
  const nonce = mintDelimiter(deps.nonceSource);
  const writeOrigin = deps.writeOrigin ?? DEFAULT_WRITE_ORIGIN;

  const refuse = (
    code: string,
    message: string,
    resultClass: ResultClass,
    actor: { readonly grantId: string; readonly tenantId: string },
    extra: { readonly suggestion?: string } = {},
  ): DispatchResult => {
    log(deps, now, actor, request.tool, resultClass);
    return {
      ok: false,
      resultClass,
      content: null,
      envelope: buildEnvelope({ endpoint: deps.endpoint }),
      meta: {},
      error: { code, message, ...extra },
    };
  };

  const anonymous = { grantId: 'anonymous', tenantId: 'unknown' };

  // ---- 1. The credential, before anything else touches a database. ---------
  const presented = request.authorization === null ? '' : stripBearer(request.authorization);
  const tenantId = presented.length === 0 ? null : tenantOfToken(presented);

  // Every way of failing to authenticate leaves through **one** return, with one
  // message. The version this replaced had three, and the third said something
  // different — "not valid for this brain" once a tenant resolved, "not one this
  // server issued" when it did not. That is a tenant-existence oracle: same
  // credential shape, same alphabet, different sentence, and an unauthenticated
  // caller enumerates which tenant ids the fleet serves without ever reading a
  // row. Content-free is not the same as disclosure-free, which is exactly why
  // this one survived a suite that checks every refusal is typed.
  const resolved =
    tenantId === null ? null : await deps.secrets.resolve(fleetIdentity(tenantId), tenantId);

  // An unresolvable tenant becomes an empty stored bearer rather than an early
  // return, so the unknown-tenant path and the wrong-secret path run the same
  // verification and produce the same refusal.
  const claims =
    tenantId === null
      ? null
      : verifyCredential(presented, resolved?.ok === true ? resolved.secret.bearerGrant : '', now.getTime(), {
          tenantId,
          endpoint: deps.endpoint,
          writeOrigin,
        });

  if (claims === null) {
    return refuse('unauthorized', UNAUTHORIZED_MESSAGE, 'unauthorized', {
      grantId: 'anonymous',
      tenantId: tenantId ?? 'unknown',
    });
  }
  if (resolved?.ok !== true) {
    // Unreachable — a null `resolved` cannot produce claims — and kept so the
    // narrowing below is a property of the code rather than of the reader.
    return refuse('unauthorized', UNAUTHORIZED_MESSAGE, 'unauthorized', anonymous);
  }

  // From here down the tenant is the *authenticated* one — `verifyCredential`
  // refuses an access token whose claims name a different tenant than the one
  // its secret was resolved for, so these are the same string with one of them
  // carrying a proof.
  const authenticatedTenantId = claims.tenantId;
  const actor = { grantId: claims.grantId, tenantId: authenticatedTenantId };

  // A self-contained token cannot be withdrawn by rewriting it, so revocation
  // is a list and it is consulted on every call — including the ones that would
  // otherwise never touch the store.
  if (deps.store.isRevoked(claims.grantId)) {
    return refuse('unauthorized', 'This grant has been revoked.', 'unauthorized', actor);
  }

  // An OAuth grant binds to the endpoint it was issued for. A token minted for
  // the portable surface presenting itself at the ChatGPT surface is a
  // different advertised tool set and a different consent story.
  if (claims.endpoint !== deps.endpoint) {
    return refuse('unauthorized', 'This grant is bound to a different endpoint.', 'unauthorized', actor);
  }

  // ---- 2. The tool, before the database is opened. -------------------------
  const def = toolByName(request.tool);
  if (def === undefined || !isDispatchable(request.tool, deps.endpoint)) {
    return refuse('unknown_tool', `No tool named ${JSON.stringify(request.tool)}.`, 'unknown_tool', actor);
  }

  if (def.requiresPanelNonce === true) {
    const supplied = typeof request.args.panel_nonce === 'string' ? request.args.panel_nonce : '';
    const accepted =
      supplied.length > 0 && (deps.panelNonces?.verify(supplied, authenticatedTenantId, now.getTime()) ?? false);
    if (!accepted) {
      return refuse(
        'invalid_params',
        'This tool requires a panel nonce, which is minted into a panel view rather than offered to a model.',
        'invalid_params',
        actor,
      );
    }
  }

  // ---- 3. The tenant's database, by an identity that reaches no other. -----
  const opened = await deps.connections.open(authenticatedTenantId);
  if (!opened.ok) {
    return refuse('unavailable', 'This brain could not be reached.', 'unavailable', actor);
  }

  const { sql, coldStart } = opened.connection;

  // ---- 3a. The schema this fleet understands. ------------------------------
  //
  // Before the fence is derived, because deriving it reads four content tables,
  // and before any handler runs, because a handler's SQL names columns a rung it
  // has not seen may not have. U3's promise is a *typed refusal* rather than a
  // best-effort query against an unknown shape, and it is the request path's to
  // make: the two flavours differ in what resolves them, so they differ in what
  // the caller is told.
  const unservable = await schemaRefusal(deps, authenticatedTenantId, opened.connection.schemaVersion);
  if (unservable !== null) {
    return refuse('unavailable', unservable.message, 'unavailable', actor, {
      suggestion: unservable.suggestion,
    });
  }

  // ---- 4. The fence, derived from the credential. --------------------------
  let grant: Grant;
  try {
    grant = claims.origins.length > 0 ? claims.origins : await fullBrainGrant(sql, writeOrigin);
  } catch {
    return refuse('unavailable', 'This brain could not be reached.', 'unavailable', actor);
  }

  let cachedState: IndexState | null = null;
  const ctx: ToolContext = {
    sql,
    grant,
    writeOrigin: claims.writeOrigin,
    tenantId: authenticatedTenantId,
    caller: fleetIdentity(authenticatedTenantId),
    gateway: deps.gateway,
    now,
    nonce,
    coldStart,
    endpoint: deps.endpoint,
    async indexState() {
      cachedState ??= await indexState(sql, grant);
      return cachedState;
    },
  };

  // ---- 5. The handler. -----------------------------------------------------
  const handler = HANDLERS[request.tool];
  if (handler === undefined) {
    return refuse('unknown_tool', `No tool named ${JSON.stringify(request.tool)}.`, 'unknown_tool', actor);
  }

  let outcome: Awaited<ReturnType<Handler>>;
  try {
    outcome = await handler(ctx, request.args);
  } catch {
    // A handler that throws is a bug, and a bug must not become a stack trace
    // on the wire: the message would be the ordinary way a user's row content
    // reaches a log this system promises holds none.
    return refuse('error', 'That call could not be completed.', 'error', actor);
  }

  const meta = {
    'brainz.app/brain': attestation(authenticatedTenantId),
    'brainz.app/setup_url': 'https://app.brainz.test/connect',
  };

  if (!outcome.ok) {
    const resultClass = RESULT_CLASS_BY_CODE[outcome.code] ?? 'error';
    log(deps, now, actor, request.tool, resultClass);
    recordSignals(deps, actor.tenantId, request, 0, undefined);
    return {
      ok: false,
      resultClass,
      content: null,
      envelope: buildEnvelope({ endpoint: deps.endpoint }),
      meta,
      error: {
        code: outcome.code,
        message: outcome.message,
        ...(outcome.suggestion === undefined ? {} : { suggestion: outcome.suggestion }),
      },
    };
  }

  const envelope = safeEnvelope(deps.endpoint, {
    degraded: outcome.degraded ?? null,
    notice: outcome.notice ?? [],
    next: outcome.next ?? [],
    setup: outcome.setup ?? null,
  });

  const resultClass: ResultClass = outcome.resultClass ?? (envelope.degraded === undefined ? 'ok' : 'degraded');
  log(deps, now, actor, request.tool, resultClass);
  recordSignals(deps, actor.tenantId, request, outcome.debt ?? 0, outcome.rank1Score);

  return { ok: true, resultClass, content: outcome.content, envelope, meta };
}

const RESULT_CLASS_BY_CODE: Readonly<Record<string, ResultClass>> = {
  invalid_params: 'invalid_params',
  not_found: 'not_found',
  scope_denied: 'scope_denied',
  unavailable: 'unavailable',
  unauthorized: 'unauthorized',
  error: 'error',
};

/**
 * Both credential shapes, resolved to one set of claims.
 *
 * The provisioned bearer carries no claims of its own, so the ones synthesised
 * here are the whole-brain grant: an empty `origins` array is the marker that
 * dispatch must read the brain's own origins, and it is *not* a wildcard — the
 * fence never sees an empty grant, because an empty grant sees nothing.
 */
function verifyCredential(
  presented: string,
  storedBearer: string,
  nowMs: number,
  context: { readonly tenantId: string; readonly endpoint: Endpoint; readonly writeOrigin: string },
): GrantClaims | null {
  switch (classifyToken(presented)) {
    case 'tenant_bearer': {
      if (!verifyTenantBearer(presented, storedBearer)) return null;
      return {
        // Stable across calls and derived from the credential rather than from
        // the credential itself: the log names the actor without holding a
        // secret that would let a log reader become it.
        grantId: `bearer:${hashToken(presented).slice(0, 16)}`,
        tenantId: context.tenantId,
        origins: [],
        writeOrigin: context.writeOrigin,
        endpoint: context.endpoint,
        clientId: 'provisioned',
        issuedAt: nowMs,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    }
    case 'access_token': {
      const verdict = verifyAccessToken(presented, deriveSigningKey(storedBearer), nowMs);
      if (!verdict.ok) return null;
      if (verdict.claims.tenantId !== context.tenantId) return null;
      return verdict.claims;
    }
    case 'unknown':
      return null;
  }
}

interface SchemaRefusal {
  readonly message: string;
  readonly suggestion: string;
}

/**
 * Whether this fleet may serve a tenant at `version`, and what to say if not.
 *
 * **The two refusals are not the same sentence, because they are not the same
 * problem.** A tenant behind the fleet is the ordinary post-deploy state of
 * every suspended brain; something migrates it and the next call works. A tenant
 * ahead of it is a *rolling deploy*: this instance predates the rung, no retry
 * against this instance will ever help, and the thing that resolves it is the
 * instance being replaced. Both are content-free — nothing here names a table, a
 * column or a version to a caller.
 *
 * **The behind case is re-read once, on this path only.** The version came off a
 * cached connection entry, and the event that changes it is exactly the event
 * that fixes it, so refusing on a stale reading would hold a migrated tenant out
 * for the rest of the entry's TTL. Costing a round trip on a call that is
 * already failing is not a warm-path cost.
 */
async function schemaRefusal(
  deps: DispatchDeps,
  tenantId: string,
  version: number,
): Promise<SchemaRefusal | null> {
  const verdict = (at: number): UnservableTenantSchemaError | null => {
    try {
      assertServableSchema(at);
      return null;
    } catch (error) {
      if (error instanceof UnservableTenantSchemaError) return error;
      throw error;
    }
  };

  let error = verdict(version);
  if (error === null) return null;

  if (error instanceof TenantSchemaBehindError) {
    const fresh = await deps.connections.refreshSchemaVersion(tenantId);
    if (fresh !== undefined) error = verdict(fresh);
    if (error === null) return null;
  }

  return error.migratable
    ? {
        message: 'This brain is being upgraded and cannot be read until that finishes.',
        suggestion: 'Try the same call again shortly — the upgrade runs in the background.',
      }
    : {
        message: 'This brain has been upgraded past what this server understands.',
        suggestion:
          'Try the same call again shortly — this instance is being replaced by one that understands it.',
      };
}

/** Every origin this brain holds, plus the one its agent writes through. */
async function fullBrainGrant(sql: Parameters<typeof brainOrigins>[0], writeOrigin: string): Promise<Grant> {
  const origins = new Set(await brainOrigins(sql));
  origins.add(writeOrigin);
  return [...origins];
}

/**
 * Build the envelope, dropping anything that would violate its own rules.
 *
 * Dropping rather than throwing: an advisory lane is not worth failing a
 * successful read over. The violations are still a hard failure in tests, which
 * is where a malformed `next` should be caught.
 */
function safeEnvelope(
  endpoint: Endpoint,
  input: {
    readonly degraded: Degraded | null;
    readonly notice: readonly string[];
    readonly next: readonly NextCall[];
    readonly setup: SetupHint | null;
  },
): Envelope {
  const candidate = buildEnvelope({ endpoint, ...input });
  if (envelopeViolations(candidate, endpoint).length === 0) return candidate;
  return buildEnvelope({ endpoint, degraded: input.degraded, notice: input.notice, setup: input.setup });
}

function log(
  deps: DispatchDeps,
  now: Date,
  actor: { readonly grantId: string; readonly tenantId: string },
  tool: string,
  resultClass: ResultClass,
): void {
  try {
    deps.accessLog.record({
      at: now.toISOString(),
      grantId: actor.grantId,
      tenantId: actor.tenantId,
      tool,
      resultClass,
    });
  } catch {
    // A log sink that can fail a tool call is a log sink that gets removed.
  }
}

function recordSignals(
  deps: DispatchDeps,
  tenantId: string,
  request: DispatchRequest,
  debt: number,
  rank1Score: number | undefined,
): void {
  deps.signals.record({
    tenantId,
    userOriginated: request.userOriginated ?? true,
    debt,
    ...(rank1Score === undefined ? {} : { rank1Score }),
  });
  // Fired, not awaited: the response is already assembled, and the flush's own
  // failures are counted inside the signal recorder rather than raised here.
  void deps.signals.flush().catch(() => undefined);
}
