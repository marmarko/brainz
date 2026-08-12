/**
 * Two R2 surfaces, one client: the Cloudflare REST API (bucket management,
 * temporary-credential minting) and the S3-compatible API (objects, and — the
 * thing worth measuring — bucket creation by a second path that may not spend
 * the same budget).
 *
 * Every call returns a discriminated result carrying the raw status, the
 * vendor's own error code and the vendor's own message. Nothing in this file
 * ever collapses an error into a boolean, because the probe's job is to say
 * *which* failure happened. In particular `classifyFailure` separates:
 *
 *   rate_limited — a throughput answer, never a viability answer
 *   auth         — the probe's own credential is wrong; proves nothing
 *   quota        — the account ceiling, the one answer the quota leg is after
 *
 * Mistaking any of those three for another is exactly the false-fail that
 * would trigger an expensive architectural no-branch that was never needed, so
 * the raw code and message ride along in every result for adjudication by a
 * human who can outvote the regexes.
 */

import { signS3Request, type S3Credentials } from "./sigv4.ts";
import type { R2Permission } from "./mint.ts";

export type FailureKind =
  | "rate_limited"
  | "auth"
  | "quota"
  | "conflict"
  | "not_found"
  | "network"
  | "other";

export interface CallSuccess<T> {
  ok: true;
  status: number;
  value: T;
  ms: number;
}

export interface CallFailure {
  ok: false;
  status: number;
  kind: FailureKind;
  /** Vendor error code: numeric for the REST API, string for S3 XML. */
  code: string | null;
  message: string;
  retryAfterSeconds: number | null;
  ms: number;
  /** First 600 chars of the raw body — the audit trail behind `kind`. */
  raw: string;
}

export type Call<T> = CallSuccess<T> | CallFailure;

const RATE_LIMIT_PATTERN = /rate limit|too many requests|slow ?down|throttl/i;
const AUTH_PATTERN =
  /unauthor|not authorized|authentication|invalid (api )?token|permission|access denied|forbidden|signature/i;
const QUOTA_PATTERN =
  /quota|maximum number|max number|bucket limit|limit (has been )?(reached|exceeded)|exceeded .*limit|too many buckets/i;
const CONFLICT_PATTERN = /already (exists|owned)|bucket.*exists/i;

export function classifyFailure(status: number, code: string | null, message: string): FailureKind {
  const haystack = `${code ?? ""} ${message}`;
  // Order is load-bearing. A 429 is a throughput observation and must never be
  // read as a quota ceiling, and a quota message must never be read as auth
  // just because it says "not allowed".
  if (status === 429 || RATE_LIMIT_PATTERN.test(haystack)) return "rate_limited";
  if (QUOTA_PATTERN.test(haystack)) return "quota";
  if (CONFLICT_PATTERN.test(haystack) || status === 409) return "conflict";
  if (status === 401 || status === 403 || AUTH_PATTERN.test(haystack)) return "auth";
  if (status === 404) return "not_found";
  return "other";
}

export interface R2Env {
  accountId: string;
  apiToken: string;
  parentAccessKeyId: string;
  parentSecretAccessKey: string;
  jurisdiction: string | null;
  s3Host: string;
  apiBase: string;
  bucketPrefix: string;
}

export const REQUIRED_ENV = [
  "R2_ACCOUNT_ID",
  "R2_API_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

/** The prefix every probe-created bucket must carry. Also the deletion guard. */
export const MANDATORY_BUCKET_PREFIX = "brainz-probe-";

export interface EnvLoad {
  env: R2Env | null;
  missing: string[];
  errors: string[];
}

export function loadEnv(source: Record<string, string | undefined> = process.env): EnvLoad {
  const missing = REQUIRED_ENV.filter((name) => !source[name]);
  const errors: string[] = [];

  const bucketPrefix = source["R2_PROBE_BUCKET_PREFIX"] ?? MANDATORY_BUCKET_PREFIX;
  if (!bucketPrefix.startsWith(MANDATORY_BUCKET_PREFIX)) {
    errors.push(
      `R2_PROBE_BUCKET_PREFIX must start with "${MANDATORY_BUCKET_PREFIX}" — it is the ` +
        `guard that stops --cleanup-only from deleting a bucket this probe did not create.`,
    );
  }
  if (!/^[a-z0-9-]+$/.test(bucketPrefix)) {
    errors.push("R2_PROBE_BUCKET_PREFIX must be lowercase letters, digits and hyphens only.");
  }

  if (missing.length > 0 || errors.length > 0) return { env: null, missing, errors };

  const accountId = source["R2_ACCOUNT_ID"] ?? "";
  const jurisdiction = source["R2_JURISDICTION"] ?? null;
  const defaultHost = jurisdiction
    ? `${accountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `${accountId}.r2.cloudflarestorage.com`;

  return {
    env: {
      accountId,
      apiToken: source["R2_API_TOKEN"] ?? "",
      parentAccessKeyId: source["R2_ACCESS_KEY_ID"] ?? "",
      parentSecretAccessKey: source["R2_SECRET_ACCESS_KEY"] ?? "",
      jurisdiction,
      s3Host: source["R2_S3_ENDPOINT"] ?? defaultHost,
      apiBase: source["R2_API_BASE"] ?? "https://api.cloudflare.com/client/v4",
      bucketPrefix,
    },
    missing: [],
    errors: [],
  };
}

export interface MintRequest {
  bucket: string;
  permission: R2Permission;
  ttlSeconds: number;
  prefixes?: string[] | undefined;
  objects?: string[] | undefined;
}

function truncate(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

function parseXmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Counts calls per surface. The account-wide R2 REST budget is 1,200 requests
 * per five minutes, so a probe that spends it silently would corrupt its own
 * later measurements — and the user's production traffic with them.
 */
export interface CallCounters {
  rest: number;
  s3: number;
}

export class R2Client {
  readonly env: R2Env;
  readonly counters: CallCounters = { rest: 0, s3: 0 };

  constructor(env: R2Env) {
    this.env = env;
  }

  parentCredentials(): S3Credentials {
    return {
      accessKeyId: this.env.parentAccessKeyId,
      secretAccessKey: this.env.parentSecretAccessKey,
    };
  }

  private async rest(method: string, path: string, body?: unknown): Promise<Call<unknown>> {
    this.counters.rest += 1;
    const started = performance.now();
    const headers: Record<string, string> = { authorization: `Bearer ${this.env.apiToken}` };
    if (this.env.jurisdiction) headers["cf-r2-jurisdiction"] = this.env.jurisdiction;

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.env.apiBase}${path}`, init);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        kind: "network",
        code: null,
        message: String(error),
        retryAfterSeconds: null,
        ms: performance.now() - started,
        raw: String(error),
      };
    }

    const text = await response.text();
    const ms = performance.now() - started;

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }

    const envelope = isRecord(parsed) ? parsed : {};
    const succeeded = response.ok && envelope["success"] !== false;
    if (succeeded) {
      return { ok: true, status: response.status, value: envelope["result"] ?? null, ms };
    }

    const errors = Array.isArray(envelope["errors"]) ? envelope["errors"] : [];
    const first = errors.length > 0 && isRecord(errors[0]) ? errors[0] : null;
    const code = first && first["code"] !== undefined ? String(first["code"]) : null;
    const message = first && first["message"] !== undefined ? String(first["message"]) : text || response.statusText;

    return {
      ok: false,
      status: response.status,
      kind: classifyFailure(response.status, code, message),
      code,
      message,
      retryAfterSeconds: parseRetryAfter(response),
      ms,
      raw: truncate(text),
    };
  }

  // ---------------------------------------------------------------- REST API

  /** One page of `GET /accounts/{id}/r2/buckets`. */
  async listBucketsPage(
    cursor: string | null,
    perPage: number,
  ): Promise<Call<{ names: string[]; cursor: string | null }>> {
    const params = new URLSearchParams({ per_page: String(perPage) });
    if (cursor) params.set("cursor", cursor);
    const result = await this.rest("GET", `/accounts/${this.env.accountId}/r2/buckets?${params}`);
    if (!result.ok) return result;

    const payload = isRecord(result.value) ? result.value : {};
    const rawBuckets = Array.isArray(payload["buckets"]) ? payload["buckets"] : [];
    const names = rawBuckets
      .map((entry) => (isRecord(entry) && typeof entry["name"] === "string" ? entry["name"] : null))
      .filter((name): name is string => name !== null);

    // `result_info.cursor` is where the continuation token lives; an empty
    // string means "no more pages".
    const info = isRecord(payload["result_info"]) ? payload["result_info"] : {};
    const nextCursor = typeof info["cursor"] === "string" && info["cursor"] !== "" ? info["cursor"] : null;

    return { ok: true, status: result.status, ms: result.ms, value: { names, cursor: nextCursor } };
  }

  async createBucketRest(name: string): Promise<Call<null>> {
    const result = await this.rest("POST", `/accounts/${this.env.accountId}/r2/buckets`, { name });
    return result.ok ? { ok: true, status: result.status, ms: result.ms, value: null } : result;
  }

  async deleteBucketRest(name: string): Promise<Call<null>> {
    const result = await this.rest("DELETE", `/accounts/${this.env.accountId}/r2/buckets/${name}`);
    return result.ok ? { ok: true, status: result.status, ms: result.ms, value: null } : result;
  }

  /** `POST /accounts/{id}/r2/temp-access-credentials`. */
  async mintTempCredentials(request: MintRequest): Promise<Call<S3Credentials>> {
    const body: Record<string, unknown> = {
      bucket: request.bucket,
      parentAccessKeyId: this.env.parentAccessKeyId,
      permission: request.permission,
      ttlSeconds: request.ttlSeconds,
    };
    if (request.prefixes !== undefined) body["prefixes"] = request.prefixes;
    if (request.objects !== undefined) body["objects"] = request.objects;

    const result = await this.rest(
      "POST",
      `/accounts/${this.env.accountId}/r2/temp-access-credentials`,
      body,
    );
    if (!result.ok) return result;

    const payload = isRecord(result.value) ? result.value : {};
    const accessKeyId = payload["accessKeyId"];
    const secretAccessKey = payload["secretAccessKey"];
    const sessionToken = payload["sessionToken"];
    if (
      typeof accessKeyId !== "string" ||
      typeof secretAccessKey !== "string" ||
      typeof sessionToken !== "string"
    ) {
      return {
        ok: false,
        status: result.status,
        kind: "other",
        code: "unexpected_response_shape",
        message:
          "Mint returned 200 but the result did not carry accessKeyId/secretAccessKey/sessionToken. " +
          "The API shape may have changed — check the raw body against the docs.",
        retryAfterSeconds: null,
        ms: result.ms,
        raw: truncate(JSON.stringify(result.value)),
      };
    }

    return {
      ok: true,
      status: result.status,
      ms: result.ms,
      value: { accessKeyId, secretAccessKey, sessionToken },
    };
  }

  // ------------------------------------------------------------------ S3 API

  private async s3(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    credentials: S3Credentials,
    segments: string[],
    options: { query?: Record<string, string> | undefined; body?: Uint8Array | undefined } = {},
  ): Promise<Call<string>> {
    this.counters.s3 += 1;
    const started = performance.now();

    const signed = await signS3Request({
      method,
      host: this.env.s3Host,
      segments,
      query: options.query,
      body: options.body,
      credentials,
    });

    const init: RequestInit = { method, headers: signed.headers };
    if (signed.body !== undefined) init.body = signed.body;

    let response: Response;
    try {
      response = await fetch(signed.url, init);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        kind: "network",
        code: null,
        message: String(error),
        retryAfterSeconds: null,
        ms: performance.now() - started,
        raw: String(error),
      };
    }

    const text = await response.text();
    const ms = performance.now() - started;
    if (response.ok) return { ok: true, status: response.status, ms, value: text };

    const code = parseXmlTag(text, "Code");
    const message = parseXmlTag(text, "Message") ?? response.statusText;
    return {
      ok: false,
      status: response.status,
      kind: classifyFailure(response.status, code, message),
      code,
      message,
      retryAfterSeconds: parseRetryAfter(response),
      ms,
      raw: truncate(text),
    };
  }

  async createBucketS3(credentials: S3Credentials, bucket: string): Promise<Call<string>> {
    return this.s3("PUT", credentials, [bucket]);
  }

  async deleteBucketS3(credentials: S3Credentials, bucket: string): Promise<Call<string>> {
    return this.s3("DELETE", credentials, [bucket]);
  }

  async putObject(
    credentials: S3Credentials,
    bucket: string,
    key: string,
    body: string,
  ): Promise<Call<string>> {
    return this.s3("PUT", credentials, [bucket, ...key.split("/")], {
      body: new TextEncoder().encode(body),
    });
  }

  async getObject(credentials: S3Credentials, bucket: string, key: string): Promise<Call<string>> {
    return this.s3("GET", credentials, [bucket, ...key.split("/")]);
  }

  async deleteObject(
    credentials: S3Credentials,
    bucket: string,
    key: string,
  ): Promise<Call<string>> {
    return this.s3("DELETE", credentials, [bucket, ...key.split("/")]);
  }

  /** ListObjectsV2. Returns the keys visible to `credentials`. */
  async listObjects(
    credentials: S3Credentials,
    bucket: string,
    prefix: string | null,
  ): Promise<Call<string[]>> {
    const query: Record<string, string> = { "list-type": "2" };
    if (prefix !== null) query["prefix"] = prefix;
    const result = await this.s3("GET", credentials, [bucket], { query });
    if (!result.ok) return result;

    const keys = [...result.value.matchAll(/<Key>([^<]*)<\/Key>/g)]
      .map((match) => match[1])
      .filter((key): key is string => key !== undefined);
    return { ok: true, status: result.status, ms: result.ms, value: keys };
  }
}
