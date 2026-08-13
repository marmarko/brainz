/**
 * R10's receipt, and the key that must not be ours to read.
 *
 * **The whole unit turns on one sentence.** An attestation signed by a key the
 * MCP fleet can read proves nothing an attacker who owns the fleet could not
 * forge. The fleet is the process that parses attacker-controlled mail; if one
 * compromise of it yields both the isolation failure and the ability to mint
 * valid receipts for it, the receipt keeps verifying after the property stops
 * holding — which inverts the control it was built to be. So the private key
 * lives outside the fleet's readable secret scope, and this module is shaped to
 * make that expressible rather than aspirational:
 *
 *   * {@link AttestationSigner} is a **capability**, not a secret. It offers
 *     `sign` and `verificationKey` and nothing else — no export, no accessor, no
 *     round trip to key bytes. A fleet holding one can produce receipts and
 *     cannot produce the key.
 *   * The signer takes an {@link AttestationPayload}, never a string, and
 *     domain-separates before signing. A sign-only endpoint built to this
 *     interface is bound to a fixed payload shape rather than being a
 *     general-purpose signing oracle for whatever a caller hands it.
 *   * `TenantSecretStore` — the store the request path *can* read — carries a
 *     connection string and a bearer and nothing else. Putting the signing key
 *     beside them is the default this design exists to refuse, and
 *     `test/mcp/attestation.test.ts` pins that shape so doing it is a red test
 *     rather than a code review.
 *
 * **What ships here is a fake, and that is stated rather than implied.**
 * {@link createInProcessSigner} holds an HMAC key in a closure. It proves the
 * *code* offers no export path; it cannot prove a deployed container is denied
 * one, because that is an IAM policy on a real KMS key and not a property of
 * this repository. `docs/register.md` records the custody, the rotation and the
 * revocation procedure beside the published verification key, and records that
 * the key does not exist yet.
 *
 * **What the payload may claim is bounded by what was verified.** The Neon
 * boundary is structural — one project, one database, one role per tenant,
 * checkable from the connection string. The object-storage boundary is
 * structural *conditional on correct prefix derivation*, because R9's probe
 * measured R2 matching prefixes literally rather than at a separator. Reporting
 * the second as unconditionally structural would be the same failure as signing
 * with a key the fleet holds: a receipt that outlives its property.
 *
 * **And what the fleet cannot resolve is reported as absent, never guessed.**
 * The Neon project id lives on the control-plane row, which the fleet identity
 * has no permission to read (R11, deliberately). Endpoint hosts and project ids
 * look alike and are not the same identifier, so `project.id` is `null` with a
 * stated source rather than a plausible string parsed out of a hostname.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The domain tag. Prefixed before signing so this signer signs nothing else. */
export const ATTESTATION_DOMAIN = 'brainz.app/attestation/v1';

/** What the database boundary claims. One value: it is structural or it is not. */
export type DatabaseBoundary = 'structural';

/**
 * What the object-storage boundary claims, carrying R9's condition in the value.
 *
 * A separate string rather than `'structural'` plus a footnote, because the
 * footnote is the part that gets dropped when somebody renders the receipt.
 */
export type StorageBoundary = 'structural_conditional_on_prefix_derivation';

/** How `project.id` came to be what it is. `unresolved` is a real answer. */
export type ProjectIdSource = 'control_plane' | 'unresolved';

/** How `storage.prefix` came to be what it is. */
export type StoragePrefixSource = 'derived' | 'unavailable';

/**
 * The boundary facts, derived above the handlers from what the fleet provably
 * holds.
 *
 * Assembled in `dispatch.ts` from the resolved tenant secret, so the DSN — which
 * is key material — never reaches a `ToolContext`. What a handler sees is this:
 * a host, a database name and a prefix, none of which is a credential.
 */
export interface TenantBoundaryFacts {
  readonly projectId: string | null;
  readonly projectIdSource: ProjectIdSource;
  /** The database endpoint's host, userinfo discarded. Checkable by the tenant. */
  readonly endpointHost: string;
  readonly databaseName: string;
  readonly storagePrefix: string | null;
  readonly storagePrefixSource: StoragePrefixSource;
}

/**
 * The signed body.
 *
 * **Counts are deliberately not in it.** They change on every write, and a
 * signature over a value that changes every write is one nobody can cache,
 * compare between two responses, or check against a replay. Counts ride the
 * `brain` tool's own body, beside the attestation rather than inside it.
 */
export interface AttestationPayload {
  readonly tenant_id: string;
  readonly issued_at: string;
  readonly project: {
    readonly id: string | null;
    readonly id_source: ProjectIdSource;
    readonly endpoint_host: string;
  };
  readonly database: { readonly name: string };
  readonly storage: {
    readonly prefix: string | null;
    readonly prefix_source: StoragePrefixSource;
  };
  readonly boundaries: {
    readonly database: DatabaseBoundary;
    readonly storage: StorageBoundary;
  };
  readonly definitions_digest: string;
  readonly instructions_release: string;
}

export interface AttestationSignature {
  readonly alg: string;
  readonly key_id: string;
  readonly value: string;
}

/** No signer wired. A named absence, never a self-signed receipt. */
export interface AttestationUnsigned {
  readonly status: 'unsigned';
  readonly reason: string;
}

export type AttestationSeal = AttestationSignature | AttestationUnsigned;

export interface VerificationKey {
  readonly alg: string;
  readonly key_id: string;
  /**
   * The published half.
   *
   * For the HMAC fake this is a *digest* of the key rather than the key, so the
   * shipped implementation does not accidentally become the thing it exists to
   * refuse. A real asymmetric signer publishes an actual public key here and
   * `verifyAttestation` verifies against it; the HMAC fake verifies through the
   * signer it was built with, which is why the verify path takes a verifier
   * rather than a raw key.
   */
  readonly published: string;
}

/**
 * A signer, as a capability.
 *
 * Two methods. Anything that would let a holder recover the key — an `export`, a
 * `privateKey` getter, a `toJSON` that closes over it — is absent by design, and
 * `test/mcp/attestation.test.ts` attempts the export through this interface to
 * prove the absence is real rather than an absence nothing tried to violate.
 */
export interface AttestationSigner {
  sign(payload: AttestationPayload): Promise<AttestationSignature>;
  verify(payload: AttestationPayload, signature: AttestationSignature): Promise<boolean>;
  verificationKey(): VerificationKey;
}

/** What `_meta` and `brain` both carry. The payload plus its seal. */
export interface SignedAttestation extends AttestationPayload {
  readonly signature: AttestationSeal;
}

/**
 * The bytes that get signed.
 *
 * Field order is fixed here rather than inherited from object literal order, so
 * two callers building the same facts sign the same bytes. `JSON.stringify` over
 * a hand-ordered array is enough and is auditable by eye; a general canonical-
 * JSON implementation would be more code and more surface for the two sides to
 * disagree over.
 */
export function canonicalAttestationBytes(payload: AttestationPayload): string {
  const ordered = [
    ATTESTATION_DOMAIN,
    payload.tenant_id,
    payload.issued_at,
    payload.project.id ?? '',
    payload.project.id_source,
    payload.project.endpoint_host,
    payload.database.name,
    payload.storage.prefix ?? '',
    payload.storage.prefix_source,
    payload.boundaries.database,
    payload.boundaries.storage,
    payload.definitions_digest,
    payload.instructions_release,
  ];
  return JSON.stringify(ordered);
}

/**
 * The shipped fake: an HMAC key in a closure, reachable by no accessor.
 *
 * `key` is a parameter and is never stored on the returned object. The returned
 * object is frozen and carries three methods, so a caller holding it can sign,
 * can verify, and cannot enumerate its way to the secret. This is a stand-in for
 * a KMS `Sign` grant or a sign-only signer endpoint, and it is not one: it runs
 * inside the fleet process, so a fleet with arbitrary code execution can read it
 * out of memory. That residual is real and is recorded in `docs/register.md`
 * rather than papered over here.
 */
export function createInProcessSigner(options: {
  readonly key: string;
  readonly keyId: string;
}): AttestationSigner {
  const { key, keyId } = options;

  if (key.length === 0) {
    // A zero-length HMAC key signs perfectly well and is worth nothing. Refusing
    // it here rather than in a config check, because this is the one place every
    // construction goes through.
    throw new Error('an attestation signer cannot be built on an empty key');
  }

  const mac = (payload: AttestationPayload): string =>
    createHmac('sha256', key).update(canonicalAttestationBytes(payload)).digest('hex');

  return Object.freeze({
    sign(payload: AttestationPayload): Promise<AttestationSignature> {
      return Promise.resolve({ alg: 'HMAC-SHA256', key_id: keyId, value: mac(payload) });
    },

    verify(payload: AttestationPayload, signature: AttestationSignature): Promise<boolean> {
      if (signature.alg !== 'HMAC-SHA256' || signature.key_id !== keyId) {
        return Promise.resolve(false);
      }
      const expected = Buffer.from(mac(payload), 'hex');
      let presented: Buffer;
      try {
        presented = Buffer.from(signature.value, 'hex');
      } catch {
        return Promise.resolve(false);
      }
      // Length first: `timingSafeEqual` throws on a mismatch, and a throw here
      // would turn a forged signature into a 500 rather than a `false`.
      if (presented.length !== expected.length) return Promise.resolve(false);
      return Promise.resolve(timingSafeEqual(expected, presented));
    },

    verificationKey(): VerificationKey {
      return {
        alg: 'HMAC-SHA256',
        key_id: keyId,
        // A digest, not the key. An HMAC key IS the verification key, so
        // publishing it would hand every reader the ability to forge — the
        // exact property this module exists to deny. The digest lets a holder
        // confirm *which* key signed without being able to sign.
        published: `sha256:${createHmac('sha256', 'brainz.app/attestation/key-id').update(key).digest('hex')}`,
      };
    },
  });
}

/**
 * Build the payload. Pure, so the same facts always produce the same bytes.
 */
export function attestationPayload(input: {
  readonly tenantId: string;
  readonly issuedAt: Date;
  readonly boundary: TenantBoundaryFacts;
  readonly definitionsDigest: string;
  readonly instructionsRelease: string;
}): AttestationPayload {
  return {
    tenant_id: input.tenantId,
    issued_at: input.issuedAt.toISOString(),
    project: {
      id: input.boundary.projectId,
      id_source: input.boundary.projectIdSource,
      endpoint_host: input.boundary.endpointHost,
    },
    database: { name: input.boundary.databaseName },
    storage: {
      prefix: input.boundary.storagePrefix,
      prefix_source: input.boundary.storagePrefixSource,
    },
    boundaries: {
      database: 'structural',
      storage: 'structural_conditional_on_prefix_derivation',
    },
    definitions_digest: input.definitionsDigest,
    instructions_release: input.instructionsRelease,
  };
}

/** Sign it, or say plainly that nothing did. */
export async function sealAttestation(
  payload: AttestationPayload,
  signer: AttestationSigner | undefined,
): Promise<SignedAttestation> {
  if (signer === undefined) {
    return {
      ...payload,
      signature: {
        status: 'unsigned',
        reason:
          'this fleet is wired to no attestation signer, so this receipt is a claim rather than a proof',
      },
    };
  }

  try {
    return { ...payload, signature: await signer.sign(payload) };
  } catch {
    // A signer having a bad day must not fail a read. It must also not produce
    // a receipt that looks signed, which is why the fallback is the same named
    // absence rather than a locally computed value.
    return {
      ...payload,
      signature: {
        status: 'unsigned',
        reason: 'the attestation signer could not be reached for this response',
      },
    };
  }
}

export function isSigned(seal: AttestationSeal): seal is AttestationSignature {
  return !('status' in seal);
}

/**
 * Verify a whole receipt — the half an outside party runs.
 *
 * Takes the signer-shaped verifier rather than raw key bytes, because the
 * shipped implementation is symmetric and a raw-key API would invite a caller to
 * pass the signing key around as if it were public. It **splits the payload out
 * of the receipt** rather than trusting the caller to have kept them together,
 * so a receipt whose body was edited after signing verifies against the edited
 * body and fails.
 */
export async function verifyAttestation(
  receipt: SignedAttestation,
  verifier: Pick<AttestationSigner, 'verify'>,
): Promise<boolean> {
  const { signature, ...payload } = receipt;
  if (!isSigned(signature)) return false;
  return verifier.verify(payload as AttestationPayload, signature);
}

/**
 * The two facts a connection string provably carries, with the secret dropped.
 *
 * Userinfo is discarded before anything is read, and the returned object has no
 * field that could hold it — so this is the seam where a DSN stops being key
 * material and becomes a boundary fact. A DSN that will not parse yields
 * `unknown` values rather than throwing: a malformed connection string is an
 * operational problem, and turning it into a failed read would make an
 * attestation field able to break a tool call.
 */
export function boundaryFromConnectionString(dsn: string): {
  readonly endpointHost: string;
  readonly databaseName: string;
} {
  try {
    const url = new URL(dsn);
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return {
      endpointHost: url.hostname.length > 0 ? url.hostname : 'unknown',
      databaseName: name.length > 0 ? name : 'unknown',
    };
  } catch {
    return { endpointHost: 'unknown', databaseName: 'unknown' };
  }
}
