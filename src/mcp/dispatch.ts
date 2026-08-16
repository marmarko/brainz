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
import type { PauseAuthority } from '../ingest/pause.ts';
import {
  assertServableSchema,
  TenantSchemaBehindError,
  UnservableTenantSchemaError,
} from '../control/migrate.ts';
import { fleetIdentity, type TenantSecretStore } from '../control/secrets.ts';
import type { Grant } from '../core/search/fence.ts';
import type { AccessLog, ResultClass } from './access-log.ts';
import { NO_CLIENT_CAPABILITIES, type ClientCapabilities } from './client-capabilities.ts';
import type { ControlSignals } from './control-signals.ts';
import { mintDelimiter, type NonceSource } from './demarcation.ts';
import {
  resolveManageGate,
  type InputRequired,
  type ResumeInput,
} from './manage-gate.ts';
import { DEFAULT_WEB_APP_BASE_URL } from './manage-actions.ts';
import type { SettingsBackend } from './settings.ts';
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
import {
  attestationPayload,
  boundaryFromConnectionString,
  sealAttestation,
  type AttestationSigner,
  type TenantBoundaryFacts,
} from './attestation.ts';
import { resolveGrant } from './grant-scope.ts';
import { brainOrigins, indexState } from './reads.ts';
import type { TenantConnections } from './tenant-db.ts';
import { briefing, entity, fetchOne, recall, search } from './tools/read.ts';
import { brain, manage, synthesize } from './tools/meta.ts';
import { INSTRUCTIONS_RELEASE } from './instructions.ts';
import { definitionsDigest } from './tools/index.ts';
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
  /**
   * Where a `manage` action lands (U14).
   *
   * Optional, and its absence is a refusal rather than a no-op: a settings port
   * that silently succeeds is what makes `applied: true` a lie, and no test
   * that did not re-read the store would ever see it.
   */
  readonly settings?: SettingsBackend;
  /** The origin a web-app deep link points at. */
  readonly webAppBaseUrl?: string;
  readonly writeOrigin?: string;
  /**
   * Who signs the isolation attestation (U16).
   *
   * A capability, not a secret, and optional: a fleet wired to none stamps an
   * `unsigned` receipt with a reason rather than signing with something it
   * found locally. R10 puts the key outside this fleet's readable secret scope
   * precisely so that one compromise of the process that parses attacker-
   * controlled mail cannot mint valid receipts for a brain whose isolation has
   * already gone — so `secrets` deliberately cannot produce it, and this is the
   * only way it arrives.
   */
  readonly attestationSigner?: AttestationSigner;
  /**
   * The object-storage prefix source, for the attestation's storage half.
   *
   * Structurally `TenantStorage` from `src/control/storage.ts`, narrowed to the
   * one method this needs: an accessor able to mint credentials has no business
   * being reachable from a response builder.
   */
  readonly prefixSource?: {
    prefixFor(
      caller: ReturnType<typeof fleetIdentity>,
      tenantId: string,
    ): { readonly ok: true; readonly prefix: string } | { readonly ok: false };
  };
  /**
   * The tenant's Neon project id, if this fleet has a way to know it.
   *
   * It is on the control-plane row, which the fleet identity holds no permission
   * to read (R11, deliberately). Absent by default, and the attestation then
   * reports `id: null, id_source: 'unresolved'` — never a string parsed out of
   * the endpoint host, which is a different identifier that merely looks alike.
   */
  readonly tenantProjectId?: (tenantId: string) => string | null;
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
  /**
   * What this request's `_meta` said the client can do (2026-07-28).
   *
   * Per request, because there is no handshake left to remember it on, and
   * absent by default because every capability it can carry *widens* what the
   * caller may reach.
   */
  readonly clientCapabilities?: ClientCapabilities;
  /**
   * A multi-round-trip resume (SEP-2322): the echoed `requestState` and the
   * answers.
   *
   * Carried on the request rather than inside `args`, because that is where the
   * spec puts it and because a tool schema that declared a confirmation
   * parameter would be publishing a control the model gets to fill in.
   */
  readonly resume?: ResumeInput;
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
  /**
   * Set when the call cannot proceed until the user answers something.
   *
   * Not an error: the server lifts it to `resultType: "input_required"` at the
   * JSON-RPC layer and the client re-issues the same call with the answers.
   */
  readonly inputRequired?: InputRequired;
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

/** Who the caller is, once the credential has been believed. */
export interface AuthenticatedCaller {
  readonly claims: GrantClaims;
  readonly actor: { readonly grantId: string; readonly tenantId: string };
  /**
   * The tenant's derived signing key.
   *
   * Handed out here rather than re-derived per call site, so the panel nonce,
   * the MRTR `requestState` and the access tokens are all signed with one key
   * whose derivation lives in exactly one place. It never leaves this module's
   * callers and is never put on a `ToolContext` — `test/mcp/guards.test.ts`
   * refuses a handler that touches key material.
   */
  readonly signingKey: string;
  /**
   * What the tenant's own substrate is, as facts rather than as a credential.
   *
   * Derived here because this is where the DSN is, and the DSN is key material:
   * `test/mcp/guards.test.ts` refuses a handler that touches any, so the seam
   * where a connection string becomes a host and a database name has to be
   * above the handlers. What travels down is this — no userinfo, no secret, and
   * no field that could hold one.
   */
  readonly boundary: TenantBoundaryFacts;
}

export interface AuthenticationRefusal {
  readonly code: string;
  readonly message: string;
  readonly resultClass: ResultClass;
  readonly actor: { readonly grantId: string; readonly tenantId: string };
}

export type AuthenticationOutcome =
  | { readonly ok: true; readonly caller: AuthenticatedCaller }
  | { readonly ok: false; readonly refusal: AuthenticationRefusal };

/**
 * The credential path, extracted so `resources/read` shares it.
 *
 * **It is shared rather than copied for the reason this module's history
 * records.** The version of this file that had three ways to fail
 * authentication said something different on the third, which was a
 * tenant-existence oracle reachable with no credential at all. A second surface
 * with its own copy of these checks is that bug waiting to be rewritten, and it
 * would be invisible to a suite that only tests one of them.
 */
export async function authenticate(
  deps: DispatchDeps,
  authorization: string | null,
): Promise<AuthenticationOutcome> {
  const writeOrigin = deps.writeOrigin ?? DEFAULT_WRITE_ORIGIN;
  const nowMs = deps.now().getTime();

  const presented = authorization === null ? '' : stripBearer(authorization);
  const tenantId = presented.length === 0 ? null : tenantOfToken(presented);

  const resolved =
    tenantId === null ? null : await deps.secrets.resolve(fleetIdentity(tenantId), tenantId);

  // An unresolvable tenant becomes an empty stored bearer rather than an early
  // return, so the unknown-tenant path and the wrong-secret path run the same
  // verification and produce the same refusal.
  const claims =
    tenantId === null
      ? null
      : verifyCredential(
          presented,
          resolved?.ok === true ? resolved.secret.bearerGrant : '',
          nowMs,
          { tenantId, endpoint: deps.endpoint, writeOrigin },
        );

  if (claims === null || resolved?.ok !== true) {
    return {
      ok: false,
      refusal: {
        code: 'unauthorized',
        message: UNAUTHORIZED_MESSAGE,
        resultClass: 'unauthorized',
        actor: { grantId: 'anonymous', tenantId: tenantId ?? 'unknown' },
      },
    };
  }

  const actor = { grantId: claims.grantId, tenantId: claims.tenantId };

  // A self-contained token cannot be withdrawn by rewriting it, so revocation
  // is a list and it is consulted on every call — including the ones that would
  // otherwise never touch the store.
  if (deps.store.isRevoked(claims.grantId)) {
    return {
      ok: false,
      refusal: {
        code: 'unauthorized',
        message: 'This grant has been revoked.',
        resultClass: 'unauthorized',
        actor,
      },
    };
  }

  // An OAuth grant binds to the endpoint it was issued for. A token minted for
  // the portable surface presenting itself at the ChatGPT surface is a
  // different advertised tool set and a different consent story.
  if (claims.endpoint !== deps.endpoint) {
    return {
      ok: false,
      refusal: {
        code: 'unauthorized',
        message: 'This grant is bound to a different endpoint.',
        resultClass: 'unauthorized',
        actor,
      },
    };
  }

  return {
    ok: true,
    caller: {
      claims,
      actor,
      signingKey: deriveSigningKey(resolved.secret.bearerGrant),
      boundary: boundaryFactsFor(deps, claims.tenantId, resolved.secret.connectionString),
    },
  };
}

/** The DSN's two public facts, plus whatever else this fleet can honestly say. */
function boundaryFactsFor(
  deps: DispatchDeps,
  tenantId: string,
  connectionString: string,
): TenantBoundaryFacts {
  const { endpointHost, databaseName } = boundaryFromConnectionString(connectionString);
  const projectId = deps.tenantProjectId?.(tenantId) ?? null;
  const prefix = deps.prefixSource?.prefixFor(fleetIdentity(tenantId), tenantId);

  return {
    projectId,
    projectIdSource: projectId === null ? 'unresolved' : 'control_plane',
    endpointHost,
    databaseName,
    storagePrefix: prefix?.ok === true ? prefix.prefix : null,
    storagePrefixSource: prefix?.ok === true ? 'derived' : 'unavailable',
  };
}

/** The one entry point. Every surface — HTTP, panel, test — comes through here. */
export async function dispatch(
  deps: DispatchDeps,
  request: DispatchRequest,
): Promise<DispatchResult> {
  const now = deps.now();
  const nonce = mintDelimiter(deps.nonceSource);

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

  // ---- 1. The credential, before anything else touches a database. ---------
  //
  // Every way of failing to authenticate leaves through **one** return, with one
  // message — see `authenticate`, which `resources/read` shares rather than
  // reimplements. The version this replaced had three returns, and the third
  // said something different, which was a tenant-existence oracle reachable with
  // no credential at all.
  const authenticated = await authenticate(deps, request.authorization);
  if (!authenticated.ok) {
    const { code, message, resultClass, actor: who } = authenticated.refusal;
    return refuse(code, message, resultClass, who);
  }

  // From here down the tenant is the *authenticated* one — `verifyCredential`
  // refuses an access token whose claims name a different tenant than the one
  // its secret was resolved for, so these are the same string with one of them
  // carrying a proof.
  const { claims, actor, signingKey, boundary } = authenticated.caller;
  const authenticatedTenantId = claims.tenantId;

  // **The receipt is built once, above the handlers, and stamped in two places.**
  // `brain` renders it and `_meta` carries it, and they are the same object
  // rather than two builds of the same facts — two builders is how a tool and a
  // stamp come to describe different worlds. It is sealed before any handler
  // runs, so nothing a handler does can be inside what was signed.
  const receipt = await sealAttestation(
    attestationPayload({
      tenantId: authenticatedTenantId,
      issuedAt: now,
      boundary,
      definitionsDigest: definitionsDigest(),
      instructionsRelease: INSTRUCTIONS_RELEASE,
    }),
    deps.attestationSigner,
  );

  // ---- 2. The tool, and its gate, before the database is opened. -----------
  const def = toolByName(request.tool);
  if (def === undefined || !isDispatchable(request.tool, deps.endpoint)) {
    return refuse('unknown_tool', `No tool named ${JSON.stringify(request.tool)}.`, 'unknown_tool', actor);
  }

  // U14's gate. It lives here rather than in the handler for the reason
  // `test/mcp/guards.test.ts` writes down about `panel_nonce`: a gate a handler
  // could choose not to check is not a gate. `manage` is the only tool that
  // carries it, and it is the only tool that changes a setting.
  let authority: PauseAuthority = 'panel';
  if (def.requiresPanelNonce === true) {
    const gate = resolveManageGate({
      action: typeof request.args.action === 'string' ? request.args.action.trim() : null,
      value: typeof request.args.value === 'string' ? request.args.value : null,
      panelNonce: typeof request.args.panel_nonce === 'string' ? request.args.panel_nonce : '',
      capabilities: request.clientCapabilities ?? NO_CLIENT_CAPABILITIES,
      resume: request.resume,
      signingKey,
      tenantId: authenticatedTenantId,
      callerKey: claims.grantId,
      // What the credential is for, not just what the client can render. Every
      // `manage` action is tenant-wide and a narrowed grant is a slice of the
      // tenant, so the gate needs the scope to answer at all.
      scope: claims.scope,
      nowMs: now.getTime(),
      webAppBaseUrl: deps.webAppBaseUrl ?? DEFAULT_WEB_APP_BASE_URL,
    });

    if (gate.kind === 'refuse') {
      const resultClass = RESULT_CLASS_BY_CODE[gate.code] ?? 'error';
      return refuse(gate.code, gate.message, resultClass, actor, {
        ...(gate.suggestion === undefined ? {} : { suggestion: gate.suggestion }),
      });
    }
    if (gate.kind === 'ask') {
      // Not an error: the call is suspended, not refused, and the server lifts
      // this to `resultType: "input_required"`. It is logged as an ordinary
      // outcome and — the property the tests re-read the store for — no handler
      // has run, so nothing has been written.
      log(deps, now, actor, request.tool, 'ok');
      return {
        ok: true,
        resultClass: 'ok',
        content: { confirmation_required: true, detail: gate.message },
        envelope: buildEnvelope({ endpoint: deps.endpoint }),
        meta: {},
        inputRequired: gate.inputRequired,
      };
    }
    authority = gate.authority;
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
  //
  // **The marker is read, never inferred.** This line used to say
  // `claims.origins.length > 0 ? claims.origins : fullBrainGrant(…)`, which made
  // an empty list mean *the whole brain* — the one place this system inverted
  // `fence.ts`'s "an empty grant sees nothing (not everything)", and a fail-open
  // sitting above every fence rather than beside one. U18 made the scope an
  // explicit claim, refused at mint and again at verify, so by the time control
  // reaches here a `narrowed` grant is guaranteed to name at least one origin
  // and `expandGrant`'s wildcard floor guarantees the expansion is non-empty
  // too. Neither guarantee is assumed: `grant-scope.ts` carries both.
  let grant: Grant;
  try {
    grant = await resolveGrant(claims, () => brainOrigins(sql));
  } catch {
    return refuse('unavailable', 'This brain could not be reached.', 'unavailable', actor);
  }

  let cachedState: IndexState | null = null;
  const ctx: ToolContext = {
    sql,
    grant,
    writeOrigin: claims.writeOrigin,
    tenantId: authenticatedTenantId,
    // The same identity the access log records. Derived from the credential,
    // never from an argument — see `tools/context.ts:ToolContext.callerKey`.
    callerKey: claims.grantId,
    caller: fleetIdentity(authenticatedTenantId),
    gateway: deps.gateway,
    now,
    nonce,
    coldStart,
    endpoint: deps.endpoint,
    // U14. A bound port rather than a connection: a handler that could reach
    // the control plane directly would have moved the boundary into itself,
    // which is what `test/mcp/guards.test.ts` scans for. `null` when the fleet
    // wired no backend, and `manage` answers `unavailable` rather than
    // pretending to have applied something.
    settings: deps.settings?.forTenant({ tenantId: authenticatedTenantId, sql }) ?? null,
    authority,
    attestation: receipt,
    webAppBaseUrl: deps.webAppBaseUrl ?? DEFAULT_WEB_APP_BASE_URL,
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
    'brainz.app/brain': receipt,
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
        // The provisioned bearer is the whole brain, and since U18 it *says* so
        // rather than expressing it as an empty list somebody downstream has to
        // interpret. This is the only producer of `whole_brain` in the system.
        scope: 'whole_brain',
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
