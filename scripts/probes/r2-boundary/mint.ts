/**
 * The two ways R2 mints prefix-scoped temporary credentials.
 *
 * R2 documents both, and the difference is the whole reason the mint-rate
 * question is worth measuring rather than assuming:
 *
 *   1. **API mint** — `POST /accounts/{id}/r2/temp-access-credentials`. One
 *      network round trip per tenant, and it spends from the account-wide R2
 *      REST budget (1,200 requests / 5 minutes, shared with bucket management).
 *      If brainz mints on the request path, that budget is the ceiling.
 *
 *   2. **Local mint** — sign an HS256 JWT with the parent secret access key.
 *      No network call, no shared budget, no rate limit: pure local crypto.
 *      Session token is `base64("jwt/" + jwt)` and the temporary secret access
 *      key is the SHA-256 hex digest of that JWT.
 *
 * If (2) verifies, the "do credentials mint at request rate?" question is
 * settled decisively — the answer stops depending on a vendor quota at all.
 * That is why the probe tests both and reports them separately.
 *
 * Caveat carried into the report: the local claim set below is transcribed from
 * Cloudflare's published example. If Cloudflare changes or under-documents a
 * claim, local minting fails *authentication*, which is indistinguishable from
 * "the feature does not work". The probe therefore never reports a local-mint
 * failure as `FAIL` — only as `INCONCLUSIVE`, with the raw error.
 *
 * Source: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
 *         https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/
 */

import { sha256Hex, toBufferSource, type S3Credentials } from "./sigv4.ts";

const encoder = new TextEncoder();

/** The four scope values R2 accepts, for both the API and the local JWT. */
export const R2_PERMISSIONS = [
  "admin-read-write",
  "admin-read-only",
  "object-read-write",
  "object-read-only",
] as const;
export type R2Permission = (typeof R2_PERMISSIONS)[number];

export interface LocalMintOptions {
  accountId: string;
  parentAccessKeyId: string;
  parentSecretAccessKey: string;
  /** S3 endpoint host; becomes the JWT audience. */
  endpointHost: string;
  bucket: string;
  scope: R2Permission;
  ttlSeconds: number;
  prefixPaths?: string[] | undefined;
  objectPaths?: string[] | undefined;
  /** Injectable clock so `iat`/`exp` are testable. */
  now?: Date | undefined;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBufferSource(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, toBufferSource(encoder.encode(message))),
  );
}

export interface LocalMintResult {
  credentials: S3Credentials;
  /** Echoed so the report can show exactly what was signed if it is rejected. */
  claims: Record<string, unknown>;
  jwtLength: number;
}

/**
 * Mint a prefix-scoped credential locally. No network call.
 */
export async function mintLocally(options: LocalMintOptions): Promise<LocalMintResult> {
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);

  const claims: Record<string, unknown> = {
    bucket: options.bucket,
    scope: options.scope,
    sub: options.accountId,
    iss: options.parentAccessKeyId,
    aud: options.endpointHost,
    iat: issuedAt,
    exp: issuedAt + options.ttlSeconds,
  };
  if (options.prefixPaths !== undefined || options.objectPaths !== undefined) {
    claims["paths"] = {
      prefixPaths: options.prefixPaths ?? [],
      objectPaths: options.objectPaths ?? [],
    };
  }

  const header = base64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = base64Url(
    await hmacSha256(encoder.encode(options.parentSecretAccessKey), signingInput),
  );
  const jwt = `${signingInput}.${signature}`;

  return {
    credentials: {
      accessKeyId: options.parentAccessKeyId,
      secretAccessKey: await sha256Hex(jwt),
      sessionToken: btoa(`jwt/${jwt}`),
    },
    claims,
    jwtLength: jwt.length,
  };
}
