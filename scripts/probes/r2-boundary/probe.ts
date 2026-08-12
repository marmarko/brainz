#!/usr/bin/env bun
/**
 * `bun run probe:r2` — the R2 storage-boundary probe (R9, R10; Gap Register #15).
 *
 * WHAT THIS SETTLES
 * -----------------
 * R9 downgraded file storage to "prefix-enforced by convention" on the premise
 * that "R2's per-account bucket ceiling rules out bucket-per-user at target
 * scale". That premise is false — R2 documents 1,000,000 buckets per account
 * against a 30,000-tenant target. Gap Register #15 records the correction and
 * leaves two structural options live, to be decided in Phase 0:
 *
 *   A. bucket-per-tenant, or
 *   B. short-TTL, prefix-scoped R2 temporary credentials minted per tenant.
 *
 * Either one makes the R2 boundary structural, removes the fleet-wide object
 * credential from R10's blast radius, and lets U16's attestation report R2 as
 * enforced rather than conventional. What is genuinely unverified is the
 * OPERATIONAL envelope, so this probe measures it:
 *
 *   inventory  How many buckets does this account already hold? (headroom base)
 *   latency    Bucket-create latency, and create-to-first-usable-write — the
 *              number U15's warm pool is sized by.
 *   ratelimit  The bucket-management throughput actually enforced, measured
 *              rather than assumed, on BOTH create paths (REST and S3).
 *   ramp       Opt-in: create until a ceiling appears, or prove it is above N.
 *   tempcreds  Do prefix-scoped credentials mint at request rate, and — the
 *              part that actually matters — does the SCOPE HOLD? A credential
 *              that mints but does not fence is the failure mode that would
 *              matter, so tenant-a's credential is pointed at tenant-b's data
 *              and required to be denied.
 *
 * WHAT IT CANNOT SETTLE (stated here so the result is never over-read)
 * -------------------------------------------------------------------
 * The account's bucket quota is NOT discoverable through any R2 API. Creating
 * buckets successfully proves headroom only up to the number created — three
 * buckets on a fresh account proves nothing about thirty thousand. So the quota
 * verdict defaults to NOT_OBSERVED, with the escalation path printed, and only
 * becomes an observation if the ramp leg actually receives a quota rejection.
 * "How is an increase requested" is a process answer only Cloudflare can give;
 * the probe hands you the form URL and the RESULT.md field to record the date
 * you asked. That is the honest output, not a placeholder for one.
 *
 * BOTH-DIRECTIONS DISCIPLINE
 * --------------------------
 * A false pass certifies an assumption that is false; a false fail triggers an
 * expensive no-branch that was never needed. Four rules keep both out:
 *
 *   1. A denial only counts as evidence of scoping AFTER the same credential
 *      has been shown to succeed on its own prefix (positive control) and to
 *      hold write permission there (permission control). Without both, a typo
 *      in the signing code looks exactly like perfect isolation. Missing either
 *      control yields INCONCLUSIVE — never PASS, never FAIL.
 *   2. A 429 is reported as RATE_LIMITED — a throughput fact — and never as a
 *      failure of the approach.
 *   3. A denied write or delete is confirmed by reading with the parent
 *      credential afterwards. An operation that returns an error but takes
 *      effect anyway is the one denial that must not be believed.
 *   4. ABSENCE OF EVIDENCE IS NEVER EVIDENCE OF SUCCESS. An outcome that cannot
 *      be attributed to access control — a transport error that never reached
 *      Cloudflare, a 429, a 5xx, an expired credential, a 404 the parent
 *      credential cannot corroborate, a request the URL layer rewrote before
 *      sending — is `unattributable`. Every cell is retried first; if it is
 *      still unattributable it forces INCONCLUSIVE naming what was missing. It
 *      is NEVER counted as a satisfied denial. Rule 4 is the one that was
 *      violated in review: a network blip on a cross-tenant cell used to score
 *      as "denied with no side effect" and produce a PASS having issued zero
 *      successful cross-tenant requests.
 *
 * Exit codes: 0 answered, no blocker. 1 a hard FAIL (scope not enforced, or a
 * corroborated quota ceiling below target). 2 usage/config error. 3 the question
 * was NOT settled — INCONCLUSIVE, unattributable cells, a throttled mint, or a
 * mid-flight crash — which is NOT the same as answering "no". 4 the probe's own
 * self-test failed, so no result from it is trustworthy. 5 the answer is in but
 * cleanup left buckets behind; re-run with --cleanup-only.
 */

import {
  classifyFailure,
  CLIENT_CODES,
  isExpiredCredentialFailure,
  loadEnv,
  MANDATORY_BUCKET_PREFIX,
  R2Client,
  REQUIRED_ENV,
  type Call,
  type CallFailure,
  type FailureKind,
  type R2Env,
} from "./r2-api.ts";
import { mintLocally } from "./mint.ts";
import { rfc3986, sha256Hex, signS3Request, type S3Credentials } from "./sigv4.ts";

// ---------------------------------------------------------------- constants

/** Cloudflare's own published numbers, cited so the report is checkable. */
const DOCUMENTED = {
  bucketsPerAccount: 1_000_000,
  bucketManagementOpsPerSecondPerBucket: 50,
  restApiRequestsPerFiveMinutes: 1_200,
  limitsDoc: "https://developers.cloudflare.com/r2/platform/limits/",
  tempCredentialsDoc: "https://developers.cloudflare.com/r2/api/s3/temporary-credentials/",
  limitIncreaseForm: "https://developers.cloudflare.com/fundamentals/account/limits/",
} as const;

/** The plan's target tenancy (R9 / KTD1). */
const TARGET_TENANTS = 30_000;

/**
 * Exit codes, named so the mapping is testable rather than a chain of returns.
 * `1` used to mean three different things (hard FAIL, a failed self-test, and a
 * cleanup that left buckets behind), which a CI caller cannot tell apart.
 */
export const EXIT = {
  ANSWERED: 0,
  FAIL: 1,
  USAGE: 2,
  NOT_SETTLED: 3,
  SELF_TEST_FAILED: 4,
  CLEANUP_INCOMPLETE: 5,
} as const;

/** How many times a single scope-matrix cell is attempted before it is scored. */
const CELL_ATTEMPTS = 3;
/** How many times a setup/ramp bucket create is attempted through throttling. */
const SETUP_ATTEMPTS = 5;

type Verdict =
  | "PASS"
  | "PASS_WITH_CAVEAT"
  | "FAIL"
  | "INCONCLUSIVE"
  | "RATE_LIMITED"
  | "NOT_OBSERVED"
  | "SKIPPED";

type CreatePath = "rest" | "s3";
type LegName = "inventory" | "latency" | "ratelimit" | "ramp" | "tempcreds";

interface Config {
  legs: Set<LegName>;
  createVia: CreatePath[];
  latencySamples: number;
  warmTimeoutMs: number;
  burst: number;
  ramp: number;
  rampRps: number;
  rampMaxSeconds: number;
  listPerPage: number;
  maxListPages: number;
  mintSamples: number;
  mintBurst: number;
  ttlSeconds: number;
  verifyExpiry: boolean;
  maxExpiryWaitSeconds: number;
  json: boolean;
  write: boolean;
  out: string | null;
  cleanupOnly: boolean;
  cleanupRps: number;
  dryRun: boolean;
}

// ------------------------------------------------------------------- helpers

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Stats {
  count: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[index] ?? 0);
  };
  return {
    count: sorted.length,
    min: Math.round(sorted[0] ?? 0),
    p50: at(50),
    p95: at(95),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
  };
}

function failureSummary(call: CallFailure): string {
  const retry = call.retryAfterSeconds === null ? "" : ` retry-after=${call.retryAfterSeconds}s`;
  return `HTTP ${call.status} [${call.kind}] ${call.code ?? "-"}: ${call.message}${retry}`;
}

function describe<T>(call: Call<T>): string {
  return call.ok ? `HTTP ${call.status} ok` : failureSummary(call);
}

// -------------------------------------------------------------- CLI parsing

/**
 * Every flag this probe understands. An unrecognised flag is an ERROR, not a
 * no-op: `--ramp-max-second=60` or `--burst2=5` used to parse silently and leave
 * the default in place, which on a tool that creates real buckets means the
 * blast radius is not what the operator asked for.
 */
export const BOOLEAN_FLAGS = [
  "verify-expiry",
  "json",
  "no-write",
  "cleanup-only",
  "dry-run",
  "self-test",
  "help",
] as const;

export const VALUE_FLAGS = [
  "legs",
  "create-via",
  "latency-samples",
  "warm-timeout-ms",
  "burst",
  "ramp",
  "ramp-rps",
  "ramp-max-seconds",
  "list-per-page",
  "max-list-pages",
  "mint-samples",
  "mint-burst",
  "ttl",
  "max-expiry-wait",
  "cleanup-rps",
  "out",
] as const;

export function parseArgs(argv: string[]): { config: Config; errors: string[] } {
  const errors: string[] = [];
  const flags = new Map<string, string>();
  const known = new Set<string>([...BOOLEAN_FLAGS, ...VALUE_FLAGS]);
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      errors.push(`unrecognised argument: ${arg}`);
      continue;
    }
    const [key, ...rest] = arg.slice(2).split("=");
    const name = key ?? "";
    const value = rest.length > 0 ? rest.join("=") : "true";
    if (!known.has(name)) {
      errors.push(
        `unknown flag --${name}. This is refused rather than ignored: a typo in --burst or ` +
          `--ramp would otherwise silently change how many buckets this run creates. ` +
          `Run --help for the list.`,
      );
      continue;
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name) && value !== "true" && value !== "false") {
      errors.push(`--${name} is a switch; write --${name} (or --${name}=false), not --${name}=${value}`);
      continue;
    }
    flags.set(name, value);
  }

  const num = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push(`--${name} must be a non-negative number (got ${raw})`);
      return fallback;
    }
    return parsed;
  };
  const bool = (name: string): boolean => flags.get(name) === "true";

  const allLegs: LegName[] = ["inventory", "latency", "ratelimit", "ramp", "tempcreds"];
  const legsRaw = flags.get("legs") ?? "inventory,latency,ratelimit,tempcreds";
  const legs = new Set<LegName>();
  if (legsRaw === "all") {
    for (const leg of allLegs) legs.add(leg);
  } else {
    for (const name of legsRaw.split(",").map((part) => part.trim()).filter(Boolean)) {
      if ((allLegs as string[]).includes(name)) legs.add(name as LegName);
      else errors.push(`unknown leg "${name}" (known: ${allLegs.join(", ")})`);
    }
  }

  const ramp = num("ramp", legs.has("ramp") ? 200 : 0);
  if (ramp > 0) legs.add("ramp");
  if (ramp === 0) legs.delete("ramp");

  const viaRaw = flags.get("create-via") ?? "both";
  const createVia: CreatePath[] =
    viaRaw === "both" ? ["rest", "s3"] : viaRaw === "rest" ? ["rest"] : viaRaw === "s3" ? ["s3"] : [];
  if (createVia.length === 0) errors.push(`--create-via must be rest, s3 or both (got ${viaRaw})`);

  const outRaw = flags.get("out");

  return {
    errors,
    config: {
      legs,
      createVia,
      latencySamples: num("latency-samples", 5),
      warmTimeoutMs: num("warm-timeout-ms", 10_000),
      burst: num("burst", 60),
      ramp,
      rampRps: num("ramp-rps", 4),
      rampMaxSeconds: num("ramp-max-seconds", 900),
      listPerPage: num("list-per-page", 1000),
      maxListPages: num("max-list-pages", 25),
      mintSamples: num("mint-samples", 20),
      mintBurst: num("mint-burst", 30),
      ttlSeconds: num("ttl", 900),
      verifyExpiry: bool("verify-expiry"),
      maxExpiryWaitSeconds: num("max-expiry-wait", 180),
      json: bool("json"),
      write: !bool("no-write"),
      out: outRaw === undefined || outRaw === "true" ? null : outRaw,
      cleanupOnly: bool("cleanup-only"),
      cleanupRps: num("cleanup-rps", 6),
      dryRun: bool("dry-run"),
    },
  };
}

const HELP = `
bun run probe:r2 [flags]     R2 storage-boundary probe (R9 / R10 / Gap Register #15)

Legs (default: inventory,latency,ratelimit,tempcreds)
  --legs=a,b,c               inventory | latency | ratelimit | ramp | tempcreds | all
  --create-via=rest|s3|both  which bucket-create path to exercise (default both)

Sizing
  --latency-samples=N        sequential creates timed per path      (default 5)
  --warm-timeout-ms=N        cap on create-to-first-usable-write    (default 10000)
  --burst=N                  concurrent creates in the rate leg     (default 60)
  --ramp=N                   opt-in ceiling hunt: create up to N     (default off)
  --ramp-rps=N               pacing for the ramp                    (default 4)
  --ramp-max-seconds=N       wall-clock budget for the ramp         (default 900)
  --mint-samples=N           sequential temp-credential mints       (default 20)
  --mint-burst=N             concurrent mints                       (default 30)
  --ttl=N                    requested credential TTL in seconds    (default 900)
  --verify-expiry            re-test after expiry (adds a sleep)    (default off)
  --max-expiry-wait=N        refuse to sleep longer than this       (default 180)

Output / safety
  --self-test                verify the probe's own signing + minting offline,
                             with no credentials and no network. Run this first.
  --dry-run                  print the plan and the blast radius, touch nothing
  --json                     machine-readable report on stdout
  --no-write                 do not write result-<runId>.json
  --out=PATH                 write the JSON report here instead
  --cleanup-only             delete leftover "${MANDATORY_BUCKET_PREFIX}*" buckets and exit
  --cleanup-rps=N            pace the cleanup deletes                (default 6)
  --help

Exit codes
  0 answered, no blocker   1 hard FAIL   2 usage/config error
  3 NOT SETTLED (inconclusive, unattributable cells, throttled mint, or a crash)
  4 the probe's own --self-test failed   5 cleanup left buckets behind

Env: ${REQUIRED_ENV.join(", ")}
     optional: R2_JURISDICTION, R2_S3_ENDPOINT, R2_API_BASE, R2_PROBE_BUCKET_PREFIX
     R2_S3_ENDPOINT is a bare HOST ("<id>.r2.cloudflarestorage.com"), not a URL.
     Put them in .env AT THE REPO ROOT (bun loads .env from the cwd you run in).
See README.md in this directory for what each outcome means for the plan.
`;

// ---------------------------------------------------------------- run context

interface Tracker {
  buckets: Set<string>;
  objects: Array<{ bucket: string; key: string }>;
}

interface Ctx {
  client: R2Client;
  config: Config;
  tracker: Tracker;
  runId: string;
}

function bucketName(ctx: Ctx, label: string): string {
  return `${ctx.client.env.bucketPrefix}${ctx.runId}-${label}`;
}

async function createBucket(ctx: Ctx, name: string, via: CreatePath): Promise<Call<unknown>> {
  const call =
    via === "rest"
      ? await ctx.client.createBucketRest(name)
      : await ctx.client.createBucketS3(ctx.client.parentCredentials(), name);
  if (call.ok) ctx.tracker.buckets.add(name);
  return call;
}

// ------------------------------------------------------- retry / attribution

/**
 * Is this failure a property of the ACCOUNT, or a property of the moment?
 *
 * Transport errors, 429s and 5xx say nothing about access control — they say
 * the question was not asked. Retrying is what turns "we did not get an answer"
 * into either an answer or an honest `unattributable`.
 */
export function isTransient(call: Call<unknown>): boolean {
  if (call.ok) return false;
  if (call.code === CLIENT_CODES.pathNormalised) return false; // deterministic; retrying changes nothing
  return call.status === 0 || call.kind === "rate_limited" || call.status >= 500;
}

function retryDelayMs(call: Call<unknown>, attempt: number): number {
  const retryAfter = call.ok ? null : call.retryAfterSeconds;
  return Math.max(500 * attempt, (retryAfter ?? 0) * 1000);
}

export interface Attempted<T> {
  call: Call<T>;
  attempts: number;
  /** One line per attempt, so a retried cell can be adjudicated by a human. */
  transcript: string[];
}

/**
 * Run a call, retrying while the failure is transient. Every cell in the scope
 * matrix goes through this before it is scored — a single intermittent failure
 * on a cross-tenant cell used to be recorded as a satisfied denial.
 */
async function attemptCall<T>(
  run: () => Promise<Call<T>>,
  attemptsAllowed = CELL_ATTEMPTS,
): Promise<Attempted<T>> {
  let call = await run();
  const transcript = [describe(call)];
  let attempts = 1;
  while (attempts < attemptsAllowed && isTransient(call)) {
    await sleep(retryDelayMs(call, attempts));
    call = await run();
    transcript.push(describe(call));
    attempts += 1;
  }
  return { call, attempts, transcript };
}

async function createBucketWithRetry(
  ctx: Ctx,
  name: string,
  via: CreatePath,
): Promise<Attempted<unknown>> {
  return attemptCall(() => createBucket(ctx, name, via), SETUP_ATTEMPTS);
}

type Presence = "present" | "absent" | "unknown";

/**
 * What does the PARENT credential see at this key, right now?
 *
 * Used for two things, both of which used to be scored on a single unretried
 * call: confirming that a denied write did not land, and corroborating a 404.
 * A 404 from a scoped credential means "denied, obscured" only if the object is
 * actually there; if the parent cannot see it either, the 404 is about the
 * fixture, not about the scope.
 */
async function parentPresence(
  ctx: Ctx,
  bucket: string,
  key: string,
): Promise<{ state: Presence; detail: string }> {
  const { call } = await attemptCall(() => ctx.client.getObject(ctx.client.parentCredentials(), bucket, key));
  if (call.ok) return { state: "present", detail: describe(call) };
  if (call.status === 404) return { state: "absent", detail: describe(call) };
  return { state: "unknown", detail: describe(call) };
}

// ------------------------------------------------------------- leg: inventory

interface InventoryResult {
  verdict: Verdict;
  existingBuckets: number;
  countIsExact: boolean;
  pagesRead: number;
  probeBucketsAlreadyPresent: string[];
  documentedCeiling: number;
  targetTenants: number;
  note: string;
  failure: string | null;
}

async function legInventory(ctx: Ctx): Promise<InventoryResult> {
  const names: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let perPage = ctx.config.listPerPage;

  for (;;) {
    const page: Call<{ names: string[]; cursor: string | null }> = await ctx.client.listBucketsPage(
      cursor,
      perPage,
    );
    if (!page.ok) {
      if (page.status === 400 && perPage > 100) {
        // per_page ceiling is undocumented; step down once rather than
        // reporting a probe-side argument error as an account finding.
        perPage = 100;
        continue;
      }
      return {
        verdict: page.kind === "rate_limited" ? "RATE_LIMITED" : "INCONCLUSIVE",
        existingBuckets: names.length,
        countIsExact: false,
        pagesRead: pages,
        probeBucketsAlreadyPresent: [],
        documentedCeiling: DOCUMENTED.bucketsPerAccount,
        targetTenants: TARGET_TENANTS,
        note: "Bucket listing failed; headroom baseline unknown.",
        failure: failureSummary(page),
      };
    }
    pages += 1;
    names.push(...page.value.names);
    cursor = page.value.cursor;
    if (cursor === null || pages >= ctx.config.maxListPages) break;
  }

  const truncated = cursor !== null;
  return {
    verdict: "PASS",
    existingBuckets: names.length,
    countIsExact: !truncated,
    pagesRead: pages,
    probeBucketsAlreadyPresent: names.filter((name) => name.startsWith(MANDATORY_BUCKET_PREFIX)),
    documentedCeiling: DOCUMENTED.bucketsPerAccount,
    targetTenants: TARGET_TENANTS,
    note: truncated
      ? `Listing stopped at --max-list-pages=${ctx.config.maxListPages}; the count is a LOWER BOUND.`
      : "Full bucket inventory read.",
    failure: null,
  };
}

// --------------------------------------------------------------- leg: latency

interface LatencyPathResult {
  path: CreatePath;
  verdict: Verdict;
  attempted: number;
  created: number;
  createMs: Stats;
  createToFirstWriteMs: Stats;
  writeNeverSucceeded: number;
  failures: string[];
}

async function legLatency(ctx: Ctx): Promise<LatencyPathResult[]> {
  const results: LatencyPathResult[] = [];

  for (const via of ctx.config.createVia) {
    const createMs: number[] = [];
    const warmMs: number[] = [];
    const failures: string[] = [];
    let created = 0;
    let writeNeverSucceeded = 0;

    for (let index = 0; index < ctx.config.latencySamples; index += 1) {
      const name = bucketName(ctx, `lat-${via}-${index}`);
      const started = performance.now();
      const call = await createBucket(ctx, name, via);
      if (!call.ok) {
        failures.push(failureSummary(call));
        continue;
      }
      createMs.push(performance.now() - started);
      created += 1;

      // A bucket is not useful the moment its create returns — it is useful
      // when it accepts an object. That is the warm-pool number.
      const warmStart = performance.now();
      let warmed = false;
      while (performance.now() - warmStart < ctx.config.warmTimeoutMs) {
        const put = await ctx.client.putObject(
          ctx.client.parentCredentials(),
          name,
          "warm.txt",
          "warm",
        );
        if (put.ok) {
          warmed = true;
          ctx.tracker.objects.push({ bucket: name, key: "warm.txt" });
          break;
        }
        if (put.kind === "auth") {
          failures.push(`warm-write auth failure on ${via}: ${failureSummary(put)}`);
          break;
        }
        await sleep(100);
      }
      if (warmed) warmMs.push(performance.now() - warmStart);
      else writeNeverSucceeded += 1;
    }

    const anyRateLimited = failures.some((text) => text.includes("[rate_limited]"));
    const verdict: Verdict =
      created === 0 ? (anyRateLimited ? "RATE_LIMITED" : "INCONCLUSIVE") : "PASS";

    results.push({
      path: via,
      verdict,
      attempted: ctx.config.latencySamples,
      created,
      createMs: stats(createMs),
      createToFirstWriteMs: stats(warmMs),
      writeNeverSucceeded,
      failures,
    });
  }

  return results;
}

// ------------------------------------------------------------- leg: ratelimit

interface RateLimitPathResult {
  path: CreatePath;
  verdict: Verdict;
  concurrentRequests: number;
  succeeded: number;
  rateLimited: number;
  otherFailures: number;
  wallMs: number;
  achievedCreatesPerSecond: number;
  firstRateLimitAtRequest: number | null;
  retryAfterSecondsSeen: number[];
  sampleErrors: string[];
  interpretation: string;
}

async function legRateLimit(ctx: Ctx): Promise<RateLimitPathResult[]> {
  const results: RateLimitPathResult[] = [];

  for (const via of ctx.config.createVia) {
    const started = performance.now();
    const calls = await Promise.all(
      Array.from({ length: ctx.config.burst }, async (_unused, index) => {
        const call = await createBucket(ctx, bucketName(ctx, `rl-${via}-${index}`), via);
        return { index, call };
      }),
    );
    const wallMs = performance.now() - started;

    let succeeded = 0;
    let rateLimited = 0;
    let otherFailures = 0;
    let firstRateLimitAtRequest: number | null = null;
    const retryAfterSecondsSeen: number[] = [];
    const sampleErrors: string[] = [];

    for (const { index, call } of calls) {
      if (call.ok) {
        succeeded += 1;
        continue;
      }
      if (call.kind === "rate_limited") {
        rateLimited += 1;
        if (firstRateLimitAtRequest === null) firstRateLimitAtRequest = index + 1;
        if (call.retryAfterSeconds !== null) retryAfterSecondsSeen.push(call.retryAfterSeconds);
      } else {
        otherFailures += 1;
      }
      if (sampleErrors.length < 3) sampleErrors.push(failureSummary(call));
    }

    const verdict: Verdict =
      succeeded === 0 && rateLimited > 0
        ? "RATE_LIMITED"
        : succeeded === 0
          ? "INCONCLUSIVE"
          : rateLimited > 0
            ? "RATE_LIMITED"
            : "PASS";

    // The "no throttling observed" reading is only available when creates were
    // actually landing. A burst where every request failed for some other
    // reason measured nothing, and must never be reported as headroom.
    const interpretation =
      succeeded === 0 && rateLimited === 0
        ? `Nothing was measured via ${via}: 0 of ${ctx.config.burst} creates succeeded and none were ` +
          `throttled — they failed for another reason (${sampleErrors[0] ?? "no error captured"}). ` +
          `This is NOT evidence about throughput in either direction.`
        : rateLimited > 0
          ? `Throttling observed at ${ctx.config.burst} concurrent creates via ${via}: ` +
            `${succeeded} accepted, ${rateLimited} throttled` +
            (otherFailures > 0 ? `, ${otherFailures} failed for other reasons` : "") +
            `. This is a THROUGHPUT number, not a viability answer — provisioning simply has to ` +
            `be paced or queued.`
          : `No throttling at ${ctx.config.burst} concurrent creates via ${via} ` +
            `(${succeeded} accepted` +
            (otherFailures > 0 ? `, ${otherFailures} failed for other reasons` : "") +
            `). The enforced limit is ABOVE ${ctx.config.burst} concurrent; raise --burst to find it.`;

    results.push({
      path: via,
      verdict,
      concurrentRequests: ctx.config.burst,
      succeeded,
      rateLimited,
      otherFailures,
      wallMs: Math.round(wallMs),
      achievedCreatesPerSecond: Number((succeeded / (wallMs / 1000)).toFixed(2)),
      firstRateLimitAtRequest,
      retryAfterSecondsSeen,
      sampleErrors,
      interpretation,
    });
  }

  return results;
}

// ------------------------------------------------------------------ leg: ramp

type RampTermination =
  | "completed_no_ceiling_found"
  | "quota_ceiling_observed"
  | "quota_uncorroborated"
  | "rate_limited_persistent"
  | "auth_error"
  | "time_budget_exhausted"
  | "other_error";

interface RampResult {
  verdict: Verdict;
  target: number;
  createdInThisRun: number;
  termination: RampTermination;
  terminalError: string | null;
  /** Only set when the pre-run baseline was read exactly. */
  quotaCeilingObservedAt: number | null;
  /** Always set on a quota termination: what this RUN alone proves. */
  quotaCeilingLowerBound: number | null;
  baselineKnown: boolean;
  corroborationAttempts: number;
  corroborationDetail: string[];
  elapsedSeconds: number;
  path: CreatePath;
}

export interface RampBaseline {
  known: boolean;
  exact: boolean;
  count: number;
}

/**
 * Re-ask the question before declaring an account ceiling.
 *
 * `QUOTA_PATTERN` is the loosest classifier in the probe and it guards the most
 * expensive verdict in it (`A FAIL` → "bucket-per-tenant needs a limit increase
 * in writing"). A non-429 4xx whose prose merely contains "limit exceeded" — a
 * per-bucket management limit, a billing gate, an org policy — would produce
 * that claim as fact. Three quota rejections spread over ~10s, with fresh bucket
 * names, is cheap insurance; anything less returns `quota_uncorroborated`.
 */
async function corroborateQuota(
  ctx: Ctx,
  via: CreatePath,
  label: string,
): Promise<{ corroborated: boolean; attempts: number; detail: string[] }> {
  const detail: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sleep(5000);
    const call = await createBucket(ctx, bucketName(ctx, `${label}-corroborate-${attempt}`), via);
    detail.push(describe(call));
    if (call.ok) return { corroborated: false, attempts: attempt + 1, detail };
    if (call.kind !== "quota") return { corroborated: false, attempts: attempt + 1, detail };
  }
  return { corroborated: true, attempts: 2, detail };
}

async function legRamp(ctx: Ctx, baseline: RampBaseline): Promise<RampResult> {
  const via = ctx.config.createVia[0] ?? "rest";
  const intervalMs = ctx.config.rampRps > 0 ? 1000 / ctx.config.rampRps : 0;
  const startedAt = performance.now();

  let created = 0;
  let consecutiveRateLimits = 0;
  let termination: RampTermination = "completed_no_ceiling_found";
  let terminalError: string | null = null;
  let quotaCeilingObservedAt: number | null = null;
  let quotaCeilingLowerBound: number | null = null;
  let corroborationAttempts = 0;
  let corroborationDetail: string[] = [];

  for (let index = 0; index < ctx.config.ramp; index += 1) {
    if ((performance.now() - startedAt) / 1000 > ctx.config.rampMaxSeconds) {
      termination = "time_budget_exhausted";
      break;
    }
    const tick = performance.now();
    // Transient failures are retried rather than terminating the ramp: a DNS
    // blip used to end the hunt as `other_error`.
    const attempt = await createBucketWithRetry(ctx, bucketName(ctx, `ramp-${index}`), via);
    const call = attempt.call;

    if (call.ok) {
      created += 1;
      consecutiveRateLimits = 0;
    } else if (call.kind === "rate_limited") {
      consecutiveRateLimits += 1;
      terminalError = failureSummary(call);
      if (consecutiveRateLimits >= 8) {
        termination = "rate_limited_persistent";
        break;
      }
      await sleep(Math.max(1000, (call.retryAfterSeconds ?? 2) * 1000));
      index -= 1; // retry this slot; throttling is not a ceiling
      continue;
    } else if (call.kind === "quota") {
      terminalError = failureSummary(call);
      const corroboration = await corroborateQuota(ctx, via, `ramp-${index}`);
      corroborationAttempts = corroboration.attempts;
      corroborationDetail = corroboration.detail;
      if (corroboration.corroborated) {
        termination = "quota_ceiling_observed";
        quotaCeilingLowerBound = created;
        quotaCeilingObservedAt = baseline.known && baseline.exact ? baseline.count + created : null;
      } else {
        termination = "quota_uncorroborated";
      }
      break;
    } else if (call.kind === "auth") {
      termination = "auth_error";
      terminalError = failureSummary(call);
      break;
    } else {
      termination = "other_error";
      terminalError = failureSummary(call);
      break;
    }

    const remaining = intervalMs - (performance.now() - tick);
    if (remaining > 0) await sleep(remaining);
  }

  const verdict: Verdict =
    termination === "quota_ceiling_observed"
      ? "FAIL"
      : termination === "completed_no_ceiling_found"
        ? "PASS"
        : termination === "rate_limited_persistent"
          ? "RATE_LIMITED"
          : "INCONCLUSIVE";

  return {
    verdict,
    target: ctx.config.ramp,
    createdInThisRun: created,
    termination,
    terminalError,
    quotaCeilingObservedAt,
    quotaCeilingLowerBound,
    baselineKnown: baseline.known && baseline.exact,
    corroborationAttempts,
    corroborationDetail,
    elapsedSeconds: Math.round((performance.now() - startedAt) / 1000),
    path: via,
  };
}

// ------------------------------------------------------------- leg: tempcreds

export type CellOutcome =
  | "allowed"
  | "denied_403"
  | "denied_404_obscured"
  | "denied_other"
  | "denied_but_took_effect"
  /**
   * The request did not produce an answer that can be attributed to access
   * control. This is NOT a denial and must never be scored as one — see rule 4
   * at the top of this file.
   */
  | "unattributable";

export interface Cell {
  id: string;
  what: string;
  expectation: "allow" | "deny";
  status: number;
  outcome: CellOutcome;
  code: string | null;
  message: string;
  sideEffectCheck: string | null;
  /** How many times the call was issued before it was scored. */
  attempts: number;
  /** False when the outcome says nothing about access control. */
  attributable: boolean;
  /** Why not, in words, when `attributable` is false. */
  unattributableReason: string | null;
  /**
   * Advisory cells inform but do not gate. They escalate on SUCCESS (a cell
   * that reaches another tenant's data is a violation however it was shaped)
   * and are silent otherwise, because their denial is weak evidence.
   */
  advisory: boolean;
  matchesExpectation: boolean;
}

export interface ScopeMatrix {
  mintMode: "api" | "local";
  verdict: Verdict;
  reason: string;
  cells: Cell[];
  enumerationLeak: boolean | null;
  enumerationTested: boolean;
  keysVisibleToUnscopedList: string[];
  mintError: string | null;
  /** True when the mint itself was throttled — the matrix never ran. */
  mintThrottled: boolean;
}

/**
 * Map one HTTP result onto a cell outcome.
 *
 * The four `unattributable` branches are the whole point. Each of them used to
 * fall through to a value that a deny-expectation cell scored as "as expected":
 * a `fetch` throw returns status 0, a 429 is throttling, a 5xx is Cloudflare
 * having a bad minute, and an expired credential is the probe's own TTL running
 * out mid-matrix. None of the four is access control saying no.
 */
export function classifyRead(call: Call<unknown>): CellOutcome {
  if (call.ok) return "allowed";
  if (call.status === 0) return "unattributable";
  if (call.kind === "rate_limited") return "unattributable";
  if (call.status >= 500) return "unattributable";
  if (isExpiredCredentialFailure(call)) return "unattributable";
  if (call.status === 403) return "denied_403";
  if (call.status === 404) return "denied_404_obscured";
  return "denied_other";
}

/** Why a call could not be attributed, in words a human can adjudicate. */
export function unattributableReasonFor(call: Call<unknown>): string {
  if (call.ok) return "";
  if (call.code === CLIENT_CODES.pathNormalised) {
    return "the request was never sent — the URL layer rewrote the path before it left the process";
  }
  if (call.status === 0) {
    return `the request never reached Cloudflare (transport error: ${call.message})`;
  }
  if (call.kind === "rate_limited") {
    return "HTTP 429 — the request was throttled, which is not a denial";
  }
  if (call.status >= 500) {
    return `HTTP ${call.status} — a server-side error, which is not a denial`;
  }
  if (isExpiredCredentialFailure(call)) {
    return `the credential had expired (${call.code ?? "-"}: ${call.message}) — this is the probe's own TTL, not the scope`;
  }
  return `HTTP ${call.status} ${call.code ?? "-"}: ${call.message}`;
}

export interface CellInput {
  id: string;
  what: string;
  expectation: "allow" | "deny";
  call: Call<unknown>;
  outcome: CellOutcome;
  sideEffectCheck: string | null;
  attempts: number;
  advisory?: boolean;
  /** Overrides the derived reason (e.g. an uncorroborated 404). */
  unattributableReason?: string | null;
}

export function cellFrom(input: CellInput): Cell {
  const { call, outcome, expectation } = input;
  const reachedData = outcome === "allowed" || outcome === "denied_but_took_effect";
  const attributable = outcome !== "unattributable";
  return {
    id: input.id,
    what: input.what,
    expectation,
    status: call.status,
    outcome,
    code: call.ok ? null : call.code,
    message: call.ok ? "ok" : call.message,
    sideEffectCheck: input.sideEffectCheck,
    attempts: input.attempts,
    attributable,
    unattributableReason: attributable
      ? null
      : (input.unattributableReason ?? unattributableReasonFor(call)),
    advisory: input.advisory ?? false,
    // An unattributable cell matches NOTHING. This single clause is the fix for
    // the reproduced false positive: `expectation === "deny"` used to be
    // satisfied by any outcome that was not literally `allowed`, so a DNS blip
    // on a cross-tenant read scored as a denial.
    matchesExpectation: !attributable
      ? false
      : expectation === "allow"
        ? outcome === "allowed"
        : !reachedData,
  };
}

/** Fixture bodies, so a cross-tenant read can be confirmed by CONTENT, not just status. */
const FIXTURE = {
  tenantA: "tenant-a private note",
  tenantB: "tenant-b private note",
  sibling: "tenant-abc private note",
  control: "different bucket entirely",
} as const;

async function runScopeMatrix(
  ctx: Ctx,
  credentials: S3Credentials,
  mode: "api" | "local",
  bucketA: string,
  bucketB: string,
): Promise<ScopeMatrix> {
  const parent = ctx.client.parentCredentials();
  const cells: Cell[] = [];
  const ownKey = "tenant-a/probe.txt";
  const otherKey = "tenant-b/probe.txt";
  const writeOwnKey = `tenant-a/written-by-${mode}.txt`;
  const writeOtherKey = `tenant-b/injected-by-${mode}.txt`;

  // 1. POSITIVE CONTROL. Until this passes, every denial below is worthless:
  //    a broken signature denies everything and looks like perfect isolation.
  const readOwn = await attemptCall(() => ctx.client.getObject(credentials, bucketA, ownKey));
  cells.push(
    cellFrom({
      id: "read_own_prefix",
      what: `GET ${bucketA}/${ownKey}`,
      expectation: "allow",
      call: readOwn.call,
      outcome: classifyRead(readOwn.call),
      sideEffectCheck: null,
      attempts: readOwn.attempts,
    }),
  );

  // 2. PERMISSION CONTROL. The credential is minted object-read-WRITE, so it
  //    must be able to write inside its own prefix — otherwise a denied write
  //    to tenant-b proves the permission level, not the prefix scope.
  const writeOwn = await attemptCall(() =>
    ctx.client.putObject(credentials, bucketA, writeOwnKey, "scoped write"),
  );
  if (writeOwn.call.ok) ctx.tracker.objects.push({ bucket: bucketA, key: writeOwnKey });
  cells.push(
    cellFrom({
      id: "write_own_prefix",
      what: `PUT ${bucketA}/${writeOwnKey}`,
      expectation: "allow",
      call: writeOwn.call,
      outcome: classifyRead(writeOwn.call),
      sideEffectCheck: null,
      attempts: writeOwn.attempts,
    }),
  );

  // 3. The assertion: another tenant's object, known to exist and known to be
  //    readable by the parent credential a moment ago. A 404 here is a denial
  //    ONLY if the object is still there — otherwise the probe is reading its
  //    own missing fixture and calling it isolation.
  const readOther = await attemptCall(() => ctx.client.getObject(credentials, bucketA, otherKey));
  let readOtherOutcome = classifyRead(readOther.call);
  let readOtherNote = "the object was written and parent-read during setup";
  let readOtherWhyUnattributable: string | null = null;
  if (readOtherOutcome === "denied_404_obscured") {
    const presence = await parentPresence(ctx, bucketA, otherKey);
    if (presence.state === "present") {
      readOtherNote = `parent re-read AFTER the 404 confirms the object is present (${presence.detail}) — the 404 is an obscured denial`;
    } else {
      readOtherOutcome = "unattributable";
      readOtherWhyUnattributable =
        `the scoped credential got a 404 and the parent credential could not confirm the object ` +
        `is there either (${presence.state}: ${presence.detail}) — this 404 is about the fixture, not the scope`;
    }
  }
  cells.push(
    cellFrom({
      id: "read_other_prefix",
      what: `GET ${bucketA}/${otherKey}`,
      expectation: "deny",
      call: readOther.call,
      outcome: readOtherOutcome,
      sideEffectCheck: readOtherNote,
      attempts: readOther.attempts,
      unattributableReason: readOtherWhyUnattributable,
    }),
  );

  // 4. Denied write, then verified by parent read. A write that errors but
  //    lands is the denial that must not be believed — and a side-effect check
  //    that itself fails proves nothing, so it is retried and may come back
  //    "unknown", which is unattributable rather than "no side effect".
  const writeOther = await attemptCall(() =>
    ctx.client.putObject(credentials, bucketA, writeOtherKey, "cross-tenant"),
  );
  const landed = await parentPresence(ctx, bucketA, writeOtherKey);
  if (landed.state === "present") ctx.tracker.objects.push({ bucket: bucketA, key: writeOtherKey });
  const writeOtherOutcome: CellOutcome = writeOther.call.ok
    ? "allowed"
    : landed.state === "present"
      ? "denied_but_took_effect"
      : landed.state === "unknown"
        ? "unattributable"
        : classifyRead(writeOther.call);
  cells.push(
    cellFrom({
      id: "write_other_prefix",
      what: `PUT ${bucketA}/${writeOtherKey}`,
      expectation: "deny",
      call: writeOther.call,
      outcome: writeOtherOutcome,
      sideEffectCheck:
        landed.state === "present"
          ? "parent read AFTER the call found the object — the write took effect"
          : landed.state === "absent"
            ? "parent read AFTER the call found nothing — no side effect"
            : `the side-effect check itself could not be performed (${landed.detail})`,
      attempts: writeOther.attempts,
      unattributableReason:
        landed.state === "unknown" && !writeOther.call.ok
          ? `the call failed AND the parent-side side-effect check could not be performed ` +
            `(${landed.detail}), so it is unknown whether the write landed`
          : null,
    }),
  );

  // 5. Listing another tenant's prefix. Filenames alone are content.
  //    Note this is an ENUMERATION signal, not an object-access one: it feeds
  //    the caveat below rather than the pass/fail decision, because "objects
  //    are fenced but keys are listable" is a materially different finding from
  //    "the credential can read another tenant's data".
  const listOther = await attemptCall(() => ctx.client.listObjects(credentials, bucketA, "tenant-b/"));
  const listOtherLeakedKeys = listOther.call.ok ? listOther.call.value : [];
  const listOtherOutcome: CellOutcome = listOther.call.ok
    ? listOther.call.value.length > 0
      ? "allowed"
      : "denied_other"
    : classifyRead(listOther.call);
  cells.push(
    cellFrom({
      id: "list_other_prefix",
      what: `ListObjectsV2 ${bucketA}?prefix=tenant-b/`,
      expectation: "deny",
      call: listOther.call,
      outcome: listOtherOutcome,
      sideEffectCheck: listOther.call.ok ? `returned ${listOther.call.value.length} key(s)` : null,
      attempts: listOther.attempts,
    }),
  );

  // 6. Unscoped list — does the credential enumerate the whole bucket?
  const listAll = await attemptCall(() => ctx.client.listObjects(credentials, bucketA, null));
  const unscopedLeakedKeys = listAll.call.ok
    ? listAll.call.value.filter((key) => !key.startsWith("tenant-a/"))
    : [];
  const leakedKeys = [...new Set([...listOtherLeakedKeys, ...unscopedLeakedKeys])];
  const enumerationLeak = leakedKeys.length > 0;
  cells.push(
    cellFrom({
      id: "list_bucket_unscoped",
      what: `ListObjectsV2 ${bucketA} (no prefix)`,
      expectation: "deny",
      call: listAll.call,
      outcome: listAll.call.ok
        ? unscopedLeakedKeys.length > 0
          ? "allowed"
          : "denied_other"
        : classifyRead(listAll.call),
      sideEffectCheck: listAll.call.ok
        ? `returned ${listAll.call.value.length} key(s); ${unscopedLeakedKeys.length} outside the scoped prefix`
        : null,
      attempts: listAll.attempts,
    }),
  );

  // 7. A different bucket entirely. Same 404 corroboration as cell 3.
  const readOtherBucket = await attemptCall(() => ctx.client.getObject(credentials, bucketB, "control.txt"));
  let otherBucketOutcome = classifyRead(readOtherBucket.call);
  let otherBucketNote = "the object was written and parent-read during setup";
  let otherBucketWhy: string | null = null;
  if (otherBucketOutcome === "denied_404_obscured") {
    const presence = await parentPresence(ctx, bucketB, "control.txt");
    if (presence.state === "present") {
      otherBucketNote = `parent re-read AFTER the 404 confirms the object is present — the 404 is an obscured denial`;
    } else {
      otherBucketOutcome = "unattributable";
      otherBucketWhy =
        `the scoped credential got a 404 and the parent credential could not confirm the object ` +
        `is there either (${presence.state}: ${presence.detail})`;
    }
  }
  cells.push(
    cellFrom({
      id: "read_other_bucket",
      what: `GET ${bucketB}/control.txt`,
      expectation: "deny",
      call: readOtherBucket.call,
      outcome: otherBucketOutcome,
      sideEffectCheck: otherBucketNote,
      attempts: readOtherBucket.attempts,
      unattributableReason: otherBucketWhy,
    }),
  );

  // 9a. ADVISORY: a traversal-shaped key that CANNOT be put on the wire.
  //     Every HTTP client resolves ".." out of the path, so this cell is
  //     expected to come back "not sent". That is itself the finding: a
  //     "../"-shaped key degenerates into cell 3 before it leaves the process,
  //     so the traversal hazard U2 must guard is about the DERIVED prefix (see
  //     the derivation probe), not about a literal dot-dot key.
  const dotdotKey = "tenant-a/../tenant-b/probe.txt";
  const dotdot = await attemptCall(() => ctx.client.getObject(credentials, bucketA, dotdotKey));
  cells.push(
    cellFrom({
      id: "read_other_prefix_dotdot",
      what: `GET ${bucketA}/${dotdotKey}`,
      expectation: "deny",
      call: dotdot.call,
      outcome: classifyRead(dotdot.call),
      sideEffectCheck:
        "advisory — a denial here is NOT evidence; only a success would be. See the note in README.",
      attempts: dotdot.attempts,
      advisory: true,
    }),
  );

  // 9b. ADVISORY: the same traversal, double-encoded so it survives URL
  //     parsing and is delivered verbatim. This asks R2 the one question that
  //     is actually answerable over HTTP: does it percent-decode a key a second
  //     time before matching the prefix? A 404 means no. A 200 means yes, and
  //     is a real cross-tenant read.
  const encodedKey = "tenant-a/%2e%2e/tenant-b/probe.txt";
  const encoded = await attemptCall(() => ctx.client.getObject(credentials, bucketA, encodedKey));
  const encodedServedTenantB = encoded.call.ok && encoded.call.value.includes(FIXTURE.tenantB);
  cells.push(
    cellFrom({
      id: "read_other_prefix_encoded_traversal",
      what: `GET ${bucketA}/${encodedKey} (sent double-encoded)`,
      expectation: "deny",
      call: encoded.call,
      outcome: classifyRead(encoded.call),
      sideEffectCheck: encoded.call.ok
        ? encodedServedTenantB
          ? "the response body IS tenant-b's fixture — R2 decoded the key twice and crossed the prefix"
          : "a 2xx was returned; the body is not tenant-b's fixture"
        : encoded.call.status === 404
          ? "advisory — a 404 means the key was treated literally: no second percent-decode, no traversal"
          : "advisory — denied before the question could be answered; only a 2xx here would be evidence",
      attempts: encoded.attempts,
      advisory: true,
    }),
  );

  // 8. Delete, verified by parent read afterwards. Run last, and restore the
  //    object either way so the second mint mode sees the same fixture.
  const deleteOther = await attemptCall(() => ctx.client.deleteObject(credentials, bucketA, otherKey));
  const survived = await parentPresence(ctx, bucketA, otherKey);
  const deleteOutcome: CellOutcome = deleteOther.call.ok
    ? "allowed"
    : survived.state === "present"
      ? classifyRead(deleteOther.call)
      : survived.state === "absent"
        ? "denied_but_took_effect"
        : "unattributable";
  cells.push(
    cellFrom({
      id: "delete_other_prefix",
      what: `DELETE ${bucketA}/${otherKey}`,
      expectation: "deny",
      call: deleteOther.call,
      outcome: deleteOutcome,
      sideEffectCheck:
        survived.state === "present"
          ? "parent read AFTER the call still finds the object — no side effect"
          : survived.state === "absent"
            ? "parent read AFTER the call finds it GONE — the delete took effect"
            : `the side-effect check itself could not be performed (${survived.detail})`,
      attempts: deleteOther.attempts,
      unattributableReason:
        survived.state === "unknown"
          ? `the parent-side side-effect check could not be performed (${survived.detail}), so it is ` +
            `unknown whether the delete took effect. A blackout that hides the side-effect check is ` +
            `not a denial.`
          : null,
    }),
  );
  if (survived.state !== "present") {
    // Restore the fixture for the next mint mode, whether it was deleted or the
    // check was inconclusive. A failed restore is caught by the next mode's
    // 404 corroboration rather than silently degrading it.
    await attemptCall(() => ctx.client.putObject(parent, bucketA, otherKey, FIXTURE.tenantB));
  }

  const enumerationTested = cells
    .filter((cell) => cell.id === "list_other_prefix" || cell.id === "list_bucket_unscoped")
    .every((cell) => cell.attributable);

  const decision = decideScopeVerdict(cells, {
    listOtherPrefixKeys: listOtherLeakedKeys.length,
    unscopedListKeys: unscopedLeakedKeys.length,
    distinctLeakedKeys: leakedKeys.length,
  });

  return {
    mintMode: mode,
    verdict: decision.verdict,
    reason: decision.reason,
    cells,
    enumerationLeak,
    enumerationTested,
    keysVisibleToUnscopedList: leakedKeys.slice(0, 10),
    mintError: null,
    mintThrottled: false,
  };
}

/**
 * Turn a completed scope matrix into a verdict. Pure, and separated from the
 * I/O above so `--self-test` can pin it: this is where a false pass or a false
 * fail would actually be manufactured, and it is the one part of the probe that
 * a run against real credentials exercises only in whichever branch that run
 * happens to land in.
 *
 * Only OBJECT ACCESS decides pass/fail. The two list cells are ENUMERATION
 * signals and route to the caveat instead — a credential that cannot read,
 * write or delete another tenant's objects but can see their key names is a
 * real finding with a real mitigation (make every list call carry the tenant
 * prefix), and collapsing it into FAIL would trigger exactly the expensive
 * no-branch this probe exists to prevent. Whether R2 denies, filters or leaks
 * an out-of-prefix list is genuinely unknown, which is why both cells are run.
 */
export const OBJECT_ACCESS_CELLS = [
  "read_other_prefix",
  "write_other_prefix",
  "delete_other_prefix",
  "read_other_bucket",
] as const;

export interface LeakCounts {
  listOtherPrefixKeys: number;
  unscopedListKeys: number;
  distinctLeakedKeys: number;
}

export function decideScopeVerdict(
  cells: Cell[],
  leak: LeakCounts,
): { verdict: Verdict; reason: string } {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const positive = byId.get("read_own_prefix");
  const permission = byId.get("write_own_prefix");
  const gating = cells.filter((cell) =>
    (OBJECT_ACCESS_CELLS as readonly string[]).includes(cell.id),
  );

  // A cell that REACHED data outside the prefix is a violation however it was
  // shaped — including the advisory traversal cells, which are silent on denial
  // but never silent on success.
  const violations = [
    ...gating.filter((cell) => cell.attributable && !cell.matchesExpectation),
    ...cells.filter(
      (cell) =>
        cell.advisory &&
        cell.attributable &&
        (cell.outcome === "allowed" || cell.outcome === "denied_but_took_effect"),
    ),
  ];

  if (!positive) {
    return {
      verdict: "INCONCLUSIVE",
      reason: "positive_control_missing — the matrix did not run its own-prefix read at all.",
    };
  }
  if (positive.outcome === "unattributable") {
    return {
      verdict: "INCONCLUSIVE",
      reason:
        `positive_control_unattributable — the own-prefix read never produced an answer that can be ` +
        `attributed to access control after ${positive.attempts} attempt(s) ` +
        `(${positive.unattributableReason ?? "unknown"}). Nothing below it means anything.`,
    };
  }
  if (positive.outcome !== "allowed") {
    return {
      verdict: "INCONCLUSIVE",
      reason:
        "positive_control_failed — the scoped credential could not read its OWN prefix, so every " +
        "denial is unattributable (a mint, signing or claim-set problem looks identical to " +
        "perfect isolation). This is NOT evidence that scoping fails.",
    };
  }
  if (!permission || permission.outcome !== "allowed") {
    return {
      verdict: "INCONCLUSIVE",
      reason:
        "permission_control_failed — the credential cannot write inside its own prefix, so denied " +
        "writes elsewhere demonstrate the permission level, not the prefix scope." +
        (permission?.outcome === "unattributable"
          ? ` (${permission.unattributableReason ?? "unattributable"})`
          : ""),
    };
  }

  // A demonstrated violation is real evidence and outranks a missing answer
  // elsewhere: if one cell reached tenant-b's data, the boundary is broken
  // whether or not a second cell got a clean result.
  if (violations.length > 0) {
    return {
      verdict: "FAIL",
      reason: `scope_not_enforced — ${violations
        .map((cell) => cell.id)
        .join(", ")} reached data outside the scoped prefix.`,
    };
  }

  // THE RULE-4 GATE. Anything the probe could not attribute means that boundary
  // was not exercised. Reporting PASS here is the exact inverse of what a scope
  // test is for: it would certify "every cross-tenant read was denied" on the
  // strength of requests that never reached Cloudflare.
  const missing = (OBJECT_ACCESS_CELLS as readonly string[]).filter((id) => !byId.has(id));
  const unattributable = gating.filter((cell) => !cell.attributable);
  if (unattributable.length > 0 || missing.length > 0) {
    const detail = [
      ...unattributable.map(
        (cell) => `${cell.id} (${cell.attempts} attempt(s): ${cell.unattributableReason ?? "unknown"})`,
      ),
      ...missing.map((id) => `${id} (never ran)`),
    ];
    return {
      verdict: "INCONCLUSIVE",
      reason:
        `unattributable_cells — ${detail.join("; ")}. The boundary each of those cells tests was NOT ` +
        `exercised: a request that never reached Cloudflare, was throttled, hit a 5xx, expired, or ` +
        `could not be corroborated is not a denial. Re-run; do not read this as isolation.`,
    };
  }

  if (leak.distinctLeakedKeys > 0) {
    const which = [
      leak.listOtherPrefixKeys > 0 ? "a list scoped to the other tenant's prefix" : null,
      leak.unscopedListKeys > 0 ? "an unscoped list of the bucket" : null,
    ].filter((entry): entry is string => entry !== null);
    return {
      verdict: "PASS_WITH_CAVEAT",
      reason:
        "scope_enforced_for_objects_but_bucket_is_enumerable — every object read, write and delete " +
        `outside the prefix was denied, but ${which.join(" and ")} returned ` +
        `${leak.distinctLeakedKeys} key(s) outside the scoped prefix. Key names are content. ` +
        "Mitigation: require every list call to carry the tenant prefix (a U2 accessor rule). " +
        "A bucket-per-tenant layout does not have this failure mode at all.",
    };
  }

  // Objects are fenced, but if the list cells themselves were unattributable
  // the enumeration question is UNANSWERED — which is not the same as "no leak".
  const listCells = ["list_other_prefix", "list_bucket_unscoped"].map((id) => byId.get(id));
  const untestedEnumeration = listCells.filter((cell) => cell === undefined || !cell.attributable);
  if (untestedEnumeration.length > 0) {
    return {
      verdict: "PASS_WITH_CAVEAT",
      reason:
        "scope_enforced_for_objects_but_enumeration_untested — every cross-tenant object read, write, " +
        "delete and cross-bucket read was denied with an attributable answer, but the list cell(s) did " +
        "not produce one, so whether key names leak across prefixes is UNKNOWN from this run. " +
        "Re-run before relying on the enumeration half.",
    };
  }

  return {
    verdict: "PASS",
    reason:
      "scope_enforced — positive and permission controls both passed, and every cross-tenant read, " +
      "write, delete, list and cross-bucket read returned an attributable denial with no side effect.",
  };
}

/**
 * Fold the two mint modes into one option verdict.
 *
 * Pure, exported and self-tested, because three separate false-report paths met
 * here:
 *
 *   - a mint that was THROTTLED used to rank `RATE_LIMITED` (4) above
 *     `INCONCLUSIVE` (1) and win, so a run that issued zero cross-tenant
 *     requests reported a throughput verdict and exited 0. A mint that failed
 *     means the matrix did not run; that is not-settled, full stop.
 *   - `PASS` (6) outranked `PASS_WITH_CAVEAT` (5), so an api-mode enumeration
 *     leak was outranked away by a clean local-mode result and the committed
 *     record said `PASS`. Caveats are now STICKY: they survive into the verdict.
 *   - a local-mode FAIL used to collapse into `scope_not_enforced` for the whole
 *     option, condemning the API mint — the production path — on the strength of
 *     a hand-transcribed claim set. It is now reported as what it is.
 */
const COMBINE_ORDER: Record<Verdict, number> = {
  PASS: 6,
  PASS_WITH_CAVEAT: 5,
  NOT_OBSERVED: 3,
  SKIPPED: 2,
  INCONCLUSIVE: 1,
  RATE_LIMITED: 1,
  FAIL: 0,
};

export interface CombinedScope {
  verdict: Verdict;
  reason: string;
  headline: string;
  caveats: string[];
  modesVerified: string[];
}

function matrixRan(matrix: ScopeMatrix): boolean {
  return matrix.cells.length > 0;
}

export function combineScopeMatrices(matrices: ScopeMatrix[]): CombinedScope {
  const ran = matrices.filter(matrixRan);
  const notRun = matrices.filter((matrix) => !matrixRan(matrix));

  if (ran.length === 0) {
    const why = notRun
      .map(
        (matrix) =>
          `${matrix.mintMode}: ${matrix.mintThrottled ? "THROTTLED — " : ""}${matrix.mintError ?? matrix.reason}`,
      )
      .join("; ");
    return {
      verdict: "INCONCLUSIVE",
      reason:
        `no_matrix_ran — no usable credential was obtained, so ZERO cross-tenant requests were ` +
        `issued and the scope was not tested in either direction (${why || "no mint attempted"}).`,
      headline:
        "No credential could be minted, so the scope was never tested. This says nothing about " +
        "whether scoping holds — re-run.",
      caveats: [],
      modesVerified: [],
    };
  }

  const api = ran.find((matrix) => matrix.mintMode === "api");
  const local = ran.find((matrix) => matrix.mintMode === "local");
  const apiHeld = api !== undefined && (api.verdict === "PASS" || api.verdict === "PASS_WITH_CAVEAT");

  const caveats: string[] = [];
  for (const matrix of ran) {
    if (matrix.verdict === "PASS_WITH_CAVEAT") caveats.push(`${matrix.mintMode} mint: ${matrix.reason}`);
  }
  for (const matrix of notRun) {
    caveats.push(
      `${matrix.mintMode} mint mode was NOT tested (${matrix.mintThrottled ? "throttled" : "mint failed"}: ${matrix.mintError ?? "no detail"}).`,
    );
  }

  if (api?.verdict === "FAIL") {
    return {
      verdict: "FAIL",
      reason: `scope_not_enforced — the API-minted credential (the production path) reached data outside its prefix: ${api.reason}`,
      headline:
        "A credential scoped to one tenant's prefix REACHED another tenant's data. This option is " +
        "not usable as an isolation boundary as configured.",
      caveats,
      modesVerified: [],
    };
  }

  if (local?.verdict === "FAIL") {
    if (apiHeld) {
      caveats.unshift(
        "local_claim_set_suspect — the locally-minted (JWT) credential reached data outside its " +
          "prefix while the API-minted credential did not. Either the hand-transcribed claim set is " +
          "wrong or R2 does not honour `paths` for JWT-minted credentials. LOCAL MINTING IS " +
          "DISQUALIFIED by this run; the API mint is the production path and it held.",
      );
      return {
        verdict: "PASS_WITH_CAVEAT",
        reason: `${api?.mintMode ?? "api"} mint held (${api?.reason ?? ""}) but ${caveats[0] ?? ""}`,
        headline:
          "The API-minted credential is fenced by prefix, but the locally-minted JWT credential is " +
          "NOT. Take Option B with API minting only; do not mint locally on this evidence.",
        caveats,
        modesVerified: api ? [api.mintMode] : [],
      };
    }
    return {
      verdict: "INCONCLUSIVE",
      reason:
        "local_mint_unfenced_api_untested — the locally-minted credential reached data outside its " +
        "prefix, and the API mint (the production path) did not produce a usable result, so it is " +
        "unknown whether this is a bad claim set or a platform-side gap. Do NOT branch on this.",
      headline:
        "A locally-minted credential was not fenced, and the API mint was not verified in this run. " +
        "The option is not settled.",
      caveats,
      modesVerified: [],
    };
  }

  const best = ran.reduce<ScopeMatrix>((winner, matrix) =>
    COMBINE_ORDER[matrix.verdict] > COMBINE_ORDER[winner.verdict] ? matrix : winner,
  ran[0] as ScopeMatrix);

  const modesVerified = ran
    .filter((matrix) => matrix.verdict === "PASS" || matrix.verdict === "PASS_WITH_CAVEAT")
    .map((matrix) => matrix.mintMode);

  // A verdict that rests ONLY on the local mint is weaker than it looks: local
  // minting is the mode this probe cannot independently verify (a hand-
  // transcribed claim set), and it is not the production path. Passing on it
  // while the API mint went unsettled is a real result, but not a clean one.
  //
  // The converse is NOT a caveat: an API mint that held is the thing R9 would
  // build on, and a local mint that failed to authenticate is documented as
  // UNVERIFIED rather than unsupported.
  if (best.mintMode === "local" && !apiHeld && COMBINE_ORDER[best.verdict] >= COMBINE_ORDER.PASS_WITH_CAVEAT) {
    caveats.push(
      "verified_only_via_local_mint — the scope was demonstrated with a locally-minted JWT " +
        "credential, but the API mint (the production path) did not produce a usable result in this " +
        "run. Re-run before reporting the API path as enforced.",
    );
  }

  // Caveats are sticky: a clean result in one mint mode does not erase a named
  // exception observed in the other.
  const verdict: Verdict =
    best.verdict === "PASS" && caveats.length > 0 ? "PASS_WITH_CAVEAT" : best.verdict;

  const settled = verdict === "PASS" || verdict === "PASS_WITH_CAVEAT";
  const headline = settled
    ? `Prefix-scoped credentials mint and the scope holds via the ${modesVerified.join(" and ")} mint ` +
      `mode${modesVerified.length === 1 ? "" : "s"}: a tenant-a credential met an attributable denial on ` +
      `every cross-tenant read, write, delete, list and cross-bucket access.` +
      (caveats.length > 0 ? ` WITH CAVEAT: ${caveats[0] ?? ""}` : "")
    : `The scope could not be tested conclusively (${best.mintMode} mint was the strongest result). ` +
      `Read the reason before treating this as a no.`;

  return {
    verdict,
    reason: `${best.mintMode} mint mode is the strongest result: ${best.reason}`,
    headline,
    caveats,
    modesVerified,
  };
}

/**
 * Did the TTL actually expire, or did something else fail after the sleep?
 *
 * `deniedAfterExpiry: !after.ok` treated a 429, a transport error or a 500 as
 * proof of expiry. Bounded TTL is the entire basis of R10's blast-radius claim,
 * so it gets the same attribution discipline as a scope cell.
 */
export function adjudicateExpiry(input: {
  beforeOk: boolean;
  beforeDetail: string;
  afterOk: boolean;
  afterStatus: number;
  afterKind: FailureKind | null;
  afterExpiredShaped: boolean;
  afterDetail: string;
  objectStillPresent: Presence;
}): { deniedAfterExpiry: boolean | null; note: string } {
  if (!input.beforeOk) {
    return {
      deniedAfterExpiry: null,
      note:
        `not adjudicated — the pre-expiry control read FAILED (${input.beforeDetail}), so there is no ` +
        `"it worked before" to compare against.`,
    };
  }
  if (input.afterOk) {
    return {
      deniedAfterExpiry: false,
      note: `the credential STILL WORKED after its TTL elapsed (${input.afterDetail}). Bounded TTL did not hold.`,
    };
  }
  if (input.objectStillPresent !== "present") {
    return {
      deniedAfterExpiry: null,
      note:
        `not adjudicated — the post-expiry read failed (${input.afterDetail}) but the parent credential ` +
        `could not confirm the object is still there (${input.objectStillPresent}), so the failure is ` +
        `not attributable to expiry.`,
    };
  }
  if (input.afterStatus === 0 || input.afterKind === "rate_limited" || input.afterStatus >= 500) {
    return {
      deniedAfterExpiry: null,
      note:
        `not adjudicated — the post-expiry read failed for a reason unrelated to access control ` +
        `(${input.afterDetail}). A blip after the sleep is not proof of expiry.`,
    };
  }
  if (!input.afterExpiredShaped && input.afterStatus !== 403 && input.afterStatus !== 401) {
    return {
      deniedAfterExpiry: null,
      note: `not adjudicated — the post-expiry failure is not expiry-shaped (${input.afterDetail}).`,
    };
  }
  return {
    deniedAfterExpiry: true,
    note:
      `the credential worked before the TTL and was denied after it (${input.afterDetail}); the object ` +
      `is still present, so the denial is the expiry and not a missing fixture.`,
  };
}

/**
 * What the derivation probe observed about R2's prefix MATCHING, which is a
 * different question from whether a correctly-formed prefix is enforced.
 */
export type DerivationFinding =
  | "literal_prefix_match_sibling_reachable"
  | "prefix_is_component_aware"
  | "bare_prefix_grants_nothing"
  | "inconclusive";

export function judgeDerivation(own: CellOutcome, sibling: CellOutcome): DerivationFinding {
  if (own === "unattributable" || sibling === "unattributable") return "inconclusive";
  const ownAllowed = own === "allowed";
  const siblingAllowed = sibling === "allowed";
  if (ownAllowed && siblingAllowed) return "literal_prefix_match_sibling_reachable";
  if (ownAllowed && !siblingAllowed) return "prefix_is_component_aware";
  if (!ownAllowed && !siblingAllowed) return "bare_prefix_grants_nothing";
  return "inconclusive";
}

export function derivationConsequence(finding: DerivationFinding): string {
  switch (finding) {
    case "literal_prefix_match_sibling_reachable":
      return (
        "R2 matches `prefixes` LITERALLY: a credential scoped to `tenant-a` reached `tenant-abc/`. " +
        "U2 MUST terminate every derived prefix with '/' — the platform does NOT catch a missing " +
        "terminator, so the key-derivation guard stays a REQUIRED control, not defence in depth."
      );
    case "prefix_is_component_aware":
      return (
        "A credential scoped to `tenant-a` (no trailing slash) did NOT reach `tenant-abc/`, so R2's " +
        "prefix match respects a path-component boundary. The sibling-prefix derivation bug is caught " +
        "by the platform. Still terminate the prefix explicitly; do not rely on this undocumented shape."
      );
    case "bare_prefix_grants_nothing":
      return (
        "A prefix without a trailing slash granted NOTHING — not even `tenant-a/probe.txt`. A " +
        "derivation that drops the terminator fails closed (an outage, not a leak), but U2 must still " +
        "normalise the terminator or storage breaks for every tenant."
      );
    case "inconclusive":
      return (
        "The derivation probe did not produce an attributable answer, so it is UNKNOWN whether R2's " +
        "prefix match is literal or component-aware. U2's key-derivation guard must therefore be kept " +
        "as a required control — do not downgrade it to defence in depth on this run."
      );
  }
}

/**
 * The exit code, as a pure function of the run's outcome. Extracted so the
 * contract is pinned by `--self-test` rather than by reading a chain of returns:
 * a throttled mint used to exit 0 ("answered, no blocker") having gathered no
 * scope evidence at all.
 */
export function exitCodeFor(input: {
  crashed: boolean;
  verdicts: Verdict[];
  cleanupIncomplete: boolean;
}): number {
  if (input.verdicts.includes("FAIL")) return EXIT.FAIL;
  if (input.crashed) return EXIT.NOT_SETTLED;
  if (input.verdicts.some((verdict) => verdict === "INCONCLUSIVE" || verdict === "RATE_LIMITED")) {
    return EXIT.NOT_SETTLED;
  }
  if (input.cleanupIncomplete) return EXIT.CLEANUP_INCOMPLETE;
  return EXIT.ANSWERED;
}

interface TtlLadderEntry {
  ttlSeconds: number;
  accepted: boolean;
  /** A throttled or transport-failed ladder rung is not a rejection. */
  attributable: boolean;
  error: string | null;
}

interface DerivationResult {
  ran: boolean;
  finding: DerivationFinding;
  consequence: string;
  cells: Cell[];
  mintError: string | null;
}

interface TempCredsResult {
  verdict: Verdict;
  reason: string;
  headline: string;
  caveats: string[];
  modesVerified: string[];
  setupError: string | null;
  ttlLadder: TtlLadderEntry[];
  minimumAcceptedTtlSeconds: number | null;
  /** The TTL the scope matrix itself was minted at — deliberately NOT the shortest. */
  matrixTtlSeconds: number | null;
  apiMint: ScopeMatrix | null;
  localMint: ScopeMatrix | null;
  derivation: DerivationResult | null;
  apiMintLatencyMs: Stats;
  apiMintAttempted: number;
  apiMintRateLimited: number;
  apiMintOtherFailures: number;
  apiMintFailureSamples: string[];
  apiMintBurst: {
    concurrent: number;
    succeeded: number;
    rateLimited: number;
    otherFailures: number;
    wallMs: number;
    achievedMintsPerSecond: number;
  } | null;
  localMintsPerSecond: number | null;
  /** False when the locally-minted credential never authenticated. */
  localMintVerified: boolean;
  expiryCheck: { ran: boolean; ttlSeconds: number | null; deniedAfterExpiry: boolean | null; note: string };
}

/**
 * Write a fixture, tolerating the lag between a bucket's create returning and
 * that bucket accepting an object. The latency leg budgets `--warm-timeout-ms`
 * for exactly this lag; setup used to allow one retry after 1s and then report
 * "the S3 credentials or endpoint are wrong", which is an assertion of a cause
 * that is usually false.
 */
async function putFixture(
  ctx: Ctx,
  bucket: string,
  key: string,
  body: string,
): Promise<{ call: Call<string>; waitedMs: number; attempts: number }> {
  const parent = ctx.client.parentCredentials();
  const started = performance.now();
  let attempts = 0;
  let call = await ctx.client.putObject(parent, bucket, key, body);
  attempts += 1;
  while (!call.ok && call.kind !== "auth" && performance.now() - started < ctx.config.warmTimeoutMs) {
    await sleep(Math.max(250, (call.retryAfterSeconds ?? 0) * 1000));
    call = await ctx.client.putObject(parent, bucket, key, body);
    attempts += 1;
  }
  return { call, waitedMs: Math.round(performance.now() - started), attempts };
}

async function legTempCreds(ctx: Ctx): Promise<TempCredsResult> {
  const parent = ctx.client.parentCredentials();
  const bucketA = bucketName(ctx, "tenants");
  const bucketB = bucketName(ctx, "control");

  const empty: TempCredsResult = {
    verdict: "INCONCLUSIVE",
    reason: "",
    headline: "The scope could not be tested — read the reason before treating this as a no.",
    caveats: [],
    modesVerified: [],
    setupError: null,
    ttlLadder: [],
    minimumAcceptedTtlSeconds: null,
    matrixTtlSeconds: null,
    apiMint: null,
    localMint: null,
    derivation: null,
    apiMintLatencyMs: stats([]),
    apiMintAttempted: 0,
    apiMintRateLimited: 0,
    apiMintOtherFailures: 0,
    apiMintFailureSamples: [],
    apiMintBurst: null,
    localMintsPerSecond: null,
    localMintVerified: false,
    expiryCheck: { ran: false, ttlSeconds: null, deniedAfterExpiry: null, note: "not requested" },
  };

  // -- setup, with every step required to succeed before any denial counts ---
  // Retried through throttling: this leg runs after legs that deliberately
  // provoke 429s, and setup used to take a single unretried shot at each create.
  for (const name of [bucketA, bucketB]) {
    const attempt = await createBucketWithRetry(ctx, name, "rest");
    if (!attempt.call.ok) {
      const throttled = !attempt.call.ok && attempt.call.kind === "rate_limited";
      return {
        ...empty,
        setupError: `could not create ${name} after ${attempt.attempts} attempt(s): ${failureSummary(attempt.call)}`,
        reason:
          "setup_failed — no bucket to scope a credential against. " +
          (throttled
            ? "The account was still throttled after every retry; run `--legs=tempcreds` on its own, " +
              "or wait five minutes for the REST budget window to roll over."
            : "Check the token's R2 permissions (bucket creation needs Admin Read & Write)."),
      };
    }
  }

  const fixtures: Array<{ bucket: string; key: string; body: string }> = [
    { bucket: bucketA, key: "tenant-a/probe.txt", body: FIXTURE.tenantA },
    { bucket: bucketA, key: "tenant-b/probe.txt", body: FIXTURE.tenantB },
    // Sibling of `tenant-a` under a LITERAL prefix match, for the derivation probe.
    { bucket: bucketA, key: "tenant-abc/probe.txt", body: FIXTURE.sibling },
    { bucket: bucketB, key: "control.txt", body: FIXTURE.control },
  ];
  for (const fixture of fixtures) {
    const put = await putFixture(ctx, fixture.bucket, fixture.key, fixture.body);
    if (!put.call.ok) {
      const authFailed = put.call.kind === "auth";
      return {
        ...empty,
        setupError:
          `parent write failed for ${fixture.bucket}/${fixture.key} after ${put.attempts} attempt(s) ` +
          `over ${put.waitedMs}ms: ${failureSummary(put.call)}`,
        reason: authFailed
          ? "setup_failed — the PARENT credential was REJECTED writing a fixture. Check the S3 access " +
            "key id / secret access key and that R2_S3_ENDPOINT is a bare host, not a URL. Nothing " +
            "about scoping can be concluded from this run."
          : `setup_failed — a bucket created moments ago did not accept a write within ` +
            `--warm-timeout-ms=${ctx.config.warmTimeoutMs}. The first hypothesis is bucket-create ` +
            `propagation lag or residual throttling from the earlier legs, NOT bad credentials — ` +
            `re-run with --legs=tempcreds, or raise --warm-timeout-ms. Nothing about scoping can be ` +
            `concluded from this run.`,
      };
    }
    ctx.tracker.objects.push({ bucket: fixture.bucket, key: fixture.key });
  }
  for (const fixture of fixtures) {
    const get = await attemptCall(() => ctx.client.getObject(parent, fixture.bucket, fixture.key));
    if (!get.call.ok) {
      return {
        ...empty,
        setupError: `parent read failed for ${fixture.bucket}/${fixture.key}: ${failureSummary(get.call)}`,
        reason:
          "setup_failed — a fixture the probe just wrote is not parent-readable, so a later 404 " +
          "could not be attributed to scoping.",
      };
    }
  }

  // -- TTL ladder: R2 documents no minimum, so discover it -------------------
  // A throttled rung is NOT a rejection: it is recorded as unattributable so a
  // 429 cannot masquerade as "R2 refuses a 60-second TTL".
  const ladderCandidates = [60, 300, ctx.config.ttlSeconds, 3600].filter(
    (value, index, all) => value > 0 && all.indexOf(value) === index,
  );
  ladderCandidates.sort((a, b) => a - b);
  const ttlLadder: TtlLadderEntry[] = [];
  let minimumAcceptedTtlSeconds: number | null = null;
  for (const ttlSeconds of ladderCandidates) {
    const mint = await attemptCall(() =>
      ctx.client.mintTempCredentials({
        bucket: bucketA,
        permission: "object-read-write",
        ttlSeconds,
        prefixes: ["tenant-a/"],
      }),
    );
    ttlLadder.push({
      ttlSeconds,
      accepted: mint.call.ok,
      attributable: mint.call.ok || !isTransient(mint.call),
      error: mint.call.ok ? null : failureSummary(mint.call),
    });
    if (mint.call.ok && minimumAcceptedTtlSeconds === null) minimumAcceptedTtlSeconds = ttlSeconds;
  }

  // The matrix is minted at a COMFORTABLE TTL, never the shortest accepted one.
  // Minting at the floor meant an `ExpiredToken` 403 partway through the matrix
  // was scored identically to a scope denial.
  const matrixTtl = Math.max(ctx.config.ttlSeconds, 300);

  // -- scope matrix, mint mode 1: the Temporary Credentials API --------------
  const apiCredsAttempt = await attemptCall(() =>
    ctx.client.mintTempCredentials({
      bucket: bucketA,
      permission: "object-read-write",
      ttlSeconds: matrixTtl,
      prefixes: ["tenant-a/"],
    }),
  );
  const apiCreds = apiCredsAttempt.call;
  let apiMint: ScopeMatrix;
  if (apiCreds.ok) {
    apiMint = await runScopeMatrix(ctx, apiCreds.value, "api", bucketA, bucketB);
  } else {
    const throttled = apiCreds.kind === "rate_limited";
    apiMint = {
      mintMode: "api",
      // NOT `RATE_LIMITED`. A throughput verdict here used to outrank
      // INCONCLUSIVE and carry the whole option to exit 0 with zero evidence.
      verdict: "INCONCLUSIVE",
      reason:
        `mint_failed — no credential to test after ${apiCredsAttempt.attempts} attempt(s), so ZERO ` +
        `cross-tenant requests were issued in this mode. ` +
        (throttled
          ? "The mint was THROTTLED; that is a throughput fact about minting, and says nothing about " +
            "whether scoping holds."
          : "This says nothing about whether scoping holds."),
      cells: [],
      enumerationLeak: null,
      enumerationTested: false,
      keysVisibleToUnscopedList: [],
      mintError: failureSummary(apiCreds),
      mintThrottled: throttled,
    };
  }

  // -- scope matrix, mint mode 2: local HS256 JWT, no API call ---------------
  const local = await mintLocally({
    accountId: ctx.client.env.accountId,
    parentAccessKeyId: ctx.client.env.parentAccessKeyId,
    parentSecretAccessKey: ctx.client.env.parentSecretAccessKey,
    endpointHost: ctx.client.env.s3Host,
    bucket: bucketA,
    scope: "object-read-write",
    ttlSeconds: Math.max(matrixTtl, 900),
    prefixPaths: ["tenant-a/"],
  });
  const localMint = await runScopeMatrix(ctx, local.credentials, "local", bucketA, bucketB);
  if (localMint.verdict === "INCONCLUSIVE") {
    localMint.reason +=
      " Local minting transcribes a claim set from Cloudflare's published example; if the claim set " +
      "has drifted, authentication fails in exactly this way. Treat as UNVERIFIED, not unsupported.";
  }
  const localMintVerified =
    localMint.cells.find((cell) => cell.id === "read_own_prefix")?.outcome === "allowed";

  // -- derivation probe: is `prefixes` matched literally? --------------------
  const derivation = await runDerivationProbe(ctx, bucketA, matrixTtl);

  // -- mint rate: does a credential mint per tenant at request rate? ---------
  // Every non-2xx is now counted. A run where 18 of 20 mints 400'd used to
  // render as a clean two-sample latency with "0 throttled".
  const mintLatencies: number[] = [];
  let apiMintRateLimited = 0;
  let apiMintOtherFailures = 0;
  const apiMintFailureSamples: string[] = [];
  for (let index = 0; index < ctx.config.mintSamples; index += 1) {
    const started = performance.now();
    const mint = await ctx.client.mintTempCredentials({
      bucket: bucketA,
      permission: "object-read-only",
      ttlSeconds: matrixTtl,
      // A different prefix each time: production mints per tenant, and a
      // repeated prefix could take a cached path a per-tenant mint would not.
      prefixes: [`tenant-${index}/`],
    });
    if (mint.ok) {
      mintLatencies.push(performance.now() - started);
      continue;
    }
    if (mint.kind === "rate_limited") apiMintRateLimited += 1;
    else apiMintOtherFailures += 1;
    if (apiMintFailureSamples.length < 3) apiMintFailureSamples.push(failureSummary(mint));
  }

  let apiMintBurst: TempCredsResult["apiMintBurst"] = null;
  if (ctx.config.mintBurst > 0) {
    const started = performance.now();
    const burst = await Promise.all(
      Array.from({ length: ctx.config.mintBurst }, (_unused, index) =>
        ctx.client.mintTempCredentials({
          bucket: bucketA,
          permission: "object-read-only",
          ttlSeconds: matrixTtl,
          prefixes: [`burst-tenant-${index}/`],
        }),
      ),
    );
    const wallMs = performance.now() - started;
    const succeeded = burst.filter((call) => call.ok).length;
    const rateLimited = burst.filter((call) => !call.ok && call.kind === "rate_limited").length;
    const otherFailures = burst.length - succeeded - rateLimited;
    apiMintRateLimited += rateLimited;
    apiMintOtherFailures += otherFailures;
    for (const call of burst) {
      if (!call.ok && call.kind !== "rate_limited" && apiMintFailureSamples.length < 3) {
        apiMintFailureSamples.push(failureSummary(call));
      }
    }
    apiMintBurst = {
      concurrent: ctx.config.mintBurst,
      succeeded,
      rateLimited,
      otherFailures,
      wallMs: Math.round(wallMs),
      achievedMintsPerSecond: Number((succeeded / (wallMs / 1000)).toFixed(2)),
    };
  }

  const localStart = performance.now();
  const localIterations = 500;
  for (let index = 0; index < localIterations; index += 1) {
    await mintLocally({
      accountId: ctx.client.env.accountId,
      parentAccessKeyId: ctx.client.env.parentAccessKeyId,
      parentSecretAccessKey: ctx.client.env.parentSecretAccessKey,
      endpointHost: ctx.client.env.s3Host,
      bucket: bucketA,
      scope: "object-read-only",
      ttlSeconds: 900,
      prefixPaths: [`tenant-${index}/`],
    });
  }
  const localMintsPerSecond = Number(
    (localIterations / ((performance.now() - localStart) / 1000)).toFixed(0),
  );

  // -- optional: does the TTL actually expire? -------------------------------
  let expiryCheck = empty.expiryCheck;
  if (ctx.config.verifyExpiry) {
    if (minimumAcceptedTtlSeconds === null) {
      expiryCheck = { ran: false, ttlSeconds: null, deniedAfterExpiry: null, note: "no TTL was accepted" };
    } else if (minimumAcceptedTtlSeconds > ctx.config.maxExpiryWaitSeconds) {
      expiryCheck = {
        ran: false,
        ttlSeconds: minimumAcceptedTtlSeconds,
        deniedAfterExpiry: null,
        note:
          `skipped — the shortest accepted TTL (${minimumAcceptedTtlSeconds}s) exceeds ` +
          `--max-expiry-wait=${ctx.config.maxExpiryWaitSeconds}s`,
      };
    } else {
      const shortLived = await ctx.client.mintTempCredentials({
        bucket: bucketA,
        permission: "object-read-only",
        ttlSeconds: minimumAcceptedTtlSeconds,
        prefixes: ["tenant-a/"],
      });
      if (!shortLived.ok) {
        expiryCheck = {
          ran: false,
          ttlSeconds: minimumAcceptedTtlSeconds,
          deniedAfterExpiry: null,
          note: `mint failed: ${failureSummary(shortLived)}`,
        };
      } else {
        const before = await attemptCall(() =>
          ctx.client.getObject(shortLived.value, bucketA, "tenant-a/probe.txt"),
        );
        await sleep((minimumAcceptedTtlSeconds + 20) * 1000);
        const after = await attemptCall(() =>
          ctx.client.getObject(shortLived.value, bucketA, "tenant-a/probe.txt"),
        );
        // The object must still be there, or a 404 after the sleep would read
        // as "the credential expired" when it actually means "the fixture went".
        const presence = await parentPresence(ctx, bucketA, "tenant-a/probe.txt");
        const adjudicated = adjudicateExpiry({
          beforeOk: before.call.ok,
          beforeDetail: describe(before.call),
          afterOk: after.call.ok,
          afterStatus: after.call.status,
          afterKind: after.call.ok ? null : after.call.kind,
          afterExpiredShaped: !after.call.ok && isExpiredCredentialFailure(after.call),
          afterDetail: describe(after.call),
          objectStillPresent: presence.state,
        });
        expiryCheck = {
          ran: true,
          ttlSeconds: minimumAcceptedTtlSeconds,
          deniedAfterExpiry: adjudicated.deniedAfterExpiry,
          note: `before expiry: ${describe(before.call)}; after expiry: ${describe(after.call)} — ${adjudicated.note}`,
        };
      }
    }
  }

  // -- overall leg verdict: fold the two mint modes ---------------------------
  const combined = combineScopeMatrices([apiMint, localMint]);
  const caveats = [...combined.caveats];
  let verdict = combined.verdict;
  let headline = combined.headline;

  // An expiry that was OBSERVED not to hold undercuts the bounded-TTL half of
  // R10's blast-radius claim, so it downgrades a clean pass to a caveat.
  if (expiryCheck.ran && expiryCheck.deniedAfterExpiry === false) {
    caveats.push(
      "ttl_not_honoured — the credential still worked after its TTL elapsed. R10's 'bounded TTL' " +
        "blast-radius reduction does not hold on this evidence.",
    );
    if (verdict === "PASS") {
      verdict = "PASS_WITH_CAVEAT";
      headline = `${headline} WITH CAVEAT: the credential still worked after its TTL elapsed.`;
    }
  }

  return {
    verdict,
    reason: combined.reason,
    headline,
    caveats,
    modesVerified: combined.modesVerified,
    setupError: null,
    ttlLadder,
    minimumAcceptedTtlSeconds,
    matrixTtlSeconds: matrixTtl,
    apiMint,
    localMint,
    derivation,
    apiMintLatencyMs: stats(mintLatencies),
    apiMintAttempted: ctx.config.mintSamples,
    apiMintRateLimited,
    apiMintOtherFailures,
    apiMintFailureSamples,
    apiMintBurst,
    localMintsPerSecond,
    localMintVerified,
    expiryCheck,
  };
}

/**
 * Does R2 match `prefixes` literally, or on a path-component boundary?
 *
 * This is the hazard U2 actually hits: derive a prefix from a tenant id and
 * forget the trailing '/', and `tenant-a` may or may not also grant
 * `tenant-abc/`. The main matrix only ever mints slash-terminated prefixes, so
 * it cannot see this — yet the plan-impact text claimed "a derivation bug is now
 * caught by the platform". Now the claim is written from a measurement.
 *
 * Never gates the option verdict: correctly-formed prefixes are a different
 * question. It rewrites the plan-impact sentence instead.
 */
async function runDerivationProbe(
  ctx: Ctx,
  bucketA: string,
  ttlSeconds: number,
): Promise<DerivationResult> {
  const mint = await attemptCall(() =>
    ctx.client.mintTempCredentials({
      bucket: bucketA,
      permission: "object-read-only",
      ttlSeconds,
      // Deliberately NOT slash-terminated. This is the derivation bug, minted.
      prefixes: ["tenant-a"],
    }),
  );
  if (!mint.call.ok) {
    return {
      ran: false,
      finding: "inconclusive",
      consequence: derivationConsequence("inconclusive"),
      cells: [],
      mintError: failureSummary(mint.call),
    };
  }

  const credentials = mint.call.value;
  const own = await attemptCall(() => ctx.client.getObject(credentials, bucketA, "tenant-a/probe.txt"));
  const sibling = await attemptCall(() =>
    ctx.client.getObject(credentials, bucketA, "tenant-abc/probe.txt"),
  );
  const ownOutcome = classifyRead(own.call);
  const siblingOutcome = classifyRead(sibling.call);

  const cells: Cell[] = [
    cellFrom({
      id: "bare_prefix_read_own",
      what: `GET ${bucketA}/tenant-a/probe.txt with prefixes=["tenant-a"] (no trailing slash)`,
      expectation: "allow",
      call: own.call,
      outcome: ownOutcome,
      sideEffectCheck: "derivation probe — informational, does not gate the verdict",
      attempts: own.attempts,
      advisory: true,
    }),
    cellFrom({
      id: "bare_prefix_read_sibling",
      what: `GET ${bucketA}/tenant-abc/probe.txt with prefixes=["tenant-a"] (no trailing slash)`,
      expectation: "deny",
      call: sibling.call,
      outcome: siblingOutcome,
      sideEffectCheck:
        sibling.call.ok && sibling.call.value.includes(FIXTURE.sibling)
          ? "the response body IS the sibling tenant's fixture — the prefix matched literally"
          : "derivation probe — informational, does not gate the verdict",
      attempts: sibling.attempts,
      advisory: true,
    }),
  ];

  const finding = judgeDerivation(ownOutcome, siblingOutcome);
  return {
    ran: true,
    finding,
    consequence: derivationConsequence(finding),
    cells,
    mintError: null,
  };
}

// ---------------------------------------------------------------- cleanup

interface CleanupResult {
  bucketsSeen: number;
  bucketsDeleted: number;
  bucketsRemaining: string[];
  objectsDeleted: number;
  errors: string[];
  durationSeconds: number;
  statement: string;
}

async function purgeBucket(ctx: Ctx, bucket: string): Promise<{ deleted: number; errors: string[] }> {
  const parent = ctx.client.parentCredentials();
  const errors: string[] = [];
  let deleted = 0;

  const listing = await ctx.client.listObjects(parent, bucket, null);
  if (!listing.ok) {
    if (listing.status !== 404) errors.push(`list ${bucket}: ${failureSummary(listing)}`);
    return { deleted, errors };
  }
  for (const key of listing.value) {
    const call = await ctx.client.deleteObject(parent, bucket, key);
    if (call.ok) deleted += 1;
    else errors.push(`delete ${bucket}/${key}: ${failureSummary(call)}`);
  }
  return { deleted, errors };
}

async function cleanup(ctx: Ctx, names: string[]): Promise<CleanupResult> {
  const errors: string[] = [];
  const remaining: string[] = [];
  let bucketsDeleted = 0;
  let objectsDeleted = 0;
  const startedAt = performance.now();
  // Cleanup issues one REST DELETE per bucket into the same account-wide budget
  // the run just spent. Unpaced, a large ramp's cleanup throttles itself and
  // leaves buckets behind; --cleanup-rps keeps it inside the window.
  const intervalMs = ctx.config.cleanupRps > 0 ? 1000 / ctx.config.cleanupRps : 0;

  for (const bucket of names) {
    const tick = performance.now();
    // Hard guard: this probe never deletes a bucket it cannot prove it made.
    if (!bucket.startsWith(MANDATORY_BUCKET_PREFIX)) {
      errors.push(`refused to delete "${bucket}" — it does not carry the ${MANDATORY_BUCKET_PREFIX} prefix`);
      remaining.push(bucket);
      continue;
    }

    const purge = await purgeBucket(ctx, bucket);
    objectsDeleted += purge.deleted;
    errors.push(...purge.errors);

    let deleted = false;
    for (let attempt = 0; attempt < 5 && !deleted; attempt += 1) {
      const call = await ctx.client.deleteBucketRest(bucket);
      if (call.ok || call.status === 404) {
        deleted = true;
      } else if (call.kind === "rate_limited") {
        await sleep(Math.max(1000, (call.retryAfterSeconds ?? 2) * 1000));
      } else {
        errors.push(`delete bucket ${bucket}: ${failureSummary(call)}`);
        break;
      }
    }
    if (deleted) bucketsDeleted += 1;
    else remaining.push(bucket);

    const wait = intervalMs - (performance.now() - tick);
    if (wait > 0) await sleep(wait);
  }

  const statement =
    remaining.length === 0
      ? `Cleanup complete: ${bucketsDeleted} bucket(s) and ${objectsDeleted} object(s) created by this run were deleted. Nothing was left behind.`
      : `Cleanup INCOMPLETE: ${remaining.length} of ${names.length} bucket(s) survive (${bucketsDeleted} deleted, ${objectsDeleted} object(s) removed). Re-run "bun run probe:r2 --cleanup-only" to remove them; the run exits ${EXIT.CLEANUP_INCOMPLETE} so this cannot pass unnoticed.`;

  return {
    bucketsSeen: names.length,
    bucketsDeleted,
    bucketsRemaining: remaining,
    objectsDeleted,
    errors: errors.slice(0, 20),
    durationSeconds: Math.round((performance.now() - startedAt) / 1000),
    statement,
  };
}

// ------------------------------------------------------------------- verdicts

interface OptionVerdict {
  option: string;
  verdict: Verdict;
  headline: string;
  evidence: string[];
  planImpact: string[];
}

function judgeBucketPerTenant(
  inventory: InventoryResult | null,
  latency: LatencyPathResult[],
  rateLimit: RateLimitPathResult[],
  ramp: RampResult | null,
): OptionVerdict {
  if (inventory === null && latency.length === 0 && rateLimit.length === 0 && ramp === null) {
    return {
      option: "A. bucket-per-tenant",
      verdict: "SKIPPED",
      headline: "None of this option's legs were selected, so it was not evaluated.",
      evidence: [],
      planImpact: [],
    };
  }

  const evidence: string[] = [];
  const created = latency.reduce((total, entry) => total + entry.created, 0) +
    rateLimit.reduce((total, entry) => total + entry.succeeded, 0) +
    (ramp?.createdInThisRun ?? 0);
  const existing = inventory?.existingBuckets ?? 0;
  const provenHeadroom = existing + created;

  const baselineKnown = inventory !== null && inventory.verdict === "PASS";
  if (inventory && baselineKnown) {
    evidence.push(
      `Account held ${existing} bucket(s) before this run` +
        (inventory.countIsExact
          ? "."
          : " (LOWER BOUND — listing stopped at --max-list-pages, not a full inventory)."),
    );
  } else if (inventory) {
    evidence.push(
      `Bucket inventory could NOT be read (${inventory.verdict}): ${inventory.failure ?? inventory.note} ` +
        `The pre-run baseline is unknown, so the headroom figure below counts only what this run created.`,
    );
  }
  evidence.push(
    created === 0
      ? "This run created 0 buckets, so it proved no headroom at all."
      : `This run created ${created} bucket(s) without hitting a quota rejection, so proven headroom is ` +
        `>= ${provenHeadroom}${baselineKnown ? "" : " (created-only; pre-run baseline unread)"} against a ` +
        `${TARGET_TENANTS.toLocaleString("en-US")}-tenant target ` +
        `(${((provenHeadroom / TARGET_TENANTS) * 100).toFixed(1)}% of target proven).`,
  );
  for (const entry of latency) {
    if (entry.created === 0) {
      evidence.push(
        `Create via ${entry.path}: 0 of ${entry.attempted} succeeded — ${entry.failures[0] ?? "no error captured"}. ` +
          `No latency was measured on this path.`,
      );
      continue;
    }
    evidence.push(
      `Create latency via ${entry.path} (${entry.created}/${entry.attempted} succeeded): ` +
        `p50 ${entry.createMs.p50 ?? "-"}ms, p95 ${entry.createMs.p95 ?? "-"}ms; ` +
        `create-to-first-usable-write p50 ${entry.createToFirstWriteMs.p50 ?? "-"}ms, ` +
        `p95 ${entry.createToFirstWriteMs.p95 ?? "-"}ms` +
        (entry.writeNeverSucceeded > 0
          ? `; ${entry.writeNeverSucceeded} bucket(s) never accepted a write inside the timeout — ` +
            `the warm-pool figure is a LOWER bound.`
          : "."),
    );
  }
  for (const entry of rateLimit) {
    evidence.push(`${entry.path}: ${entry.interpretation}`);
  }
  if (ramp) {
    evidence.push(
      `Ramp to ${ramp.target} via ${ramp.path} ended as ${ramp.termination} after ${ramp.createdInThisRun} create(s) in ${ramp.elapsedSeconds}s.`,
    );
    if (ramp.terminalError) evidence.push(`    terminal error, verbatim: ${ramp.terminalError}`);
    if (ramp.corroborationDetail.length > 0) {
      evidence.push(
        `    quota corroboration (${ramp.corroborationAttempts} re-attempt(s) with fresh names): ` +
          ramp.corroborationDetail.join(" | "),
      );
    }
  }

  const authBlocked =
    latency.every((entry) => entry.verdict === "INCONCLUSIVE") && latency.length > 0 && created === 0;
  // "Its throughput envelope is measured" is only true if the number U15 sizes
  // the warm pool by actually exists.
  const warmPoolMeasured = latency.some((entry) => entry.createToFirstWriteMs.count > 0);

  let verdict: Verdict;
  let headline: string;
  if (ramp?.termination === "quota_ceiling_observed") {
    verdict = "FAIL";
    const at =
      ramp.quotaCeilingObservedAt !== null
        ? `at approximately ${ramp.quotaCeilingObservedAt} bucket(s)`
        : `after ${ramp.quotaCeilingLowerBound ?? 0} create(s) IN THIS RUN — the pre-run baseline was ` +
          `not read exactly, so the account-wide number is unknown and is NOT the figure below`;
    headline =
      `A quota ceiling was OBSERVED ${at} — below the ` +
      `${TARGET_TENANTS.toLocaleString("en-US")}-tenant target. The rejection was re-attempted ` +
      `${ramp.corroborationAttempts} time(s) with fresh bucket names and repeated each time. ` +
      `Cloudflare's own words: "${ramp.terminalError ?? "(not captured)"}". Read that message before ` +
      `acting: this verdict rests on a text classifier, and a per-bucket or billing limit can be ` +
      `worded like an account ceiling. Bucket-per-tenant needs a limit increase in writing before it ` +
      `can be chosen.`;
  } else if (ramp?.termination === "quota_uncorroborated") {
    verdict = "INCONCLUSIVE";
    headline =
      `A create was rejected with quota-shaped wording, but the rejection did NOT repeat when ` +
      `re-attempted (${ramp.corroborationDetail.join(" | ")}). That is not an account ceiling — it is ` +
      `an unexplained one-off. Cloudflare's words: "${ramp.terminalError ?? "(not captured)"}". Re-run ` +
      `the ramp before treating this as a limit.`;
  } else if (authBlocked || created === 0) {
    verdict = "INCONCLUSIVE";
    headline =
      "No bucket was created, so nothing about the operational envelope was measured. Check the " +
      "token's R2 permissions before reading this as a limit.";
  } else {
    verdict = "NOT_OBSERVED";
    headline =
      `Bucket creation works` +
      (warmPoolMeasured
        ? ` and its throughput envelope is measured`
        : ` but NO create-to-first-usable-write sample was captured, so the number U15's warm pool is ` +
          `sized by is MISSING from this run`) +
      `, and NO quota ceiling was observed — because the account quota is not exposed by any R2 API. ` +
      `Proven headroom is >= ${provenHeadroom}; the ${TARGET_TENANTS.toLocaleString("en-US")}-tenant ` +
      `target is NOT proven by this run and must be confirmed by Cloudflare in writing.`;
  }

  return {
    option: "A. bucket-per-tenant",
    verdict,
    headline,
    evidence,
    planImpact: [
      "Choosing A makes R9's R2 boundary structural in the same sense as Neon's: one bucket, one tenant, verifiable by name.",
      "R10 loses the fleet-wide object credential from its blast radius only if the fleet holds a per-bucket credential rather than an account-wide one — bucket-per-tenant alone does not remove it.",
      "U2's storage accessor still owes the path-traversal guard (a Drive filename containing '../' is a real object), but a traversal can no longer cross a TENANT boundary.",
      "U15's warm pool is sized by the create-to-first-usable-write p95 above, and its refill rate by the observed bucket-management throughput.",
      `BLOCKING before this option can be chosen: the account bucket quota, in writing. Cloudflare documents ${DOCUMENTED.bucketsPerAccount.toLocaleString("en-US")} per account (${DOCUMENTED.limitsDoc}) but accounts start lower; request an increase via ${DOCUMENTED.limitIncreaseForm} and record the date and answer in RESULT.md.`,
    ],
  };
}

function judgeTempCreds(temp: TempCredsResult | null): OptionVerdict {
  if (temp === null) {
    return {
      option: "B. prefix-scoped temporary credentials",
      verdict: "SKIPPED",
      headline: "The tempcreds leg did not run.",
      evidence: [],
      planImpact: [],
    };
  }

  const evidence: string[] = [];
  if (temp.setupError) evidence.push(`Setup: ${temp.setupError}`);
  evidence.push(
    `TTL ladder: ${temp.ttlLadder
      .map(
        (entry) =>
          `${entry.ttlSeconds}s ${entry.accepted ? "accepted" : entry.attributable ? "rejected" : "UNATTRIBUTABLE"}`,
      )
      .join(", ")}` +
      (temp.minimumAcceptedTtlSeconds === null
        ? " — no TTL accepted."
        : ` — shortest accepted TTL is ${temp.minimumAcceptedTtlSeconds}s.`) +
      (temp.matrixTtlSeconds === null
        ? ""
        : ` The scope matrix itself was minted at ${temp.matrixTtlSeconds}s (deliberately not the ` +
          `shortest, so the credential cannot expire mid-matrix and be mistaken for a denial).`),
  );
  for (const matrix of [temp.apiMint, temp.localMint]) {
    if (!matrix) continue;
    evidence.push(`${matrix.mintMode} mint: ${matrix.verdict} — ${matrix.reason}`);
    if (matrix.mintError) evidence.push(`    mint error, verbatim: ${matrix.mintError}`);
    for (const cell of matrix.cells) {
      const label = !cell.attributable
        ? "UNATTRIBUTABLE"
        : cell.matchesExpectation
          ? "as expected"
          : cell.advisory
            ? "ADVISORY-HIT"
            : "UNEXPECTED";
      evidence.push(
        `    ${label}  ${cell.id} (expect ${cell.expectation}) -> ${cell.outcome} ` +
          `[HTTP ${cell.status}${cell.attempts > 1 ? `, ${cell.attempts} attempts` : ""}]` +
          (cell.unattributableReason ? ` — NOT EVIDENCE: ${cell.unattributableReason}` : "") +
          (cell.sideEffectCheck ? ` — ${cell.sideEffectCheck}` : ""),
      );
    }
  }
  if (temp.derivation) {
    evidence.push(
      `Prefix-derivation probe (a credential scoped to "tenant-a" with NO trailing slash): ` +
        `${temp.derivation.finding}` +
        (temp.derivation.mintError ? ` — mint failed: ${temp.derivation.mintError}` : ""),
    );
    for (const cell of temp.derivation.cells) {
      evidence.push(
        `    ${cell.attributable ? cell.outcome : "UNATTRIBUTABLE"}  ${cell.id} [HTTP ${cell.status}]` +
          (cell.sideEffectCheck ? ` — ${cell.sideEffectCheck}` : ""),
      );
    }
  }
  const mintSucceeded = temp.apiMintLatencyMs.count;
  evidence.push(
    `API mint rate: ${mintSucceeded}/${temp.apiMintAttempted} sequential mints succeeded ` +
      `(${temp.apiMintRateLimited} throttled, ${temp.apiMintOtherFailures} failed for other reasons)` +
      (mintSucceeded > 0
        ? `; latency p50 ${temp.apiMintLatencyMs.p50 ?? "-"}ms, p95 ${temp.apiMintLatencyMs.p95 ?? "-"}ms.`
        : ` — NO latency was measured, so this run says nothing about mint latency.`),
  );
  for (const sample of temp.apiMintFailureSamples) evidence.push(`    mint failure sample: ${sample}`);
  if (temp.apiMintBurst) {
    evidence.push(
      `API mint burst: ${temp.apiMintBurst.succeeded}/${temp.apiMintBurst.concurrent} concurrent mints ` +
        `succeeded in ${temp.apiMintBurst.wallMs}ms (${temp.apiMintBurst.achievedMintsPerSecond}/s), ` +
        `${temp.apiMintBurst.rateLimited} throttled, ${temp.apiMintBurst.otherFailures} other failures.`,
    );
  }
  if (temp.localMintsPerSecond !== null) {
    evidence.push(
      temp.localMintVerified
        ? `Local (no-API) minting ran at ~${temp.localMintsPerSecond}/s in-process — no network call, ` +
          `so it spends none of the ${DOCUMENTED.restApiRequestsPerFiveMinutes}-per-5-minute R2 REST budget.`
        : `Local minting produced ~${temp.localMintsPerSecond} credential(s)/s in-process, but the ` +
          `locally-minted credential NEVER AUTHENTICATED against R2 in this run, so that number ` +
          `measures crypto throughput, not a working mint path. Do not quote it as a mint rate.`,
    );
  }
  evidence.push(`Expiry check: ${temp.expiryCheck.note}`);
  for (const caveat of temp.caveats) evidence.push(`CAVEAT: ${caveat}`);

  const derivationImpact =
    temp.derivation === null
      ? derivationConsequence("inconclusive")
      : temp.derivation.consequence;

  return {
    option: "B. prefix-scoped temporary credentials",
    verdict: temp.verdict,
    // A setup failure means no credential was ever pointed at anything, which
    // the headline must say rather than describing the scope as "untested".
    headline: temp.setupError ? `The scope was never tested. ${temp.reason}` : temp.headline,
    evidence,
    planImpact: [
      "Choosing B fences access at the platform without bucket-per-user, and needs no bucket-quota answer at all — the quota question above stops being blocking.",
      "R10's blast radius: the fleet still holds the PARENT credential, so the register entry changes from 'fleet-wide object credential on the request path' to 'parent credential held outside the request path, request path holds a per-tenant credential with a bounded TTL'. That is a real reduction only if the parent key is not resolvable by the request-path identity (same rule R11 applies to connection strings).",
      `U2's key-derivation guard: ${derivationImpact}`,
      `U16's attestation may report R2 as enforced rather than conventional — scoped to the mint mode(s) actually verified here (${temp.modesVerified.length > 0 ? temp.modesVerified.join(", ") : "none"}), and no wider.`,
      "Local (JWT) minting, if verified, removes the mint from the R2 REST budget entirely and makes per-request minting a non-question. If only the API mint verified, the mint rate above is the ceiling on the request path and a per-tenant credential cache with a TTL shorter than the credential's own is the mitigation.",
    ],
  };
}

// ------------------------------------------------------------------ rendering

/**
 * Redaction is applied to STRINGS, late, rather than only to the fields the
 * probe happens to build itself — because the strings most likely to carry an
 * account id are the ones the probe did not write: Cloudflare's own error
 * messages, which ride verbatim into every evidence line by design.
 */
export function makeRedactor(replacements: Array<[string, string]>): (text: string) => string {
  const pairs = replacements
    .filter(([needle]) => needle.length >= 8)
    .sort(([left], [right]) => right.length - left.length);
  return (text: string): string => {
    let out = text;
    for (const [needle, token] of pairs) out = out.split(needle).join(token);
    return out;
  };
}

/** Credentials only. Applied to terminal output and to the JSON report. */
function secretsRedactor(env: R2Env): (text: string) => string {
  return makeRedactor([
    [env.apiToken, "<R2_API_TOKEN>"],
    [env.parentSecretAccessKey, "<R2_SECRET_ACCESS_KEY>"],
    [env.parentAccessKeyId, "<R2_ACCESS_KEY_ID>"],
  ]);
}

/**
 * Credentials AND account identifiers AND bucket names. Applied to the paste
 * block, which is the only output destined for a file in a public repo.
 */
function publicRedactor(env: R2Env): (text: string) => string {
  const base = makeRedactor([
    [env.apiToken, "<R2_API_TOKEN>"],
    [env.parentSecretAccessKey, "<R2_SECRET_ACCESS_KEY>"],
    [env.parentAccessKeyId, "<R2_ACCESS_KEY_ID>"],
    [env.s3Host, "<R2_S3_ENDPOINT>"],
    [env.accountId, "<R2_ACCOUNT_ID>"],
  ]);
  const bucketPattern = new RegExp(
    `${env.bucketPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z0-9-]*`,
    "g",
  );
  return (text: string): string => base(text).replace(bucketPattern, "<probe-bucket>");
}

function renderHuman(report: Record<string, unknown>, options: OptionVerdict[], lines: string[]): string {
  const out: string[] = [];
  out.push("");
  out.push("=".repeat(78));
  out.push("R2 STORAGE-BOUNDARY PROBE — R9 / R10 / Gap Register #15");
  out.push("=".repeat(78));
  out.push(...lines);
  out.push("");
  for (const option of options) {
    out.push("-".repeat(78));
    out.push(`${option.option}:  ${option.verdict}`);
    out.push("-".repeat(78));
    out.push(`  ${option.headline}`);
    if (option.evidence.length > 0) {
      out.push("");
      out.push("  Evidence:");
      for (const item of option.evidence) out.push(`    - ${item}`);
    }
    if (option.planImpact.length > 0) {
      out.push("");
      out.push("  What this means for the plan:");
      for (const item of option.planImpact) out.push(`    * ${item}`);
    }
    out.push("");
  }
  const counters = report["callBudget"];
  if (counters) out.push(`Call budget used: ${JSON.stringify(counters)}`);
  return out.join("\n");
}

/**
 * The block the README tells you to paste into RESULT.md — i.e. the committed
 * artefact of record, from which "THE DECISION" and U16's attestation wording
 * get written.
 *
 * It used to emit `verdict` + `headline` and nothing else, so every qualifier
 * that made the verdict conditional — which mint mode was actually verified,
 * any caveat that was outranked away, which cells produced no attributable
 * answer — was dropped on the way to the file people read later.
 */
function pasteBlock(
  report: Record<string, unknown>,
  options: OptionVerdict[],
  temp: TempCredsResult | null,
  exitCode: number,
  cleanupStatement: string,
  redactPublic: (text: string) => string,
): string {
  const lines: string[] = [];
  lines.push("```");
  lines.push(`run_id:        ${String(report["runId"])}`);
  lines.push(`ran_at:        ${String(report["startedAt"])}`);
  lines.push(`exit_code:     ${exitCode}`);
  for (const option of options) {
    lines.push(`${option.option}`);
    lines.push(`  verdict:     ${option.verdict}`);
    lines.push(`  headline:    ${redactPublic(option.headline)}`);
  }
  if (temp) {
    lines.push("Option B qualifiers (do not drop these — the verdict is conditional on them)");
    lines.push(`  mint modes verified: ${temp.modesVerified.length > 0 ? temp.modesVerified.join(", ") : "NONE"}`);
    lines.push(
      `  local mint:  ${temp.localMintVerified ? "authenticated" : "did NOT authenticate — UNVERIFIED, not unsupported"}`,
    );
    lines.push(`  prefix derivation: ${temp.derivation?.finding ?? "not run"}`);
    lines.push(`  reason:      ${redactPublic(temp.reason)}`);
    const matrices = [temp.apiMint, temp.localMint].filter(
      (matrix): matrix is ScopeMatrix => matrix !== null,
    );
    // Advisory cells are listed separately: the dot-dot cell is EXPECTED to be
    // undeliverable, and mixing it in here would make every clean run look as
    // though something had gone wrong.
    const unattributable = matrices.flatMap((matrix) =>
      matrix.cells
        .filter((cell) => !cell.attributable && !cell.advisory)
        .map((cell) => `${matrix.mintMode}:${cell.id} (${cell.unattributableReason ?? "unknown"})`),
    );
    lines.push(
      `  unattributable cells: ${unattributable.length === 0 ? "none" : redactPublic(unattributable.join("; "))}`,
    );
    const advisory = matrices.flatMap((matrix) =>
      matrix.cells
        .filter((cell) => cell.advisory)
        .map((cell) => `${matrix.mintMode}:${cell.id}=${cell.outcome}`),
    );
    lines.push(`  traversal probes: ${advisory.length === 0 ? "not run" : advisory.join(", ")}`);
    for (const caveat of temp.caveats) lines.push(`  caveat:      ${redactPublic(caveat)}`);
  }
  lines.push(`cleanup:       ${redactPublic(cleanupStatement)}`);
  lines.push("```");
  return lines.join("\n");
}

// ------------------------------------------------------------------ self-test

/**
 * Offline verification of the probe's own machinery — no credentials, no
 * network, no account touched.
 *
 * This exists because of the probe's central asymmetry: a bug in the signer or
 * in the local-mint derivation denies every request, which is indistinguishable
 * from flawless isolation. The runtime positive control is the primary guard;
 * this is the one you can run first, for free, so that an INCONCLUSIVE result
 * later has a known-good starting point.
 *
 * The SigV4 vector is AWS's own published "GET Bucket Lifecycle" example. Its
 * SignedHeaders (host;x-amz-content-sha256;x-amz-date) are exactly the set this
 * signer emits, which is why it is the usable vector. The expected
 * canonical-request digest below is the value AWS publishes; the expected
 * signature was additionally cross-checked against an independent HMAC
 * implementation (node:crypto) driven by the same string-to-sign.
 */
interface SelfTestCase {
  name: string;
  ok: boolean;
  detail: string;
}

const AWS_VECTOR = {
  canonicalRequestSha256: "9766c798316ff2757b517bc739a67f6213b4ab36dd5da2f94eaebf79c77395ca",
  signature: "964c7e476ea67fd0dbe754c179c24b69f45f4484575238740e4eef8ee26697ff",
} as const;

async function runSelfTest(): Promise<SelfTestCase[]> {
  const cases: SelfTestCase[] = [];

  const signed = await signS3Request({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    segments: [],
    query: { lifecycle: "" },
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    },
    region: "us-east-1",
    now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });

  const digest = await sha256Hex(signed.canonicalRequest);
  cases.push({
    name: "sigv4 canonical request matches AWS's published digest",
    ok: digest === AWS_VECTOR.canonicalRequestSha256,
    detail: `computed ${digest}`,
  });

  const signature = /Signature=([0-9a-f]+)/.exec(signed.headers["authorization"] ?? "")?.[1] ?? "";
  cases.push({
    name: "sigv4 signature matches the AWS vector",
    ok: signature === AWS_VECTOR.signature,
    detail: `computed ${signature || "(none)"}`,
  });

  cases.push({
    name: "rfc3986 encodes separators and sub-delims that encodeURIComponent leaves raw",
    ok: rfc3986("a/b c!'()*") === "a%2Fb%20c%21%27%28%29%2A",
    detail: rfc3986("a/b c!'()*"),
  });

  const minted = await mintLocally({
    accountId: "account",
    parentAccessKeyId: "parent-key-id",
    parentSecretAccessKey: "parent-secret",
    endpointHost: "account.r2.cloudflarestorage.com",
    bucket: "bucket",
    scope: "object-read-write",
    ttlSeconds: 900,
    prefixPaths: ["tenant-a/"],
    now: new Date(Date.UTC(2026, 0, 1)),
  });
  const decodedSession = atob(minted.credentials.sessionToken ?? "");
  const jwt = decodedSession.slice("jwt/".length);
  const parts = jwt.split(".");
  const headerJson = parts[0] ?? "";
  const decodedHeader = atob(headerJson.replace(/-/g, "+").replace(/_/g, "/"));
  cases.push({
    name: "local mint: session token is base64(\"jwt/\" + jwt) over a three-part HS256 JWT",
    ok: decodedSession.startsWith("jwt/") && parts.length === 3 && decodedHeader.includes('"HS256"'),
    detail: `${parts.length} JWT part(s), header ${decodedHeader}`,
  });
  cases.push({
    name: "local mint: secret access key is the SHA-256 hex digest of the JWT",
    ok: minted.credentials.secretAccessKey === (await sha256Hex(jwt)),
    detail: `${minted.credentials.secretAccessKey.slice(0, 16)}…`,
  });
  cases.push({
    name: "local mint: access key id is the parent's, and the prefix scope is carried",
    ok:
      minted.credentials.accessKeyId === "parent-key-id" &&
      JSON.stringify(minted.claims["paths"]) === JSON.stringify({ prefixPaths: ["tenant-a/"], objectPaths: [] }),
    detail: JSON.stringify(minted.claims["paths"]),
  });

  // The classifier is what keeps a throughput answer from being reported as a
  // viability answer, so its ordering is pinned here rather than trusted.
  const classifications: Array<[number, string | null, string, FailureKind]> = [
    [429, "10000", "Rate limit exceeded", "rate_limited"],
    [200, "SlowDown", "Please reduce your request rate", "rate_limited"],
    [403, "10001", "You have reached the maximum number of buckets for this account", "quota"],
    [403, "AccessDenied", "Access Denied", "auth"],
    [401, null, "Invalid API token", "auth"],
    [409, "BucketAlreadyOwnedByYou", "bucket already exists", "conflict"],
    [404, "NoSuchKey", "The specified key does not exist", "not_found"],
  ];
  for (const [status, code, message, expected] of classifications) {
    const actual = classifyFailure(status, code, message);
    cases.push({
      name: `classify(${status}, ${code ?? "-"}) -> ${expected}`,
      ok: actual === expected,
      detail: `got ${actual}`,
    });
  }

  // ---- the mapping layer, which the self-test used to be unable to reach ----
  //
  // `classifyRead` and `cellFrom` are where the reproduced false positive was
  // manufactured, and the old self-test's `cell()` helper HAND-DUPLICATED
  // `cellFrom`'s formula instead of calling it — so the suite could pass while
  // the real function scored a transport error as a satisfied denial. These
  // cases call the real functions.
  const okCall = (status = 200, value = ""): Call<string> => ({ ok: true, status, value, ms: 1 });
  const failCall = (
    status: number,
    kind: FailureKind,
    code: string | null = null,
    message = "",
  ): CallFailure => ({
    ok: false,
    status,
    kind,
    code,
    message,
    retryAfterSeconds: null,
    ms: 1,
    raw: "",
  });

  const readClassifications: Array<[string, Call<string>, CellOutcome]> = [
    ["a fetch throw (status 0)", failCall(0, "network", null, "ConnectionRefused"), "unattributable"],
    ["a 429", failCall(429, "rate_limited", "10000", "Rate limit exceeded"), "unattributable"],
    ["a 503", failCall(503, "other", null, "Service Unavailable"), "unattributable"],
    [
      "an expired credential",
      failCall(403, "auth", "ExpiredToken", "The provided token has expired"),
      "unattributable",
    ],
    ["a path the client rewrote", failCall(0, "other", CLIENT_CODES.pathNormalised, "not sent"), "unattributable"],
    ["a real 403", failCall(403, "auth", "AccessDenied", "Access Denied"), "denied_403"],
    ["a 404", failCall(404, "not_found", "NoSuchKey", "no such key"), "denied_404_obscured"],
    ["a 200", okCall(), "allowed"],
  ];
  for (const [name, call, expected] of readClassifications) {
    const actual = classifyRead(call);
    cases.push({
      name: `classifyRead: ${name} -> ${expected}`,
      ok: actual === expected,
      detail: `got ${actual}`,
    });
  }

  const transportCell = cellFrom({
    id: "read_other_prefix",
    what: "GET other",
    expectation: "deny",
    call: failCall(0, "network", null, "The socket connection was closed unexpectedly"),
    outcome: classifyRead(failCall(0, "network", null, "closed")),
    sideEffectCheck: null,
    attempts: 3,
  });
  cases.push({
    name: "cellFrom: a transport error on a DENY cell does not satisfy the expectation",
    ok: transportCell.matchesExpectation === false && transportCell.attributable === false,
    detail: `matchesExpectation=${transportCell.matchesExpectation} attributable=${transportCell.attributable}`,
  });
  const deniedCell = cellFrom({
    id: "read_other_prefix",
    what: "GET other",
    expectation: "deny",
    call: failCall(403, "auth", "AccessDenied", "Access Denied"),
    outcome: "denied_403",
    sideEffectCheck: null,
    attempts: 1,
  });
  cases.push({
    name: "cellFrom: a real 403 on a DENY cell DOES satisfy the expectation",
    ok: deniedCell.matchesExpectation === true && deniedCell.attributable === true,
    detail: `matchesExpectation=${deniedCell.matchesExpectation}`,
  });

  cases.push({
    name: "isTransient: a 429 is retried, a 403 is not",
    ok:
      isTransient(failCall(429, "rate_limited")) &&
      isTransient(failCall(0, "network")) &&
      isTransient(failCall(500, "other")) &&
      !isTransient(failCall(403, "auth")) &&
      !isTransient(failCall(0, "other", CLIENT_CODES.pathNormalised)),
    detail: "429/0/5xx retried; 403 and a client-side normalisation are not",
  });

  // The verdict logic is where a false pass or a false fail would actually be
  // manufactured, and a live run only ever exercises the one branch it lands
  // in. Every branch is pinned here instead, against synthetic matrices.
  const callFor = (outcome: CellOutcome): Call<string> =>
    outcome === "allowed"
      ? okCall()
      : outcome === "unattributable"
        ? failCall(0, "network", null, "connection reset")
        : outcome === "denied_404_obscured"
          ? failCall(404, "not_found", "NoSuchKey", "no such key")
          : failCall(403, "auth", "AccessDenied", "Access Denied");

  const cell = (
    id: string,
    expectation: "allow" | "deny",
    outcome: CellOutcome,
    advisory = false,
  ): Cell =>
    cellFrom({
      id,
      what: id,
      expectation,
      call: callFor(outcome),
      outcome,
      sideEffectCheck: null,
      attempts: 1,
      advisory,
    });

  const cleanMatrix = (): Cell[] => [
    cell("read_own_prefix", "allow", "allowed"),
    cell("write_own_prefix", "allow", "allowed"),
    cell("read_other_prefix", "deny", "denied_403"),
    cell("write_other_prefix", "deny", "denied_403"),
    cell("delete_other_prefix", "deny", "denied_403"),
    cell("list_other_prefix", "deny", "denied_403"),
    cell("list_bucket_unscoped", "deny", "denied_403"),
    cell("read_other_bucket", "deny", "denied_403"),
  ];
  const replace = (id: string, outcome: CellOutcome): Cell[] =>
    cleanMatrix().map((entry) => (entry.id === id ? cell(id, entry.expectation, outcome) : entry));
  const noLeak: LeakCounts = { listOtherPrefixKeys: 0, unscopedListKeys: 0, distinctLeakedKeys: 0 };

  const verdictCases: Array<[string, Cell[], LeakCounts, Verdict]> = [
    ["everything denied, nothing enumerable", cleanMatrix(), noLeak, "PASS"],
    [
      "objects fenced but keys enumerable -> caveat, NOT a fail",
      replace("list_bucket_unscoped", "allowed"),
      { listOtherPrefixKeys: 0, unscopedListKeys: 2, distinctLeakedKeys: 2 },
      "PASS_WITH_CAVEAT",
    ],
    ["a cross-tenant read succeeds -> fail", replace("read_other_prefix", "allowed"), noLeak, "FAIL"],
    [
      "a denied write that took effect -> fail",
      replace("write_other_prefix", "denied_but_took_effect"),
      noLeak,
      "FAIL",
    ],
    [
      "positive control failed -> inconclusive, never fail",
      replace("read_own_prefix", "denied_403"),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "permission control failed -> inconclusive, never pass",
      replace("write_own_prefix", "denied_403"),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "broken signer denies EVERYTHING -> inconclusive, never pass",
      cleanMatrix().map((entry) => cell(entry.id, entry.expectation, "denied_403")),
      noLeak,
      "INCONCLUSIVE",
    ],
    // THE REPRODUCED FALSE POSITIVE. One network blip on one cross-tenant cell
    // used to leave zero violations and yield PASS with the reason "every
    // cross-tenant read ... was denied with no side effect".
    [
      "a transport error on ONE cross-tenant cell -> inconclusive, never pass",
      replace("read_other_prefix", "unattributable"),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "a total blackout on every cross-tenant cell -> inconclusive, never pass",
      cleanMatrix().map((entry) =>
        entry.expectation === "deny" ? cell(entry.id, "deny", "unattributable") : entry,
      ),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "an unattributable positive control -> inconclusive",
      replace("read_own_prefix", "unattributable"),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "a real violation outranks an unattributable cell elsewhere -> fail",
      replace("read_other_prefix", "allowed").map((entry) =>
        entry.id === "read_other_bucket" ? cell(entry.id, "deny", "unattributable") : entry,
      ),
      noLeak,
      "FAIL",
    ],
    [
      "objects fenced but the list cells were unattributable -> caveat, not a clean pass",
      replace("list_bucket_unscoped", "unattributable"),
      noLeak,
      "PASS_WITH_CAVEAT",
    ],
    [
      "a cross-tenant cell is missing entirely -> inconclusive",
      cleanMatrix().filter((entry) => entry.id !== "delete_other_prefix"),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "an ADVISORY traversal cell that SUCCEEDS is still a fail",
      [...cleanMatrix(), cell("read_other_prefix_encoded_traversal", "deny", "allowed", true)],
      noLeak,
      "FAIL",
    ],
    [
      "an ADVISORY traversal cell that could not be delivered does NOT block a pass",
      [...cleanMatrix(), cell("read_other_prefix_dotdot", "deny", "unattributable", true)],
      noLeak,
      "PASS",
    ],
  ];
  for (const [name, matrix, leak, expected] of verdictCases) {
    const actual = decideScopeVerdict(matrix, leak);
    cases.push({
      name: `scope verdict: ${name} -> ${expected}`,
      ok: actual.verdict === expected,
      detail: `got ${actual.verdict} — ${actual.reason.slice(0, 90)}…`,
    });
  }

  // ---- folding the two mint modes, and the exit code it produces -----------
  const matrixOf = (
    mintMode: "api" | "local",
    verdict: Verdict,
    options: { ran?: boolean; throttled?: boolean } = {},
  ): ScopeMatrix => ({
    mintMode,
    verdict,
    reason: `${mintMode} reason`,
    cells: options.ran === false ? [] : cleanMatrix(),
    enumerationLeak: false,
    enumerationTested: options.ran !== false,
    keysVisibleToUnscopedList: [],
    mintError: options.ran === false ? "HTTP 429 [rate_limited] 10000: Rate limit exceeded" : null,
    mintThrottled: options.throttled ?? false,
  });

  const combineCases: Array<[string, ScopeMatrix[], Verdict]> = [
    ["both modes clean -> pass", [matrixOf("api", "PASS"), matrixOf("local", "PASS")], "PASS"],
    // THE EXIT-CODE LAUNDERING BUG: a throttled mint used to rank RATE_LIMITED
    // above INCONCLUSIVE, win, and carry the run to exit 0.
    [
      "the api mint was throttled and the local matrix is inconclusive -> inconclusive, never rate_limited",
      [matrixOf("api", "INCONCLUSIVE", { ran: false, throttled: true }), matrixOf("local", "INCONCLUSIVE")],
      "INCONCLUSIVE",
    ],
    [
      "no matrix ran at all -> inconclusive",
      [
        matrixOf("api", "INCONCLUSIVE", { ran: false, throttled: true }),
        matrixOf("local", "INCONCLUSIVE", { ran: false }),
      ],
      "INCONCLUSIVE",
    ],
    // A caveat observed in one mode must not be outranked away by a clean
    // result in the other; the committed record is written from this verdict.
    [
      "api enumerable + local clean -> the caveat survives",
      [matrixOf("api", "PASS_WITH_CAVEAT"), matrixOf("local", "PASS")],
      "PASS_WITH_CAVEAT",
    ],
    [
      "local mint unfenced but the API mint held -> caveat, not scope_not_enforced",
      [matrixOf("api", "PASS"), matrixOf("local", "FAIL")],
      "PASS_WITH_CAVEAT",
    ],
    [
      "the API mint itself is unfenced -> fail",
      [matrixOf("api", "FAIL"), matrixOf("local", "PASS")],
      "FAIL",
    ],
    [
      "local unfenced and the API mint never ran -> inconclusive, do not condemn the API path",
      [matrixOf("api", "INCONCLUSIVE", { ran: false }), matrixOf("local", "FAIL")],
      "INCONCLUSIVE",
    ],
    // A pass resting only on the mode this probe cannot independently verify is
    // a real result, but not a clean one.
    [
      "only the local mint settled -> caveat, not a clean pass",
      [matrixOf("api", "INCONCLUSIVE"), matrixOf("local", "PASS")],
      "PASS_WITH_CAVEAT",
    ],
    [
      "the API mint held and only the local mint is unverified -> still a clean pass",
      [matrixOf("api", "PASS"), matrixOf("local", "INCONCLUSIVE")],
      "PASS",
    ],
  ];
  for (const [name, matrices, expected] of combineCases) {
    const actual = combineScopeMatrices(matrices);
    cases.push({
      name: `mint-mode fold: ${name} -> ${expected}`,
      ok: actual.verdict === expected,
      detail: `got ${actual.verdict} — ${actual.reason.slice(0, 90)}…`,
    });
  }

  const exitCases: Array<[string, Parameters<typeof exitCodeFor>[0], number]> = [
    [
      "clean run",
      { crashed: false, verdicts: ["NOT_OBSERVED", "PASS"], cleanupIncomplete: false },
      EXIT.ANSWERED,
    ],
    ["hard fail", { crashed: false, verdicts: ["NOT_OBSERVED", "FAIL"], cleanupIncomplete: false }, EXIT.FAIL],
    [
      "an option that could not be settled must NOT exit 0",
      { crashed: false, verdicts: ["NOT_OBSERVED", "INCONCLUSIVE"], cleanupIncomplete: false },
      EXIT.NOT_SETTLED,
    ],
    [
      "a rate-limited option is 'not settled', not 'answered'",
      { crashed: false, verdicts: ["NOT_OBSERVED", "RATE_LIMITED"], cleanupIncomplete: false },
      EXIT.NOT_SETTLED,
    ],
    [
      "a crash mid-flight",
      { crashed: true, verdicts: ["SKIPPED", "SKIPPED"], cleanupIncomplete: false },
      EXIT.NOT_SETTLED,
    ],
    [
      "answered, but buckets survive",
      { crashed: false, verdicts: ["NOT_OBSERVED", "PASS"], cleanupIncomplete: true },
      EXIT.CLEANUP_INCOMPLETE,
    ],
    [
      "a skipped option does not affect the exit code",
      { crashed: false, verdicts: ["SKIPPED", "PASS"], cleanupIncomplete: false },
      EXIT.ANSWERED,
    ],
  ];
  for (const [name, input, expected] of exitCases) {
    const actual = exitCodeFor(input);
    cases.push({ name: `exit code: ${name} -> ${expected}`, ok: actual === expected, detail: `got ${actual}` });
  }

  // ---- expiry adjudication -------------------------------------------------
  const expiryBase = {
    beforeOk: true,
    beforeDetail: "HTTP 200 ok",
    afterExpiredShaped: false,
    afterDetail: "-",
    objectStillPresent: "present" as Presence,
  };
  const expiryCases: Array<[string, Parameters<typeof adjudicateExpiry>[0], boolean | null]> = [
    [
      "a real expiry denial",
      { ...expiryBase, afterOk: false, afterStatus: 403, afterKind: "auth", afterExpiredShaped: true },
      true,
    ],
    [
      "a transport error after the sleep is NOT proof of expiry",
      { ...expiryBase, afterOk: false, afterStatus: 0, afterKind: "network" },
      null,
    ],
    [
      "a 429 after the sleep is NOT proof of expiry",
      { ...expiryBase, afterOk: false, afterStatus: 429, afterKind: "rate_limited" },
      null,
    ],
    [
      "a 404 whose object vanished is NOT proof of expiry",
      {
        ...expiryBase,
        afterOk: false,
        afterStatus: 404,
        afterKind: "not_found",
        objectStillPresent: "absent" as Presence,
      },
      null,
    ],
    [
      "no pre-expiry control means nothing to compare",
      { ...expiryBase, beforeOk: false, afterOk: false, afterStatus: 403, afterKind: "auth" },
      null,
    ],
    [
      "the credential still worked after its TTL",
      { ...expiryBase, afterOk: true, afterStatus: 200, afterKind: null },
      false,
    ],
  ];
  for (const [name, input, expected] of expiryCases) {
    const actual = adjudicateExpiry(input);
    cases.push({
      name: `expiry: ${name} -> ${String(expected)}`,
      ok: actual.deniedAfterExpiry === expected,
      detail: `got ${String(actual.deniedAfterExpiry)}`,
    });
  }

  // ---- prefix-derivation finding ------------------------------------------
  const derivationCases: Array<[CellOutcome, CellOutcome, DerivationFinding]> = [
    ["allowed", "allowed", "literal_prefix_match_sibling_reachable"],
    ["allowed", "denied_403", "prefix_is_component_aware"],
    ["denied_403", "denied_403", "bare_prefix_grants_nothing"],
    ["allowed", "unattributable", "inconclusive"],
    ["unattributable", "denied_403", "inconclusive"],
  ];
  for (const [own, sibling, expected] of derivationCases) {
    const actual = judgeDerivation(own, sibling);
    cases.push({
      name: `derivation: own=${own} sibling=${sibling} -> ${expected}`,
      ok: actual === expected,
      detail: `got ${actual}`,
    });
  }

  // ---- CLI and env guards --------------------------------------------------
  const unknownFlag = parseArgs(["--ramp-max-second=60"]);
  cases.push({
    name: "parseArgs: an unknown flag is an error, not a silent default",
    ok: unknownFlag.errors.length > 0,
    detail: unknownFlag.errors[0] ?? "(no error raised)",
  });
  const badBool = parseArgs(["--verify-expiry=yes"]);
  cases.push({
    name: "parseArgs: a switch given a non-boolean value is an error",
    ok: badBool.errors.length > 0,
    detail: badBool.errors[0] ?? "(no error raised)",
  });
  const goodArgs = parseArgs(["--burst=3", "--json", "--legs=tempcreds"]);
  cases.push({
    name: "parseArgs: valid flags still parse",
    ok: goodArgs.errors.length === 0 && goodArgs.config.burst === 3 && goodArgs.config.json,
    detail: `errors=${goodArgs.errors.length} burst=${goodArgs.config.burst}`,
  });

  const urlEndpoint = loadEnv({
    R2_ACCOUNT_ID: "account",
    R2_API_TOKEN: "token",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  });
  cases.push({
    name: "loadEnv: R2_S3_ENDPOINT given as a URL is rejected with an explanation",
    ok: urlEndpoint.env === null && urlEndpoint.errors.some((error) => error.includes("bare HOST")),
    detail: urlEndpoint.errors[0] ?? "(accepted the URL)",
  });

  // ---- redaction survives into vendor error strings ------------------------
  const redactPublic = publicRedactor({
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: "tok_averyrealtokenvalue",
    parentAccessKeyId: "AKIDEXAMPLEEXAMPLEEXAMPLE",
    parentSecretAccessKey: "supersecretsupersecretsupersecret",
    jurisdiction: null,
    s3Host: "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    apiBase: "https://api.cloudflare.com/client/v4",
    bucketPrefix: "brainz-probe-",
  });
  const dirty =
    "HTTP 403 [auth] AccessDenied: bucket brainz-probe-abc123-tenants on host " +
    "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com (account 0123456789abcdef0123456789abcdef) " +
    "token tok_averyrealtokenvalue";
  const clean = redactPublic(dirty);
  cases.push({
    name: "redaction: account id, endpoint, bucket name and token are all stripped from a raw error string",
    ok:
      !clean.includes("0123456789abcdef") &&
      !clean.includes("brainz-probe-abc123") &&
      !clean.includes("tok_averyrealtokenvalue"),
    detail: clean,
  });

  return cases;
}

// ---------------------------------------------------------------------- main

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  if (argv.includes("--self-test")) {
    const cases = await runSelfTest();
    const failed = cases.filter((entry) => !entry.ok);
    console.log("\nProbe self-test (offline — no credentials, no network, no account touched)\n");
    for (const entry of cases) {
      console.log(`  ${entry.ok ? "ok  " : "FAIL"}  ${entry.name}\n          ${entry.detail}`);
    }
    console.log(
      failed.length === 0
        ? `\nAll ${cases.length} self-tests passed. The signer and the local minter are known-good, the\n` +
            "scope-verdict mapping refuses to score an unattributable outcome as a denial, and the\n" +
            "exit-code contract holds — so a denial observed against a real account is attributable\n" +
            "to access control rather than to this probe's own crypto or its own bookkeeping.\n"
        : `\n${failed.length} self-test(s) FAILED. Do not trust a run against a real account until\n` +
            "this is resolved — a broken signer denies everything and looks like perfect isolation.\n",
    );
    return failed.length === 0 ? EXIT.ANSWERED : EXIT.SELF_TEST_FAILED;
  }

  const { config, errors: argErrors } = parseArgs(argv);
  if (argErrors.length > 0) {
    for (const error of argErrors) console.error(`error: ${error}`);
    console.error(HELP);
    return EXIT.USAGE;
  }

  const { env, missing, errors: envErrors } = loadEnv();

  if (config.dryRun) {
    const bucketsPlanned =
      (config.legs.has("latency") ? config.latencySamples * config.createVia.length : 0) +
      (config.legs.has("ratelimit") ? config.burst * config.createVia.length : 0) +
      (config.legs.has("ramp") ? config.ramp : 0) +
      (config.legs.has("tempcreds") ? 2 : 0);
    const restPlanned =
      1 +
      (config.legs.has("latency") && config.createVia.includes("rest") ? config.latencySamples : 0) +
      (config.legs.has("ratelimit") && config.createVia.includes("rest") ? config.burst : 0) +
      (config.legs.has("ramp") ? config.ramp : 0) +
      // 4 TTL-ladder mints + the matrix mint + the derivation-probe mint + 2 bucket creates
      (config.legs.has("tempcreds") ? 8 + config.mintSamples + config.mintBurst : 0) +
      bucketsPlanned; // deletes
    console.log(`
DRY RUN — nothing was created, deleted, listed or minted.

  legs:                 ${[...config.legs].join(", ") || "(none)"}
  create paths:         ${config.createVia.join(", ")}
  buckets to be created: ~${bucketsPlanned}   (all named "${env?.bucketPrefix ?? MANDATORY_BUCKET_PREFIX}<runId>-*", all deleted at the end)
  R2 REST calls:        ~${restPlanned}   (account-wide budget is ${DOCUMENTED.restApiRequestsPerFiveMinutes} per 5 minutes, SHARED with your production traffic)
  env present:          ${REQUIRED_ENV.filter((name) => !missing.includes(name)).join(", ") || "(none)"}
  env missing:          ${missing.join(", ") || "(none)"}
${envErrors.map((error) => `  config error:         ${error}`).join("\n")}
  cleanup pacing:       ${config.cleanupRps}/s over ~${bucketsPlanned} delete(s) — budget for it as well as the run
`);
    return missing.length > 0 || envErrors.length > 0 ? EXIT.USAGE : EXIT.ANSWERED;
  }

  if (env === null) {
    console.error("\nR2 boundary probe cannot run.\n");
    if (missing.length > 0) console.error(`  missing env: ${missing.join(", ")}`);
    for (const error of envErrors) console.error(`  ${error}`);
    console.error(
      "\nBun reads .env from the directory you run in, so it must be at the REPO ROOT\n" +
        "(next to package.json) — not in scripts/probes/r2-boundary/. A .env placed here is\n" +
        "gitignored AND never loaded, which looks exactly like a missing variable.\n" +
        "\nSee scripts/probes/r2-boundary/README.md for how to create the token.\n",
    );
    return EXIT.USAGE;
  }

  const client = new R2Client(env);
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toLowerCase();
  const ctx: Ctx = { client, config, runId, tracker: { buckets: new Set(), objects: [] } };

  // ---- cleanup-only -------------------------------------------------------
  if (config.cleanupOnly) {
    const names: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < config.maxListPages; page += 1) {
      const result: Call<{ names: string[]; cursor: string | null }> = await client.listBucketsPage(
        cursor,
        config.listPerPage,
      );
      if (!result.ok) {
        console.error(`listing failed: ${failureSummary(result)}`);
        return 2;
      }
      names.push(...result.value.names.filter((name) => name.startsWith(env.bucketPrefix)));
      cursor = result.value.cursor;
      if (cursor === null) break;
    }
    if (names.length === 0) {
      console.log(`No "${env.bucketPrefix}*" buckets found. Nothing to clean up.`);
      return 0;
    }
    console.log(`Deleting ${names.length} leftover probe bucket(s)...`);
    const result = await cleanup(ctx, names);
    console.log(result.statement);
    for (const error of result.errors) console.error(`  ${secretsRedactor(env)(error)}`);
    // 5, not 1: "cleanup left buckets behind" and "R2 scoping is broken" are
    // different events and a CI caller must be able to tell them apart.
    return result.bucketsRemaining.length === 0 ? EXIT.ANSWERED : EXIT.CLEANUP_INCOMPLETE;
  }

  // ---- the run ------------------------------------------------------------
  const startedAt = new Date();
  const runStart = performance.now();

  let inventory: InventoryResult | null = null;
  let latency: LatencyPathResult[] = [];
  let rateLimit: RateLimitPathResult[] = [];
  let ramp: RampResult | null = null;
  let temp: TempCredsResult | null = null;
  let crashed: string | null = null;
  let cleanupResult: CleanupResult;

  try {
    if (config.legs.has("inventory")) {
      inventory = await legInventory(ctx);
    }
    if (config.legs.has("latency")) {
      latency = await legLatency(ctx);
    }
    // tempcreds runs BEFORE the legs that deliberately provoke throttling.
    // It is the leg that answers the question this probe exists for, and it was
    // sequenced immediately after a 2x-burst that left the account throttled —
    // so its unretried setup was the most likely thing in the run to fail, and
    // it failed with a message blaming the credentials.
    if (config.legs.has("tempcreds")) {
      temp = await legTempCreds(ctx);
    }
    if (config.legs.has("ratelimit")) {
      rateLimit = await legRateLimit(ctx);
    }
    if (config.legs.has("ramp")) {
      ramp = await legRamp(ctx, {
        known: inventory !== null && inventory.verdict === "PASS",
        exact: inventory?.countIsExact ?? false,
        count: inventory?.existingBuckets ?? 0,
      });
    }
  } catch (error) {
    crashed = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    // Always. A leg that throws mid-burst must not leave buckets behind.
    cleanupResult = await cleanup(ctx, [...ctx.tracker.buckets]);
  }

  const optionA = judgeBucketPerTenant(inventory, latency, rateLimit, ramp);
  const optionB = judgeTempCreds(temp);

  const report: Record<string, unknown> = {
    probe: "r2-boundary",
    reportVersion: 1,
    runId,
    startedAt: startedAt.toISOString(),
    durationSeconds: Math.round((performance.now() - runStart) / 1000),
    settles: {
      requirements: ["R9", "R10"],
      gapRegister: 15,
      question:
        "Is bucket-per-tenant or prefix-scoped temporary credentials viable for R2 at target scale?",
      targetTenants: TARGET_TENANTS,
    },
    documentedLimits: DOCUMENTED,
    config: { ...config, legs: [...config.legs] },
    crashed,
    legs: { inventory, latency, rateLimit, ramp, tempcreds: temp },
    verdicts: { bucketPerTenant: optionA, prefixScopedTemporaryCredentials: optionB },
    callBudget: {
      restCalls: client.counters.rest,
      s3Calls: client.counters.s3,
      documentedRestBudget: `${DOCUMENTED.restApiRequestsPerFiveMinutes} requests per 5 minutes, account-wide`,
      warning:
        client.counters.rest > DOCUMENTED.restApiRequestsPerFiveMinutes
          ? "This run spent more than the documented 5-minute REST budget; later measurements in this run may reflect throttling caused by earlier legs."
          : null,
    },
    cleanup: cleanupResult,
  };

  const headerLines: string[] = [];
  headerLines.push(`run ${runId}   ${startedAt.toISOString()}`);
  if (crashed) headerLines.push(`RUN ABORTED MID-FLIGHT: ${crashed}`);
  if (inventory && inventory.probeBucketsAlreadyPresent.length > 0) {
    headerLines.push(
      `NOTE: ${inventory.probeBucketsAlreadyPresent.length} bucket(s) from an EARLIER probe run were ` +
        `already on the account before this one started. They are counted in the baseline below. ` +
        `Run "bun run probe:r2 --cleanup-only" to remove them.`,
    );
  }
  headerLines.push(cleanupResult.statement);
  headerLines.push("");
  headerLines.push(
    "The account bucket quota is not exposed by any R2 API. Where the verdict below reads",
  );
  headerLines.push(
    "NOT_OBSERVED, that is the honest state of the evidence, not a probe failure — see README.",
  );

  // An option that ran but could not be settled exits NOT_SETTLED whichever
  // option it was — a `--legs=inventory --ramp=…` run that fails on auth must
  // not exit 0, and neither must a run whose only cross-tenant evidence was a
  // credential that was never minted. SKIPPED is not INCONCLUSIVE: a leg nobody
  // asked for did not fail to answer.
  const exitCode = exitCodeFor({
    crashed: crashed !== null,
    verdicts: [optionA.verdict, optionB.verdict],
    cleanupIncomplete: cleanupResult.bucketsRemaining.length > 0,
  });
  report["exitCode"] = exitCode;

  const hideSecrets = secretsRedactor(env);
  const hideAll = publicRedactor(env);
  // Redact by walking the SERIALISED report, so a credential cannot survive in
  // a field that was added later and never considered here.
  const safeReport = hideSecrets(JSON.stringify(report, null, 2));

  if (config.json) {
    console.log(safeReport);
  } else {
    console.log(hideSecrets(renderHuman(report, [optionA, optionB], headerLines)));
    console.log("");
    console.log("-".repeat(78));
    console.log("Paste into RESULT.md (credentials, account id, endpoint and bucket names redacted):");
    console.log("-".repeat(78));
    console.log(
      pasteBlock(report, [optionA, optionB], temp, exitCode, cleanupResult.statement, hideAll),
    );
    console.log("");
  }

  if (config.write) {
    const path = config.out ?? `${import.meta.dir}/result-${runId}.json`;
    await Bun.write(path, `${safeReport}\n`);
    if (!config.json) console.error(`Full report written to ${path} (gitignored).`);
  }

  return exitCode;
}

// Guarded so the module can be imported (by a test, or by a future harness)
// without the import itself running a probe and exiting the process.
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
