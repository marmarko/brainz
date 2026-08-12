/**
 * Minimal AWS SigV4 signing for R2's S3-compatible API.
 *
 * Written by hand rather than pulled from a dependency for one reason that
 * matters to this probe specifically: a signing bug and a working access
 * control produce the *same* observation — "the request was denied". The probe
 * exists to tell those two apart, so the signing code has to be readable by
 * whoever is reading the result, not a black box behind a version range. It is
 * also the smaller half of the argument: the probe adds no dependencies at all
 * (see the README's constraints section).
 *
 * The countermeasure for a signing bug is not in this file — it is the
 * positive control in `probe.ts`: a scoped credential must succeed on its OWN
 * prefix before any denial elsewhere is allowed to count as evidence.
 *
 * Scope: SigV4 over HTTPS with the payload hashed in full (no streaming/chunked
 * signing, no presigned URLs). That covers every call this probe makes.
 */

const encoder = new TextEncoder();

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present on temporary credentials; sent as `x-amz-security-token`. */
  sessionToken?: string | undefined;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Copy bytes into a freshly allocated, definitely-not-shared ArrayBuffer.
 *
 * WebCrypto's `BufferSource` excludes `SharedArrayBuffer`-backed views, and a
 * plain `Uint8Array` annotation widens to `Uint8Array<ArrayBufferLike>`, which
 * does not satisfy it. Whether that surfaces as a compile error depends on
 * which lib files the surrounding compilation happens to pull in — so this
 * normalises at the one boundary that cares, rather than leaving the probe's
 * crypto typing hostage to what else is in the program.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = toBufferSource(typeof data === "string" ? encoder.encode(data) : data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
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

/**
 * RFC 3986 encoding, which is stricter than `encodeURIComponent`.
 *
 * This is the single most common place hand-rolled SigV4 breaks, and it breaks
 * *silently* — the request is simply denied, which this probe would otherwise
 * be tempted to read as "the scope held". Every path segment and every query
 * key/value goes through here; `/` is never left raw inside a segment.
 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface SignS3RequestOptions {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  /** Virtual host, e.g. `<account>.r2.cloudflarestorage.com`. */
  host: string;
  /** Unencoded path segments, e.g. `["my-bucket", "tenant-a", "note.txt"]`. */
  segments: string[];
  query?: Record<string, string> | undefined;
  body?: Uint8Array | undefined;
  credentials: S3Credentials;
  region?: string | undefined;
  service?: string | undefined;
  /** Injectable clock, so the canonical request is testable. */
  now?: Date | undefined;
}

export interface SignedS3Request {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  /** Kept for diagnostics: if a signature is rejected, this is what to read. */
  canonicalRequest: string;
  /** The path that was signed. */
  canonicalUri: string;
  /**
   * The path an HTTP client will actually PUT ON THE WIRE for `url`.
   *
   * WHATWG URL parsing resolves `.` and `..` segments — and decodes `%2e` first,
   * so `%2e%2e` collapses too. A key shaped like `tenant-a/../tenant-b/x` is
   * therefore rewritten to `tenant-b/x` *before* it leaves the process, which
   * would (a) break the signature and (b) look like a denial. The caller
   * compares this against `canonicalUri` and refuses to send a request it cannot
   * deliver as intended, rather than scoring the resulting 403 as a scope
   * denial. See `docs` note in README: "traversal-shaped keys".
   */
  deliveredPath: string;
}

export async function signS3Request(options: SignS3RequestOptions): Promise<SignedS3Request> {
  const region = options.region ?? "auto";
  const service = options.service ?? "s3";
  const now = options.now ?? new Date();

  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(options.body ?? new Uint8Array(0));

  const headers: Record<string, string> = {
    host: options.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (options.credentials.sessionToken) {
    headers["x-amz-security-token"] = options.credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${(headers[name] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalUri = `/${options.segments.map(rfc3986).join("/")}`;
  const canonicalQuery = Object.entries(options.query ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join("&");

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey: Uint8Array = encoder.encode(`AWS4${options.credentials.secretAccessKey}`);
  for (const part of [dateStamp, region, service, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = toHex(await hmac(signingKey, stringToSign));

  const outHeaders: Record<string, string> = { ...headers };
  // `fetch` sets Host itself and forbids overriding it; it stays in the
  // canonical request but must not be handed to fetch.
  delete outHeaders["host"];
  outHeaders["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${options.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;

  return {
    url,
    headers: outHeaders,
    body: options.body,
    canonicalRequest,
    canonicalUri,
    deliveredPath: new URL(url).pathname,
  };
}
