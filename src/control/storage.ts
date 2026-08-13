/**
 * The storage accessor (U2 approach step 4) — the one place a tenant id becomes
 * an object-storage prefix, an object key, or a credential.
 *
 * **R9's file-storage claim rests on this module.** R9 reads: the R2 boundary is
 * *platform-enforced, conditional on correct prefix derivation*. The conditional
 * is not a hedge, it is a measured fact — `scripts/probes/r2-boundary/RESULT.md`
 * recorded a credential scoped to `tenant-a` reading `tenant-abc/` at HTTP 200,
 * and the body was the sibling tenant's fixture. R2 matches `prefixes`
 * **literally**: it enforces the string it was given, not a boundary at the
 * separator. Everything below follows from that one sentence.
 *
 * Four rules hold this together, and each is pinned by a test:
 *
 * 1. **Every derived prefix terminates with `/`.** This is a REQUIRED control,
 *    not tidiness and not defence in depth. `derivePrefix` is the only way to
 *    obtain a `TenantPrefix`, it always appends the separator, and the type is
 *    branded so no call site can substitute a hand-built string. A tenant id
 *    that already carries a separator is *rejected*, never normalised —
 *    append-if-missing would alias `alice/` and `alice` onto one prefix, which
 *    is two accepted ids sharing one keyspace.
 *
 * 2. **Every accessor takes an explicit caller identity**, exactly as
 *    `secrets.ts` does. Nothing here reads ambient state to decide who is
 *    asking, and this module exports no pre-built singleton. The identity
 *    vocabulary is imported from `secrets.ts` rather than re-declared: one
 *    identity model, two keyspaces (`secrets.ts` owns the secret namespace,
 *    this file owns the object-storage prefix).
 *
 * 3. **The caller-supplied remainder is validated, never sanitised.** Object
 *    stores keep keys as literal strings, so a Drive filename or a provider item
 *    id containing `../` is a real object under someone else's prefix — and
 *    sanitising is a losing game against percent-encoding, double
 *    percent-encoding and every future encoding nobody has thought of. Where a
 *    stable id is needed from untrusted input, `keyForUntrusted` **hashes** it.
 *
 * 4. **The parent credential is not reachable from the request path.** The
 *    parent lives inside a `ScopedCredentialMinter` closure; the accessor holds
 *    the minter, exposes only methods, and can obtain nothing but a
 *    prefix-scoped, short-TTL credential. This is the same rule R11 applies to
 *    connection strings, now applying to a second store — and per R10 the
 *    blast-radius reduction is real *only* if it holds.
 *
 * **What "revocation" honestly means here.** `invalidate` drops this process's
 * cached credential; it cannot recall a credential already handed out. The
 * platform-side credential stays valid until its own TTL lapses, which is why
 * the TTL is short and why the cache is always bounded strictly below it. A
 * cache that outlives its credential hands the request path a 403 machine; a
 * cache that outlives a revocation is a security bug. Neither is possible here,
 * but only the first of those is fully within this module's power.
 *
 * Minting is pluggable and no vendor is hardcoded. R2 documents two modes and
 * the probe verified both — an API mint (~190ms p50, sustained 72/s concurrent,
 * spends the shared REST budget) and an in-process HS256 JWT mint (no network
 * call at all). Both satisfy `ScopedCredentialMinter`, which deliberately takes
 * an already-derived `TenantPrefix` rather than a tenant id: a minter cannot
 * re-derive a prefix, correctly or otherwise. The production minters are wired
 * in a later unit; the in-memory implementation below is for tests.
 */

import { createHash } from 'node:crypto';

import { isValidTenantId, type CallerIdentity } from './secrets.ts';

/**
 * A tenant's object-storage prefix, guaranteed terminated. Branded so the only
 * way to hold one is to have derived it here — a bare string literal will not
 * typecheck where a `TenantPrefix` is required.
 */
declare const tenantPrefixBrand: unique symbol;
export type TenantPrefix = string & { readonly [tenantPrefixBrand]: 'tenant-prefix' };

/** A full object key, guaranteed to sit under its tenant's prefix. */
declare const objectKeyBrand: unique symbol;
export type ObjectKey = string & { readonly [objectKeyBrand]: 'object-key' };

/**
 * The two object-scoped permissions. The `admin-*` values R2 also accepts are
 * deliberately absent from the type: the request path has no business holding a
 * credential that can manage buckets, so it must not be expressible here.
 */
export type R2ObjectPermission = 'object-read-only' | 'object-read-write';

/** What the request path is allowed to hold: prefix-scoped, and it expires. */
export interface ScopedCredential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** The scope, carried with the credential so a caller can never re-derive it. */
  readonly prefix: TenantPrefix;
  readonly permission: R2ObjectPermission;
  readonly expiresAtMs: number;
}

/**
 * A mint request. Takes the *derived* prefix, never a tenant id — so no minter
 * implementation, present or future, can participate in prefix derivation.
 */
export interface MintRequest {
  readonly prefix: TenantPrefix;
  readonly permission: R2ObjectPermission;
  readonly ttlSeconds: number;
}

/** The pluggable mint path. Holds the parent credential; never leaks it. */
export interface ScopedCredentialMinter {
  mint(request: MintRequest): Promise<ScopedCredential>;
}

export type PrefixFailureReason = 'scope_denied' | 'invalid_tenant_id';

/**
 * Why a key could not be derived. The remainder reasons are deliberately
 * separate values rather than one `invalid_key`: an operator reading a log needs
 * to know whether a client sent a path separator, a traversal, or a name their
 * own product allowed and this accessor does not.
 */
export type KeyFailureReason =
  | PrefixFailureReason
  | 'empty_remainder'
  | 'empty_segment'
  | 'separator_in_segment'
  | 'traversal_in_segment'
  | 'encoded_separator'
  | 'segment_too_long'
  | 'illegal_character'
  | 'key_too_long';

export type PrefixResult =
  | { readonly ok: true; readonly prefix: TenantPrefix }
  | { readonly ok: false; readonly reason: PrefixFailureReason };

export type KeyResult =
  | { readonly ok: true; readonly key: ObjectKey }
  | { readonly ok: false; readonly reason: KeyFailureReason };

export type CredentialResult =
  | { readonly ok: true; readonly credential: ScopedCredential }
  | { readonly ok: false; readonly reason: PrefixFailureReason };

export type InvalidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PrefixFailureReason };

/**
 * The accessor. Per `src/README.md`, no module outside this one constructs an
 * object key — the scope check lives below the handlers so no call site can
 * forget it.
 */
export interface TenantStorage {
  /** This tenant's prefix. Always terminated. Fleet identity for this tenant only. */
  prefixFor(caller: CallerIdentity, tenantId: string): PrefixResult;
  /** A key from segments the caller controls. Every segment is validated. */
  keyFor(caller: CallerIdentity, tenantId: string, remainder: readonly string[]): KeyResult;
  /**
   * A key from untrusted input — a Drive file id, a mail attachment name. The
   * untrusted half is hashed, not sanitised; `collection` is a caller-chosen
   * literal and goes through exactly the same validation as any other segment.
   */
  keyForUntrusted(
    caller: CallerIdentity,
    tenantId: string,
    collection: string,
    untrustedId: string,
  ): KeyResult;
  /** A prefix-scoped, short-TTL credential. Fleet identity for this tenant only. */
  credentialFor(caller: CallerIdentity, tenantId: string): Promise<CredentialResult>;
  /** Drop the cached credential. Control plane only. See the note on revocation. */
  invalidate(caller: CallerIdentity, tenantId: string): Promise<InvalidateResult>;
}

export interface TenantStorageOptions {
  readonly minter: ScopedCredentialMinter;
  /** Credential lifetime. The probe accepted 60s/300s/900s/3600s. */
  readonly credentialTtlSeconds?: number;
  /**
   * How long a credential may be served from memory. Always clamped below the
   * credential's own expiry — see `cacheDeadline`. Configuring this *longer*
   * than the credential is not an error, it is simply ignored.
   */
  readonly cacheTtlMs?: number;
  /** Injectable clock. Tests advance it; production passes nothing. */
  readonly now?: () => number;
  /** Cache size ceiling, so a long-lived fleet process cannot grow unbounded. */
  readonly maxEntries?: number;
}

export interface InMemoryMinterOptions {
  readonly parentAccessKeyId: string;
  readonly parentSecretAccessKey: string;
  readonly now?: () => number;
}

/**
 * 900s — the TTL the probe ran its scope matrix at, deliberately not the
 * shortest accepted, so a credential cannot expire mid-operation and be misread
 * as a denial.
 */
export const DEFAULT_CREDENTIAL_TTL_SECONDS = 900;

export const DEFAULT_CACHE_TTL_MS = 300_000;

/**
 * A cached credential is never served inside this margin of its own expiry, so
 * a caller always has usable time left on what it receives. Capped at half the
 * credential's lifetime, so a short TTL narrows the cache window rather than
 * disabling caching entirely.
 */
export const CACHE_SAFETY_MARGIN_MS = 60_000;

/** Sized as in `secrets.ts`: ~500 warm tenants per instance under DO affinity. */
export const DEFAULT_MAX_ENTRIES = 512;

/** The request path gets object read/write on its own prefix, and nothing else. */
const CREDENTIAL_PERMISSION: R2ObjectPermission = 'object-read-write';

const SEPARATOR = '/';

/** Root segment, so non-tenant objects can share a bucket without collision. */
const PREFIX_ROOT = 'tenants';

const MAX_SEGMENT_LENGTH = 128;

/** S3-compatible key ceiling. Exceeding it fails at the platform, so fail here. */
const MAX_KEY_LENGTH = 1024;

/** Enough rounds to see through double and triple percent-encoding. */
const MAX_DECODE_ROUNDS = 4;

/**
 * An allowlist, not a denylist. Anything outside it goes through
 * `keyForUntrusted` and gets hashed — which is the honest answer for a Unicode
 * filename, and a far better one than a sanitiser nobody can prove complete.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * R2's MEASURED scope semantics, in one line: a literal leading-substring match.
 * Not a component-aware match, not a path match. Exported because it is the only
 * correct model of the platform's check, and used internally as the invariant
 * every derived key is verified against before it is returned.
 */
export function prefixCovers(prefix: TenantPrefix, key: string): boolean {
  return key.startsWith(prefix);
}

/**
 * Turn untrusted input into a stable segment. Hashing rather than sanitising is
 * the point: the output is fixed-length, in the allowlist alphabet by
 * construction, and carries no attacker-chosen bytes at all.
 */
export function hashUntrustedSegment(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function containsSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/**
 * Every form the segment could decode to, bounded. A malformed percent sequence
 * stops the walk — it is caught by the allowlist a moment later.
 */
function decodedForms(value: string): string[] {
  const forms: string[] = [];
  let current = value;

  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }

  return forms;
}

/** `undefined` means the segment is acceptable. */
function segmentFailure(segment: string): KeyFailureReason | undefined {
  if (segment.length === 0) return 'empty_segment';
  if (containsSeparator(segment)) return 'separator_in_segment';

  const decoded = decodedForms(segment);
  if (decoded.some(containsSeparator)) return 'encoded_separator';
  if (segment.includes('..')) return 'traversal_in_segment';
  if (decoded.some((form) => form.includes('..'))) return 'traversal_in_segment';

  if (segment.length > MAX_SEGMENT_LENGTH) return 'segment_too_long';
  if (!SEGMENT_PATTERN.test(segment)) return 'illegal_character';

  return undefined;
}

/**
 * The single place a tenant id becomes a storage prefix, and the only way to
 * obtain a `TenantPrefix`. Callers reach it through `prefixFor`, which applies
 * the scope check first.
 *
 * The invariant check below is not decoration. If `isValidTenantId` ever
 * loosened to admit a trailing separator, this throws at derivation rather than
 * silently minting a credential scoped to `tenants/alice//` — or, far worse, a
 * caller stripping the double separator back to `tenants/alice`.
 */
function derivePrefix(tenantId: string): TenantPrefix {
  const prefix = `${PREFIX_ROOT}${SEPARATOR}${tenantId}${SEPARATOR}`;

  if (!prefix.endsWith(SEPARATOR) || prefix.endsWith(`${SEPARATOR}${SEPARATOR}`)) {
    throw new Error('invariant: a derived prefix must end in exactly one separator');
  }

  return prefix as TenantPrefix;
}

/** Access: the fleet identity serving exactly this tenant, and nothing else. */
function canAccess(caller: CallerIdentity, tenantId: string): boolean {
  return caller.kind === 'fleet' && caller.tenantId === tenantId;
}

/** Invalidation: the control plane, and nothing else. Mirrors `secrets.ts`. */
function canInvalidate(caller: CallerIdentity): boolean {
  return caller.kind === 'control-plane';
}

function frozenCredential(credential: ScopedCredential): ScopedCredential {
  return Object.freeze({
    accessKeyId: credential.accessKeyId,
    secretAccessKey: credential.secretAccessKey,
    sessionToken: credential.sessionToken,
    prefix: credential.prefix,
    permission: credential.permission,
    expiresAtMs: credential.expiresAtMs,
  });
}

interface CacheEntry {
  readonly credential: ScopedCredential;
  readonly expiresAt: number;
}

/**
 * In-memory minter for tests and local development. Never for production.
 *
 * The parent secret is captured in this closure and never appears in what it
 * returns. `accessKeyId` echoes the parent's *access key id* deliberately —
 * R2's local-mint scheme does the same, and an access key id is an identifier,
 * not a secret. The property under test is that the parent *secret* is neither
 * present in nor recoverable from anything the request path receives, which the
 * one-way derivation below preserves. This is a stand-in, not R2's scheme.
 */
export function createInMemoryCredentialMinter(
  options: InMemoryMinterOptions,
): ScopedCredentialMinter {
  const { parentAccessKeyId, parentSecretAccessKey } = options;
  const now = options.now ?? Date.now;
  // Distinguishes two mints made at the same instant, so a re-mint after an
  // invalidation is observably a different credential.
  let serial = 0;

  return {
    mint(request) {
      serial += 1;
      const expiresAtMs = now() + request.ttlSeconds * 1_000;
      const material = [
        parentSecretAccessKey,
        request.prefix,
        request.permission,
        String(expiresAtMs),
        String(serial),
      ].join('|');

      return Promise.resolve(
        frozenCredential({
          accessKeyId: parentAccessKeyId,
          secretAccessKey: createHash('sha256').update(material, 'utf8').digest('hex'),
          sessionToken: `fake-session/${createHash('sha256')
            .update(`session|${material}`, 'utf8')
            .digest('hex')}`,
          prefix: request.prefix,
          permission: request.permission,
          expiresAtMs,
        }),
      );
    },
  };
}

export function createTenantStorage(options: TenantStorageOptions): TenantStorage {
  const { minter } = options;
  const credentialTtlSeconds = options.credentialTtlSeconds ?? DEFAULT_CREDENTIAL_TTL_SECONDS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  /** Keyed on the derived prefix, so nothing weaker than the boundary is cached. */
  const cache = new Map<string, CacheEntry>();

  /**
   * When a cached credential stops being servable. Two bounds, and the tighter
   * always wins: the configured cache TTL, and the credential's own expiry less
   * a safety margin. The second is why a cache can never outlive its credential
   * however the first is configured.
   */
  function cacheDeadline(credential: ScopedCredential): number {
    const lifetimeMs = credentialTtlSeconds * 1_000;
    const margin = Math.min(CACHE_SAFETY_MARGIN_MS, Math.max(1, Math.floor(lifetimeMs / 2)));
    return Math.min(now() + cacheTtlMs, credential.expiresAtMs - margin);
  }

  function readCache(prefix: TenantPrefix): ScopedCredential | undefined {
    const entry = cache.get(prefix);
    if (entry === undefined) return undefined;

    // Both bounds re-checked on every read: the cache deadline, and — belt and
    // braces against a minter that reported an expiry it did not honour — the
    // credential's own.
    if (entry.expiresAt <= now() || entry.credential.expiresAtMs <= now()) {
      cache.delete(prefix);
      return undefined;
    }

    // Refresh recency without extending the deadline: eviction is
    // least-recently-used, expiry stays absolute from the mint.
    cache.delete(prefix);
    cache.set(prefix, entry);
    return entry.credential;
  }

  function writeCache(prefix: TenantPrefix, credential: ScopedCredential): void {
    const expiresAt = cacheDeadline(credential);
    // A credential with no usable window left is served once and not stored.
    if (expiresAt <= now()) return;

    cache.delete(prefix);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(prefix, { credential, expiresAt });
  }

  /**
   * Scope first, then id validity — the order `secrets.ts` asserts. A denied
   * caller learns nothing about whether the id was well-formed or the tenant
   * exists.
   */
  function gate(caller: CallerIdentity, tenantId: string): PrefixFailureReason | undefined {
    if (!canAccess(caller, tenantId)) return 'scope_denied';
    if (!isValidTenantId(tenantId)) return 'invalid_tenant_id';
    return undefined;
  }

  function buildKey(prefix: TenantPrefix, segments: readonly string[]): KeyResult {
    for (const segment of segments) {
      const failure = segmentFailure(segment);
      if (failure !== undefined) return { ok: false, reason: failure };
    }

    const key = `${prefix}${segments.join(SEPARATOR)}`;
    if (key.length > MAX_KEY_LENGTH) return { ok: false, reason: 'key_too_long' };

    // Unreachable if the validation above is complete — which is exactly why it
    // is checked rather than assumed. A derived key that escapes its own prefix
    // is a cross-tenant write, so it must never be *returned* while merely
    // suspected.
    if (!prefixCovers(prefix, key)) {
      throw new Error('invariant: a derived key escaped its tenant prefix');
    }

    return { ok: true, key: key as ObjectKey };
  }

  return {
    prefixFor(caller, tenantId) {
      const denied = gate(caller, tenantId);
      if (denied !== undefined) return { ok: false, reason: denied };
      return { ok: true, prefix: derivePrefix(tenantId) };
    },

    keyFor(caller, tenantId, remainder) {
      const denied = gate(caller, tenantId);
      if (denied !== undefined) return { ok: false, reason: denied };
      if (remainder.length === 0) return { ok: false, reason: 'empty_remainder' };

      return buildKey(derivePrefix(tenantId), remainder);
    },

    keyForUntrusted(caller, tenantId, collection, untrustedId) {
      const denied = gate(caller, tenantId);
      if (denied !== undefined) return { ok: false, reason: denied };

      // An empty id is rejected rather than hashed. The hash of "" is perfectly
      // stable, which is the problem: every object with a missing id would file
      // under one key. A missing provider id is an upstream bug, not a name.
      if (untrustedId.length === 0) return { ok: false, reason: 'empty_segment' };

      return buildKey(derivePrefix(tenantId), [collection, hashUntrustedSegment(untrustedId)]);
    },

    async credentialFor(caller, tenantId) {
      const denied = gate(caller, tenantId);
      if (denied !== undefined) return { ok: false, reason: denied };

      const prefix = derivePrefix(tenantId);

      const cached = readCache(prefix);
      if (cached !== undefined) return { ok: true, credential: cached };

      const minted = frozenCredential(
        await minter.mint({
          prefix,
          permission: CREDENTIAL_PERMISSION,
          ttlSeconds: credentialTtlSeconds,
        }),
      );

      // A minter that returned a different scope than it was asked for would
      // widen the boundary silently, and the credential would still work. Fail
      // loudly instead: this is the one place that substitution is detectable.
      if (minted.prefix !== prefix) {
        throw new Error('invariant: minter returned a credential scoped to a different prefix');
      }

      writeCache(prefix, minted);
      return { ok: true, credential: minted };
    },

    invalidate(caller, tenantId) {
      if (!canInvalidate(caller)) {
        return Promise.resolve({ ok: false, reason: 'scope_denied' });
      }
      if (!isValidTenantId(tenantId)) {
        return Promise.resolve({ ok: false, reason: 'invalid_tenant_id' });
      }

      cache.delete(derivePrefix(tenantId));
      return Promise.resolve({ ok: true });
    },
  };
}
