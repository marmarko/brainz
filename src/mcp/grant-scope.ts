/**
 * R15's fence, as a *credential scope* — U18's `allowedOrigins`.
 *
 * ============================================================================
 * WHAT THIS MODULE IS FOR
 * ============================================================================
 *
 * `src/core/search/fence.ts` decides whether one row is inside a grant. This
 * module decides **what a grant is**, which is a different question and the one
 * that had no answer: before U18 the only producer of a narrowed grant in this
 * repo was a test helper, and `handleAuthorize` minted `origins: []` for
 * everything. A work-connector grant that reads `origin: work` only is a product
 * promise with no mechanism behind it until a credential can *carry* that scope
 * and a verifier can refuse a credential that carries it incoherently.
 *
 * It extends the existing mechanism rather than adding a second filter. A grant
 * is still a `Grant` — a flat list of origin strings — and every read path still
 * fences on exactly that list. What is new is above them: how the list is
 * written on a credential, how it is checked without a database, and how it is
 * expanded with one.
 *
 * ============================================================================
 * THE HAZARD THIS MODULE EXISTS TO CLOSE
 * ============================================================================
 *
 * `dispatch.ts` used to read:
 *
 *     grant = claims.origins.length > 0 ? claims.origins : await fullBrainGrant(…)
 *
 * `fence.ts` states its rule as **"an empty grant sees nothing (not
 * everything)"** and every function in it implements that. That one line
 * inverted it: an empty origins array was a *marker* meaning the whole brain.
 *
 * While the only producer was the provisioned bearer that was safe. The moment
 * narrowed grants are real it fails **open**, and it fails open above every
 * fence — so no fence reports a violation, because none is consulted:
 *
 *   * a narrowed grant whose origin list is filtered to nothing by validation,
 *   * a narrowed grant re-minted after its only origin was severed (U18 §4),
 *   * a consent endpoint that believes a client-supplied empty list.
 *
 * Each becomes a whole-brain grant, silently. So the marker is now **explicit
 * and required** — {@link GrantScope} — and the invariant
 * `scope === 'narrowed' ⟺ origins.length > 0` is enforced at mint *and* at
 * verify. Enforcing it at verify is the half that matters: a signer is a thing
 * an attacker might obtain, and a token that cannot be verified is a token that
 * cannot be spent.
 *
 * ============================================================================
 * THE WILDCARD, AND WHY IT IS NOT A PREFIX MATCH
 * ============================================================================
 *
 * Origins follow a `class:source` grammar throughout this repo — `personal:mail`,
 * `work:calendar`, `personal:agent`. A "work connector grant" means *every* work
 * origin, including ones connected after the grant was issued, so a narrowed
 * grant's entry may be a **class wildcard** (`work:*`) as well as a concrete
 * origin.
 *
 * Wildcards expand **per request** against the brain's live origins, never
 * frozen at mint. Frozen at mint, a work grant issued before the first work mail
 * arrives could never read work mail, and a grant issued today would silently
 * exclude a source connected tomorrow — a fence that decays into a puzzle.
 *
 * **The class match is exact string equality on the token before the first
 * colon, never a prefix test.** R9's storage finding is the same mistake one
 * store over: a credential scoped to `tenant-a` read `tenant-abc/` because the
 * platform matched the string it was given rather than a boundary at the
 * separator. `work` is a prefix of `workplace`.
 *
 * **The expansion has a non-empty floor.** Every class wildcard contributes its
 * own agent origin (`work:agent`) whether or not the brain holds a row at it —
 * mirroring what the whole-brain grant already does, and giving a `work:*` grant
 * on a brain with no work rows the value `['work:agent']` rather than `[]`. So
 * the fail-open path above cannot be reached even through an unlucky corpus.
 */

import type { Grant } from '../core/search/fence.ts';

/**
 * Whether this credential holds the brain or a slice of it.
 *
 * Required on {@link import('./oauth.ts').GrantClaims}, and required is the
 * point: an optional field defaulting to the safe value is a field a
 * hand-assembled claims object omits, and the resulting grant would be decided
 * by which default somebody happened to write.
 */
export type GrantScope = 'whole_brain' | 'narrowed';

/** The separator between an origin's class and its source. */
export const ORIGIN_SEPARATOR = ':';

/** What a class wildcard's source half is. */
export const ORIGIN_WILDCARD = '*';

/**
 * The write origin a class grants, when the grant names no concrete one.
 *
 * `personal:agent` is `dispatch.ts`'s `DEFAULT_WRITE_ORIGIN`; this is the same
 * construction generalised to a class, so a work grant's `remember` lands at
 * `work:agent` rather than in the personal half of the brain.
 */
export function agentOriginFor(contextClass: string): string {
  return `${contextClass}${ORIGIN_SEPARATOR}agent`;
}

/**
 * The grammar an origin has to satisfy before this module will reason about it.
 *
 * Deliberately strict and deliberately anchored. Origins reach a query as bound
 * `text[]` parameters rather than as interpolated SQL, so this is not the
 * injection control — that lives in the arms. What it *is* is the control that
 * keeps the class extraction below honest: a string with two colons, or none,
 * has no class, and a fence that guessed one would be a fence deciding access on
 * a value nobody defined.
 */
const ORIGIN_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[a-z0-9][a-z0-9_.-]{0,63}$/;
const WILDCARD_PATTERN = /^[a-z][a-z0-9_-]{0,31}:\*$/;

export function isConcreteOrigin(value: string): boolean {
  return ORIGIN_PATTERN.test(value);
}

export function isClassWildcard(value: string): boolean {
  return WILDCARD_PATTERN.test(value);
}

/**
 * The class half of an origin or a wildcard, or `null` when it has none.
 *
 * **Exact, not prefix.** Callers compare the returned strings with `===`; there
 * is deliberately no `matchesClass(origin, prefix)` helper, because the shape of
 * that helper is the shape of the R9 defect.
 */
export function classOf(value: string): string | null {
  if (!isConcreteOrigin(value) && !isClassWildcard(value)) return null;
  const separator = value.indexOf(ORIGIN_SEPARATOR);
  return separator <= 0 ? null : value.slice(0, separator);
}

/** The scope half of a credential's claims, as the checks below need it. */
export interface ScopedClaims {
  readonly scope: GrantScope;
  readonly origins: readonly string[];
  readonly writeOrigin: string;
}

/**
 * Every way a credential's scope can be incoherent, as sentences.
 *
 * **Static — no database.** That is what lets it run inside `verifyAccessToken`,
 * which is below the connection and above every handler: a token that fails here
 * is refused before a tenant database is opened, so an incoherent scope costs a
 * signature check rather than a query.
 *
 * The list is returned rather than thrown so a mint-time caller can report all
 * of them at once and a verify-time caller can collapse them into the surface's
 * one refusal sentence.
 */
export function grantScopeViolations(claims: ScopedClaims): string[] {
  const findings: string[] = [];

  if (claims.scope !== 'whole_brain' && claims.scope !== 'narrowed') {
    findings.push(`scope must be 'whole_brain' or 'narrowed', not ${JSON.stringify(claims.scope)}`);
    return findings;
  }

  if (claims.scope === 'whole_brain') {
    // The two halves of one invariant. A whole-brain grant carrying origins is
    // a credential whose author believed it was narrowing something, and the
    // reader that ignores the list is the reader that hands over the brain.
    if (claims.origins.length > 0) {
      findings.push(
        'a whole_brain grant must carry no origins — a list that is ignored is a narrowing somebody believed in',
      );
    }
    if (!isConcreteOrigin(claims.writeOrigin)) {
      findings.push(`writeOrigin ${JSON.stringify(claims.writeOrigin)} is not a well-formed origin`);
    }
    return findings;
  }

  // ---- narrowed --------------------------------------------------------
  //
  // This is the branch the whole module exists for. An empty list here used to
  // mean "the whole brain"; it now means the credential is refused.
  if (claims.origins.length === 0) {
    findings.push(
      'a narrowed grant must name at least one origin — an empty list used to fall through to the whole brain, ' +
        'which is the one place this system inverted fence.ts\'s "an empty grant sees nothing"',
    );
  }

  for (const entry of claims.origins) {
    if (typeof entry !== 'string' || (!isConcreteOrigin(entry) && !isClassWildcard(entry))) {
      findings.push(`${JSON.stringify(entry)} is neither a well-formed origin nor a class wildcard`);
    }
  }

  if (!isConcreteOrigin(claims.writeOrigin)) {
    findings.push(`writeOrigin ${JSON.stringify(claims.writeOrigin)} is not a well-formed origin`);
    return findings;
  }

  // **`writeOrigin` must be inside the grant**, and this is checkable without a
  // database because a wildcard's class is enough.
  //
  // Without it a work-scoped grant writes `personal:agent` rows: a cross-context
  // *write*, and one the same grant cannot then read back — so it is invisible
  // to every test that stores and recalls under one credential, which is every
  // test anybody writes for `remember`.
  const writeClass = classOf(claims.writeOrigin);
  const permitted = claims.origins.some(
    (entry) => entry === claims.writeOrigin || (isClassWildcard(entry) && classOf(entry) === writeClass),
  );
  if (!permitted) {
    findings.push(
      `writeOrigin ${JSON.stringify(claims.writeOrigin)} is outside this grant's origins ` +
        `(${claims.origins.join(', ')}) — a grant that writes where it cannot read plants rows it can never see`,
    );
  }

  return findings;
}

/**
 * The narrowed grant's origins, expanded against what the brain actually holds.
 *
 * **One function, called from one place** (`dispatch.ts`, below the credential
 * and above every handler). A second expander is a second answer to "what may
 * this credential read", and this repo's recorded defect is a fence added at one
 * call site while others bypass it.
 *
 * `available` is the brain's live origin list (`reads.ts:brainOrigins`, the one
 * deliberately unfenced read — it *builds* fences and its result never reaches a
 * caller). Concrete entries are kept whether or not the brain currently holds a
 * row at them, so a grant is not silently re-scoped by an empty corpus; wildcard
 * entries expand to every matching live origin plus the class's agent origin.
 *
 * The result is sorted and de-duplicated so that two calls with the same inputs
 * produce the same `text[]` parameter — which is what makes a fenced query plan
 * cacheable and a failing test reproducible.
 */
export function expandGrant(origins: readonly string[], available: readonly string[]): Grant {
  const out = new Set<string>();

  for (const entry of origins) {
    if (isClassWildcard(entry)) {
      const wanted = classOf(entry);
      if (wanted === null) continue;
      // The floor: a class always grants its own agent origin, so a wildcard
      // over a class the brain holds no rows for is still a non-empty grant.
      out.add(agentOriginFor(wanted));
      for (const origin of available) {
        // Exact class equality. `startsWith(wanted)` here would make a `work:*`
        // grant read `workplace:mail` — R9's sibling-prefix finding, one store
        // over and with no platform to blame.
        if (classOf(origin) === wanted) out.add(origin);
      }
      continue;
    }
    if (isConcreteOrigin(entry)) out.add(entry);
  }

  return [...out].sort();
}

/**
 * **The one place a credential becomes a fence.** `dispatch.ts` calls this and
 * nothing else does.
 *
 * It is a named function rather than a ternary inside the dispatcher for a
 * reason the mutation pass found the hard way: the fail-open branch it exists to
 * refuse is **unreachable through the request path** once the mint and verify
 * guards are in place, so a mutation restoring the pre-U18 behaviour *survived*
 * the whole integration suite. A guard nothing can provoke is a guard nobody can
 * prove, and this repo has shipped several of those. Extracting the decision
 * makes it directly testable: `test/mcp/grant-scope.test.ts` hands it the shape
 * the request path can no longer produce and asserts it still refuses.
 *
 * **`available` is a thunk, not a value.** A narrowed grant naming only concrete
 * origins needs no census of the brain, and making the caller compute one
 * unconditionally would put four `DISTINCT` scans on the warm path of every
 * request a work connector makes. It is awaited exactly when a wildcard or a
 * whole-brain grant is present.
 *
 * **There is no fallback and there must never be one.** The pre-U18 line read
 * `origins.length > 0 ? origins : wholeBrain`, which is the inversion of
 * `fence.ts`'s "an empty grant sees nothing (not everything)" — and it sat
 * *above* every fence, so no fence could report it. If a narrowed grant ever
 * resolves to nothing, the correct outcome is that it reads nothing.
 */
export async function resolveGrant(
  claims: ScopedClaims,
  available: () => Promise<readonly string[]>,
): Promise<Grant> {
  if (claims.scope === 'narrowed') {
    // Only pay for the census when something in the grant needs one.
    const needsCensus = claims.origins.some(isClassWildcard);
    return expandGrant(claims.origins, needsCensus ? await available() : []);
  }

  // The whole brain: every origin it holds, plus the origin this grant writes
  // through — so a brand-new tenant holding no rows at all can still store its
  // first memory and read it back (R2a's activation loop, which precedes OAuth).
  const origins = new Set(await available());
  origins.add(claims.writeOrigin);
  return [...origins].sort();
}

/**
 * The classes a narrowed grant covers, for a surface that has to name them.
 *
 * Used by the consent step and by the severance flow's grant-revocation leg,
 * both of which reason about "the work connector's grant" rather than about a
 * particular origin string.
 */
export function classesOf(origins: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of origins) {
    const contextClass = classOf(entry);
    if (contextClass !== null) out.add(contextClass);
  }
  return [...out].sort();
}

/**
 * Build a narrowed scope for one context class — the product shape.
 *
 * The consent endpoint's whole vocabulary: "this connector reads your work
 * context". Returns the claims halves rather than a whole claims object, so the
 * caller cannot forget to set `scope` (it is in the return type) and cannot
 * choose a write origin outside the grant (it is derived, not accepted).
 */
export function contextGrant(contextClass: string): ScopedClaims | null {
  if (classOf(`${contextClass}${ORIGIN_SEPARATOR}x`) !== contextClass) return null;
  return {
    scope: 'narrowed',
    origins: [`${contextClass}${ORIGIN_SEPARATOR}${ORIGIN_WILDCARD}`],
    writeOrigin: agentOriginFor(contextClass),
  };
}

/**
 * The OAuth `scope` value that asks for one context, e.g. `brainz:context:work`.
 *
 * Namespaced because `scope` is a public, client-supplied, space-delimited
 * string and this server is a public issuer: an unprefixed `work` would collide
 * with whatever a future spec or client decides `work` means, and the collision
 * would resolve into a *grant*.
 */
export const CONTEXT_SCOPE_PREFIX = 'brainz:context:';

/**
 * Read a requested scope off an OAuth `scope` parameter.
 *
 * **Absent means the whole brain, and one unrecognised token means refuse.**
 * That asymmetry is deliberate. Absent is the ordinary case — every client
 * shipping today sends no scope, and treating that as "nothing" would break
 * every existing connector. But a client that *did* ask for something and got
 * something else has been silently over-granted, and the failure is invisible
 * from both ends: the client believes it holds a work connector and holds the
 * brain. So an unrecognised token is an error rather than a fallback.
 *
 * Only one context may be requested. Two would be a grant covering two classes,
 * which is expressible — but it is not a shape any product surface asks for, and
 * a parser that silently supports an unasked-for combination is a parser whose
 * behaviour nobody has decided.
 */
export type RequestedScope =
  | { readonly ok: true; readonly scoped: ScopedClaims }
  | { readonly ok: false; readonly reason: string };

export function parseRequestedScope(
  raw: string | null,
  wholeBrainWriteOrigin: string,
): RequestedScope {
  const whole: ScopedClaims = {
    scope: 'whole_brain',
    origins: [],
    writeOrigin: wholeBrainWriteOrigin,
  };

  const tokens = (raw ?? '').split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return { ok: true, scoped: whole };

  const contexts: string[] = [];
  for (const token of tokens) {
    if (!token.startsWith(CONTEXT_SCOPE_PREFIX)) {
      return { ok: false, reason: `unknown scope ${JSON.stringify(token)}` };
    }
    contexts.push(token.slice(CONTEXT_SCOPE_PREFIX.length));
  }

  if (contexts.length > 1) {
    return { ok: false, reason: 'only one context may be requested per grant' };
  }

  const scoped = contextGrant(contexts[0] ?? '');
  if (scoped === null) {
    return { ok: false, reason: `${JSON.stringify(contexts[0] ?? '')} is not a context class` };
  }
  return { ok: true, scoped };
}
