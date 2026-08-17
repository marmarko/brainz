/**
 * The sealed envelope — what a tenant's credentials look like at rest.
 *
 * **Why anything is sealed at all.** The durable secret store
 * (`src/control/secret-pg.ts`) puts every tenant's connection string and bearer
 * grant in the control-plane database, which is the one database this system
 * says is *content-free*. A plaintext DSN there would make a control-plane dump
 * — a vendor snapshot, a leaked `BRAINZ_CONTROL_DATABASE_URL`, a backup in
 * somebody's object storage — equal to every tenant's brain. The rule that
 * survives is therefore not "the control plane holds no words" but the thing
 * that rule was buying: **the control plane holds nothing a reader of the
 * control plane can use.**
 *
 * **What the seal buys, exactly.** The key lives in the fleets' environment and
 * is never written to the database, so the two halves leak through different
 * channels: a DSN reaches backups, logs, vendor consoles and support tooling; an
 * environment reaches a process compromise. One without the other is inert.
 *
 * **What it does not buy, said plainly.** Every fleet process holds both — the
 * key and the database URL — so a compromise of a running container is a
 * compromise of every tenant's credentials, sealed or not. That was already true
 * of `BRAINZ_SECRETS_JSON`, which put the same plaintext in the same processes'
 * environment; this is strictly better and is not a boundary.
 *
 * **The shape is load-bearing, not cosmetic.**
 *
 *     v1.<nonce, 12 bytes base64url>.<ciphertext‖tag, base64url>
 *
 * `src/control/secret-store.sql` types the column with a domain whose anchored
 * alphabet admits exactly that and nothing else — no `:`, no `@`, no `/`, no
 * space — so the column is *incapable* of holding a connection string, a bare
 * bearer or a sentence. The control plane's content-free guard checks that
 * mechanically (`test/control/schema.test.ts`), which is how the old invariant
 * gets expressed in the new world rather than deleted for being inconvenient.
 *
 * **The namespace is the additional authenticated data.** Sealing binds a
 * ciphertext to the key it is stored under, so a row lifted from one tenant and
 * pasted over another's fails to open instead of handing tenant B tenant A's
 * database. AES-GCM authenticates the AAD without storing it, so the binding
 * costs nothing on the wire.
 */

import { Buffer } from 'node:buffer';

/** The only version this module writes, and the only one it reads. */
export const SEALED_ENVELOPE_VERSION = 'v1';

/** AES-256-GCM. 32 bytes, and no other length is accepted. */
export const SEALING_KEY_BYTES = 32;

/** 96 bits, the size AES-GCM is specified around. */
const NONCE_BYTES = 12;

const TAG_BITS = 128;

/**
 * Why an envelope could not be opened.
 *
 * - `malformed` — it is not an envelope this module wrote (wrong version, wrong
 *   shape, un-decodable base64url).
 * - `unopenable` — it is shaped right and the key or the namespace is wrong, or
 *   the bytes were altered. GCM cannot tell those apart and neither can this.
 *
 * Both are thrown, never returned as an empty read. `secrets.ts` is explicit
 * that a backend failure must not be flattened into `not_found`: "the store is
 * down" and "this tenant does not exist" are different sentences, and a fleet
 * booted with the wrong key must look like a broken fleet rather than like a
 * database that lost every tenant.
 */
export type SealedFailureReason = 'malformed' | 'unopenable';

export class SealedEnvelopeError extends Error {
  readonly reason: SealedFailureReason;
  /** The namespace, which is a reference and safe to log. Never the payload. */
  readonly namespace: string;

  constructor(reason: SealedFailureReason, namespace: string, detail: string) {
    super(`sealed envelope for ${JSON.stringify(namespace)} is ${reason}: ${detail}`);
    this.name = 'SealedEnvelopeError';
    this.reason = reason;
    this.namespace = namespace;
  }
}

export class SealingKeyError extends Error {
  constructor(detail: string) {
    super(`the sealing key ${detail}`);
    this.name = 'SealingKeyError';
  }
}

/**
 * Turn the configured string into a key.
 *
 * Base64 or base64url, padded or not, decoding to exactly 32 bytes. Anything
 * else is a refusal rather than a hash-into-shape: deriving a key from whatever
 * an operator typed would make a truncated paste into a *different working key*,
 * and every tenant sealed under the old one unreadable with no error to read.
 */
export async function importSealingKey(configured: string): Promise<CryptoKey> {
  const trimmed = configured.trim();
  if (trimmed.length === 0) throw new SealingKeyError('is empty');

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = decode(trimmed);
  } catch {
    throw new SealingKeyError('is not base64url');
  }
  // Node's base64 decoder ignores trailing junk rather than failing, so the
  // length check is what actually rejects a mistyped key.
  if (raw.length !== SEALING_KEY_BYTES) {
    throw new SealingKeyError(
      `must decode to ${SEALING_KEY_BYTES} bytes, not ${raw.length} — generate one with \`openssl rand -base64 32\``,
    );
  }

  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** A fresh key, for tests and for an operator who wants one printed. */
export function generateSealingKeyMaterial(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(SEALING_KEY_BYTES))).toString(
    'base64url',
  );
}

/**
 * Seal a plaintext under a namespace.
 *
 * A fresh random nonce per call, which is what makes reusing one key across
 * every tenant safe, and what makes two seals of the same DSN produce different
 * rows — so the table leaks no equality either.
 */
export async function seal(key: CryptoKey, namespace: string, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadOf(namespace), tagLength: TAG_BITS },
    key,
    new TextEncoder().encode(plaintext),
  );

  return [
    SEALED_ENVELOPE_VERSION,
    Buffer.from(nonce).toString('base64url'),
    Buffer.from(sealed).toString('base64url'),
  ].join('.');
}

/** Open an envelope sealed under this key and this namespace, or throw. */
export async function unseal(
  key: CryptoKey,
  namespace: string,
  envelope: string,
): Promise<string> {
  const parts = envelope.split('.');
  if (parts.length !== 3) {
    throw new SealedEnvelopeError('malformed', namespace, `it has ${parts.length} segments, not 3`);
  }
  const [version, nonce64, sealed64] = parts as [string, string, string];
  if (version !== SEALED_ENVELOPE_VERSION) {
    throw new SealedEnvelopeError('malformed', namespace, `version ${JSON.stringify(version)}`);
  }

  const nonce = decode(nonce64);
  if (nonce.length !== NONCE_BYTES) {
    throw new SealedEnvelopeError('malformed', namespace, `nonce is ${nonce.length} bytes`);
  }
  const sealed = decode(sealed64);

  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aadOf(namespace), tagLength: TAG_BITS },
      key,
      sealed,
    );
  } catch {
    // Deliberately no detail from the failure: GCM's refusal says only that the
    // key, the namespace or the bytes are wrong, and inventing a distinction
    // here would be a guess an operator then debugs.
    throw new SealedEnvelopeError(
      'unopenable',
      namespace,
      'the key, the namespace binding or the bytes are wrong',
    );
  }

  return new TextDecoder().decode(opened);
}

/**
 * The namespace as authenticated data.
 *
 * The copies below are not ceremony: WebCrypto's typings demand a view over a
 * plain `ArrayBuffer`, and `Buffer` and `TextEncoder` both hand back views whose
 * buffer could be shared. Copying once per call is cheaper than the alternative,
 * which is a cast that silently accepts a shared buffer someone else can mutate
 * between the length check and the decrypt.
 */
function aadOf(namespace: string): Uint8Array<ArrayBuffer> {
  return copy(new TextEncoder().encode(namespace));
}

function decode(base64url: string): Uint8Array<ArrayBuffer> {
  return copy(Buffer.from(base64url, 'base64url'));
}

function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}
