/**
 * SCRAM-SHA-256 (RFC 5802 / RFC 7677) client, enough of it to authenticate
 * against Neon over the Postgres v3 wire protocol.
 *
 * WHY THIS IS HAND-ROLLED
 * -----------------------
 * The probe deliberately carries no driver dependency, so that ONE
 * implementation of the Postgres protocol runs over BOTH transports under test.
 * That is not an aesthetic choice: if a driver were used for raw TCP and a
 * different driver for the WebSocket path, a difference in outcome could be a
 * difference between the drivers rather than between the transports, and the
 * whole point of this probe is to attribute the difference to the transport.
 *
 * WHY THE SERVER SIGNATURE IS VERIFIED
 * ------------------------------------
 * SCRAM is mutual. Verifying the server's final signature proves the far end
 * knows the stored key for this role — i.e. it is really the Neon Postgres and
 * not a transparent proxy, a captive portal, or an interception layer that
 * accepted the socket. A probe that only proves "bytes went somewhere" is
 * exactly the false pass this file exists to prevent.
 *
 * WHERE THIS RUNS — AND WHERE IT DOES NOT
 * ---------------------------------------
 * This file is the raw TCP arm only. Neon's Postgres offers SCRAM-SHA-256 on
 * 5432, so that transport requires it and refuses anything weaker. Neon's
 * WebSocket wire proxy on 443 offers no SASL at all — it terminates TLS itself
 * and then asks for `AuthenticationCleartextPassword` — so nothing here executes
 * on that leg, and the probe's peer-verification claim is scoped per transport
 * rather than asserted across both. See `PeerVerificationReason` in report.ts.
 *
 * CHANNEL BINDING IS DELIBERATELY NOT USED
 * ----------------------------------------
 * Neon offers SCRAM-SHA-256-PLUS, and some Neon connection strings carry
 * `channel_binding=require` — a *client-side* preference, not a server
 * requirement, so plain SCRAM-SHA-256 is accepted. Binding would tie the
 * exchange to the raw TCP arm's own TLS channel, which the WebSocket arm does
 * not have at the Postgres layer; keeping it plain leaves the two arms
 * comparable above the transport, which is the comparison this probe makes.
 *
 * SASLprep is not applied. Passwords Neon generates are ASCII, for which
 * SASLprep is the identity function. A non-ASCII password would need it.
 *
 * Everything below is `Uint8Array`, never `Buffer`, and base64 goes through
 * `btoa`/`atob`. This repo also carries Cloudflare's generated worker types,
 * under which `Buffer.toString(encoding)` does not typecheck; staying on the
 * common subset avoids depending on which global wins.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const SHA256 = 'sha256';
const KEY_LEN = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hmac(key: Uint8Array, data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHmac(SHA256, key).update(data).digest());
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash(SHA256).update(data).digest());
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    // Both are KEY_LEN and bounded by the loop; `?? 0` satisfies
    // noUncheckedIndexedAccess without a cast.
    out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return out;
}

/** `n,,` base64-encoded — the GS2 header echoed in the client-final message. */
const GS2_HEADER_B64 = 'biws';

export interface ScramExchange {
  /** The `SASLInitialResponse` payload body (without the mechanism name). */
  clientFirst: string;
  /** Consume the server-first message and produce the client-final message. */
  clientFinal(serverFirst: string): { message: string; expectedServerSignature: string };
}

export class ScramError extends Error {}

export function startScram(password: string): ScramExchange {
  const clientNonce = toBase64(new Uint8Array(randomBytes(24)));
  // `n=` is empty on purpose: Postgres takes the role name from the startup
  // message, and RFC 5802 says the SCRAM username is then ignored.
  const clientFirstBare = `n=,r=${clientNonce}`;
  const clientFirst = `n,,${clientFirstBare}`;

  return {
    clientFirst,
    clientFinal(serverFirst: string) {
      const attrs = parseAttributes(serverFirst);
      const serverNonce = attrs.get('r');
      const saltB64 = attrs.get('s');
      const iterations = attrs.get('i');
      if (serverNonce === undefined || saltB64 === undefined || iterations === undefined) {
        throw new ScramError('server-first-message missing r=, s= or i=');
      }
      if (!serverNonce.startsWith(clientNonce)) {
        // A server that does not echo our nonce prefix is not running the
        // exchange we started — a replay, or a man in the middle.
        throw new ScramError('server nonce does not extend the client nonce');
      }

      const salt = fromBase64(saltB64);
      const iters = Number.parseInt(iterations, 10);
      if (!Number.isInteger(iters) || iters < 1 || iters > 1_000_000) {
        throw new ScramError(`implausible SCRAM iteration count: ${iterations}`);
      }

      const saltedPassword = new Uint8Array(pbkdf2Sync(password, salt, iters, KEY_LEN, SHA256));
      const clientKey = hmac(saltedPassword, 'Client Key');
      const storedKey = sha256(clientKey);
      const clientFinalWithoutProof = `c=${GS2_HEADER_B64},r=${serverNonce}`;
      const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
      const clientSignature = hmac(storedKey, authMessage);
      const clientProof = xor(clientKey, clientSignature);
      const serverKey = hmac(saltedPassword, 'Server Key');
      const serverSignature = hmac(serverKey, authMessage);

      return {
        message: `${clientFinalWithoutProof},p=${toBase64(clientProof)}`,
        expectedServerSignature: toBase64(serverSignature),
      };
    },
  };
}

/** Verify the `v=` attribute of the server-final message. */
export function verifyServerSignature(serverFinal: string, expected: string): boolean {
  const got = parseAttributes(serverFinal).get('v');
  return got !== undefined && got === expected;
}

function parseAttributes(message: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of message.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}
