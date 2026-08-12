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
 * expensive no-branch that was never needed. Three rules keep both out:
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
 *
 * Exit codes: 0 answered, no blocker. 1 a hard FAIL (scope not enforced, or a
 * quota ceiling below target). 2 usage/config error. 3 INCONCLUSIVE — the probe
 * could not settle the question, which is NOT the same as answering "no".
 */

import {
  classifyFailure,
  loadEnv,
  MANDATORY_BUCKET_PREFIX,
  R2Client,
  REQUIRED_ENV,
  type Call,
  type CallFailure,
  type FailureKind,
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

function parseArgs(argv: string[]): { config: Config; errors: string[] } {
  const errors: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      errors.push(`unrecognised argument: ${arg}`);
      continue;
    }
    const [key, ...rest] = arg.slice(2).split("=");
    flags.set(key ?? "", rest.length > 0 ? rest.join("=") : "true");
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
  --help

Env: ${REQUIRED_ENV.join(", ")}
     optional: R2_JURISDICTION, R2_S3_ENDPOINT, R2_API_BASE, R2_PROBE_BUCKET_PREFIX
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
  quotaCeilingObservedAt: number | null;
  elapsedSeconds: number;
  path: CreatePath;
}

async function legRamp(ctx: Ctx, existingBuckets: number): Promise<RampResult> {
  const via = ctx.config.createVia[0] ?? "rest";
  const intervalMs = ctx.config.rampRps > 0 ? 1000 / ctx.config.rampRps : 0;
  const startedAt = performance.now();

  let created = 0;
  let consecutiveRateLimits = 0;
  let termination: RampTermination = "completed_no_ceiling_found";
  let terminalError: string | null = null;
  let quotaCeilingObservedAt: number | null = null;

  for (let index = 0; index < ctx.config.ramp; index += 1) {
    if ((performance.now() - startedAt) / 1000 > ctx.config.rampMaxSeconds) {
      termination = "time_budget_exhausted";
      break;
    }
    const tick = performance.now();
    const call = await createBucket(ctx, bucketName(ctx, `ramp-${index}`), via);

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
      termination = "quota_ceiling_observed";
      terminalError = failureSummary(call);
      quotaCeilingObservedAt = existingBuckets + created;
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
    elapsedSeconds: Math.round((performance.now() - startedAt) / 1000),
    path: via,
  };
}

// ------------------------------------------------------------- leg: tempcreds

type CellOutcome =
  | "allowed"
  | "denied_403"
  | "denied_404_obscured"
  | "denied_other"
  | "denied_but_took_effect"
  | "error";

interface Cell {
  id: string;
  what: string;
  expectation: "allow" | "deny";
  status: number;
  outcome: CellOutcome;
  code: string | null;
  message: string;
  sideEffectCheck: string | null;
  matchesExpectation: boolean;
}

interface ScopeMatrix {
  mintMode: "api" | "local";
  verdict: Verdict;
  reason: string;
  cells: Cell[];
  enumerationLeak: boolean | null;
  keysVisibleToUnscopedList: string[];
  mintError: string | null;
}

function classifyRead(call: Call<string>): CellOutcome {
  if (call.ok) return "allowed";
  if (call.status === 403) return "denied_403";
  if (call.status === 404) return "denied_404_obscured";
  if (call.status === 0) return "error";
  return "denied_other";
}

function cellFrom(
  id: string,
  what: string,
  expectation: "allow" | "deny",
  call: Call<unknown>,
  outcome: CellOutcome,
  sideEffectCheck: string | null,
): Cell {
  const allowed = outcome === "allowed" || outcome === "denied_but_took_effect";
  return {
    id,
    what,
    expectation,
    status: call.status,
    outcome,
    code: call.ok ? null : call.code,
    message: call.ok ? "ok" : call.message,
    sideEffectCheck,
    matchesExpectation: expectation === "allow" ? outcome === "allowed" : !allowed,
  };
}

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
  const readOwn = await ctx.client.getObject(credentials, bucketA, ownKey);
  cells.push(
    cellFrom("read_own_prefix", `GET ${bucketA}/${ownKey}`, "allow", readOwn, classifyRead(readOwn), null),
  );

  // 2. PERMISSION CONTROL. The credential is minted object-read-WRITE, so it
  //    must be able to write inside its own prefix — otherwise a denied write
  //    to tenant-b proves the permission level, not the prefix scope.
  const writeOwn = await ctx.client.putObject(credentials, bucketA, writeOwnKey, "scoped write");
  if (writeOwn.ok) ctx.tracker.objects.push({ bucket: bucketA, key: writeOwnKey });
  cells.push(
    cellFrom(
      "write_own_prefix",
      `PUT ${bucketA}/${writeOwnKey}`,
      "allow",
      writeOwn,
      writeOwn.ok ? "allowed" : classifyRead(writeOwn),
      null,
    ),
  );

  // 3. The assertion: another tenant's object, known to exist and known to be
  //    readable by the parent credential a moment ago.
  const readOther = await ctx.client.getObject(credentials, bucketA, otherKey);
  cells.push(
    cellFrom(
      "read_other_prefix",
      `GET ${bucketA}/${otherKey}`,
      "deny",
      readOther,
      classifyRead(readOther),
      "object was confirmed present and parent-readable before this call",
    ),
  );

  // 4. Denied write, then verified by parent read. A write that errors but
  //    lands is the denial that must not be believed.
  const writeOther = await ctx.client.putObject(credentials, bucketA, writeOtherKey, "cross-tenant");
  const landed = await ctx.client.getObject(parent, bucketA, writeOtherKey);
  if (landed.ok) ctx.tracker.objects.push({ bucket: bucketA, key: writeOtherKey });
  const writeOtherOutcome: CellOutcome = writeOther.ok
    ? "allowed"
    : landed.ok
      ? "denied_but_took_effect"
      : classifyRead(writeOther);
  cells.push(
    cellFrom(
      "write_other_prefix",
      `PUT ${bucketA}/${writeOtherKey}`,
      "deny",
      writeOther,
      writeOtherOutcome,
      landed.ok
        ? "parent read AFTER the call found the object — the write took effect"
        : "parent read AFTER the call found nothing — no side effect",
    ),
  );

  // 5. Listing another tenant's prefix. Filenames alone are content.
  //    Note this is an ENUMERATION signal, not an object-access one: it feeds
  //    the caveat below rather than the pass/fail decision, because "objects
  //    are fenced but keys are listable" is a materially different finding from
  //    "the credential can read another tenant's data".
  const listOther = await ctx.client.listObjects(credentials, bucketA, "tenant-b/");
  const listOtherLeakedKeys = listOther.ok ? listOther.value : [];
  const listOtherOutcome: CellOutcome = listOther.ok
    ? listOther.value.length > 0
      ? "allowed"
      : "denied_other"
    : classifyRead(listOther as Call<string>);
  cells.push(
    cellFrom(
      "list_other_prefix",
      `ListObjectsV2 ${bucketA}?prefix=tenant-b/`,
      "deny",
      listOther,
      listOtherOutcome,
      listOther.ok ? `returned ${listOther.value.length} key(s)` : null,
    ),
  );

  // 6. Unscoped list — does the credential enumerate the whole bucket?
  const listAll = await ctx.client.listObjects(credentials, bucketA, null);
  const unscopedLeakedKeys = listAll.ok
    ? listAll.value.filter((key) => !key.startsWith("tenant-a/"))
    : [];
  const leakedKeys = [...new Set([...listOtherLeakedKeys, ...unscopedLeakedKeys])];
  const enumerationLeak = leakedKeys.length > 0;
  cells.push(
    cellFrom(
      "list_bucket_unscoped",
      `ListObjectsV2 ${bucketA} (no prefix)`,
      "deny",
      listAll,
      listAll.ok
        ? unscopedLeakedKeys.length > 0
          ? "allowed"
          : "denied_other"
        : classifyRead(listAll as Call<string>),
      listAll.ok
        ? `returned ${listAll.value.length} key(s); ${unscopedLeakedKeys.length} outside the scoped prefix`
        : null,
    ),
  );

  // 7. A different bucket entirely.
  const readOtherBucket = await ctx.client.getObject(credentials, bucketB, "control.txt");
  cells.push(
    cellFrom(
      "read_other_bucket",
      `GET ${bucketB}/control.txt`,
      "deny",
      readOtherBucket,
      classifyRead(readOtherBucket),
      "object was confirmed present and parent-readable before this call",
    ),
  );

  // 8. Delete, verified by parent read afterwards. Run last, and restore the
  //    object either way so the second mint mode sees the same fixture.
  const deleteOther = await ctx.client.deleteObject(credentials, bucketA, otherKey);
  const stillThere = await ctx.client.getObject(parent, bucketA, otherKey);
  const deleteOutcome: CellOutcome = deleteOther.ok
    ? "allowed"
    : stillThere.ok
      ? classifyRead(deleteOther)
      : "denied_but_took_effect";
  cells.push(
    cellFrom(
      "delete_other_prefix",
      `DELETE ${bucketA}/${otherKey}`,
      "deny",
      deleteOther,
      deleteOutcome,
      stillThere.ok
        ? "parent read AFTER the call still finds the object — no side effect"
        : "parent read AFTER the call finds it GONE — the delete took effect",
    ),
  );
  if (!stillThere.ok) {
    await ctx.client.putObject(parent, bucketA, otherKey, "tenant-b private note");
  }

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
    keysVisibleToUnscopedList: leakedKeys.slice(0, 10),
    mintError: null,
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
  const violations = cells.filter(
    (cell) => (OBJECT_ACCESS_CELLS as readonly string[]).includes(cell.id) && !cell.matchesExpectation,
  );

  if (!positive || positive.outcome !== "allowed") {
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
        "writes elsewhere demonstrate the permission level, not the prefix scope.",
    };
  }
  if (violations.length > 0) {
    return {
      verdict: "FAIL",
      reason: `scope_not_enforced — ${violations
        .map((cell) => cell.id)
        .join(", ")} reached data outside the scoped prefix.`,
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
  return {
    verdict: "PASS",
    reason:
      "scope_enforced — positive and permission controls both passed, and every cross-tenant read, " +
      "write, delete, list and cross-bucket read was denied with no side effect.",
  };
}

interface TtlLadderEntry {
  ttlSeconds: number;
  accepted: boolean;
  error: string | null;
}

interface TempCredsResult {
  verdict: Verdict;
  reason: string;
  setupError: string | null;
  ttlLadder: TtlLadderEntry[];
  minimumAcceptedTtlSeconds: number | null;
  apiMint: ScopeMatrix | null;
  localMint: ScopeMatrix | null;
  apiMintLatencyMs: Stats;
  apiMintRateLimited: number;
  apiMintBurst: {
    concurrent: number;
    succeeded: number;
    rateLimited: number;
    wallMs: number;
    achievedMintsPerSecond: number;
  } | null;
  localMintsPerSecond: number | null;
  expiryCheck: { ran: boolean; ttlSeconds: number | null; deniedAfterExpiry: boolean | null; note: string };
}

async function legTempCreds(ctx: Ctx): Promise<TempCredsResult> {
  const parent = ctx.client.parentCredentials();
  const bucketA = bucketName(ctx, "tenants");
  const bucketB = bucketName(ctx, "control");

  const empty: TempCredsResult = {
    verdict: "INCONCLUSIVE",
    reason: "",
    setupError: null,
    ttlLadder: [],
    minimumAcceptedTtlSeconds: null,
    apiMint: null,
    localMint: null,
    apiMintLatencyMs: stats([]),
    apiMintRateLimited: 0,
    apiMintBurst: null,
    localMintsPerSecond: null,
    expiryCheck: { ran: false, ttlSeconds: null, deniedAfterExpiry: null, note: "not requested" },
  };

  // -- setup, with every step required to succeed before any denial counts ---
  for (const name of [bucketA, bucketB]) {
    const call = await createBucket(ctx, name, "rest");
    if (!call.ok) {
      return {
        ...empty,
        setupError: `could not create ${name}: ${failureSummary(call)}`,
        reason: "setup_failed — no bucket to scope a credential against.",
      };
    }
  }

  const fixtures: Array<{ bucket: string; key: string; body: string }> = [
    { bucket: bucketA, key: "tenant-a/probe.txt", body: "tenant-a private note" },
    { bucket: bucketA, key: "tenant-b/probe.txt", body: "tenant-b private note" },
    { bucket: bucketB, key: "control.txt", body: "different bucket entirely" },
  ];
  for (const fixture of fixtures) {
    let put = await ctx.client.putObject(parent, fixture.bucket, fixture.key, fixture.body);
    if (!put.ok) {
      // A bucket can lag its own create; retry briefly before calling it broken.
      await sleep(1000);
      put = await ctx.client.putObject(parent, fixture.bucket, fixture.key, fixture.body);
    }
    if (!put.ok) {
      return {
        ...empty,
        setupError: `parent write failed for ${fixture.bucket}/${fixture.key}: ${failureSummary(put)}`,
        reason:
          "setup_failed — the PARENT credential could not write the fixtures, so the S3 credentials " +
          "or endpoint are wrong. Nothing about scoping can be concluded from this run.",
      };
    }
    ctx.tracker.objects.push({ bucket: fixture.bucket, key: fixture.key });
  }
  for (const fixture of fixtures) {
    const get = await ctx.client.getObject(parent, fixture.bucket, fixture.key);
    if (!get.ok) {
      return {
        ...empty,
        setupError: `parent read failed for ${fixture.bucket}/${fixture.key}: ${failureSummary(get)}`,
        reason:
          "setup_failed — a fixture the probe just wrote is not parent-readable, so a later 404 " +
          "could not be attributed to scoping.",
      };
    }
  }

  // -- TTL ladder: R2 documents no minimum, so discover it -------------------
  const ladderCandidates = [60, 300, ctx.config.ttlSeconds, 3600].filter(
    (value, index, all) => value > 0 && all.indexOf(value) === index,
  );
  ladderCandidates.sort((a, b) => a - b);
  const ttlLadder: TtlLadderEntry[] = [];
  let minimumAcceptedTtlSeconds: number | null = null;
  for (const ttlSeconds of ladderCandidates) {
    const mint = await ctx.client.mintTempCredentials({
      bucket: bucketA,
      permission: "object-read-write",
      ttlSeconds,
      prefixes: ["tenant-a/"],
    });
    ttlLadder.push({
      ttlSeconds,
      accepted: mint.ok,
      error: mint.ok ? null : failureSummary(mint),
    });
    if (mint.ok && minimumAcceptedTtlSeconds === null) minimumAcceptedTtlSeconds = ttlSeconds;
  }

  const workingTtl = minimumAcceptedTtlSeconds ?? ctx.config.ttlSeconds;

  // -- scope matrix, mint mode 1: the Temporary Credentials API --------------
  let apiMint: ScopeMatrix | null = null;
  const apiCreds = await ctx.client.mintTempCredentials({
    bucket: bucketA,
    permission: "object-read-write",
    ttlSeconds: workingTtl,
    prefixes: ["tenant-a/"],
  });
  if (apiCreds.ok) {
    apiMint = await runScopeMatrix(ctx, apiCreds.value, "api", bucketA, bucketB);
  } else {
    apiMint = {
      mintMode: "api",
      verdict: apiCreds.kind === "rate_limited" ? "RATE_LIMITED" : "INCONCLUSIVE",
      reason: "mint_failed — no credential to test; this says nothing about whether scoping holds.",
      cells: [],
      enumerationLeak: null,
      keysVisibleToUnscopedList: [],
      mintError: failureSummary(apiCreds),
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
    ttlSeconds: Math.max(workingTtl, 900),
    prefixPaths: ["tenant-a/"],
  });
  const localMint = await runScopeMatrix(ctx, local.credentials, "local", bucketA, bucketB);
  if (localMint.verdict === "INCONCLUSIVE") {
    localMint.reason +=
      " Local minting transcribes a claim set from Cloudflare's published example; if the claim set " +
      "has drifted, authentication fails in exactly this way. Treat as UNVERIFIED, not unsupported.";
  }

  // -- mint rate: does a credential mint per tenant at request rate? ---------
  const mintLatencies: number[] = [];
  let apiMintRateLimited = 0;
  for (let index = 0; index < ctx.config.mintSamples; index += 1) {
    const started = performance.now();
    const mint = await ctx.client.mintTempCredentials({
      bucket: bucketA,
      permission: "object-read-only",
      ttlSeconds: workingTtl,
      // A different prefix each time: production mints per tenant, and a
      // repeated prefix could take a cached path a per-tenant mint would not.
      prefixes: [`tenant-${index}/`],
    });
    if (mint.ok) mintLatencies.push(performance.now() - started);
    else if (mint.kind === "rate_limited") apiMintRateLimited += 1;
  }

  let apiMintBurst: TempCredsResult["apiMintBurst"] = null;
  if (ctx.config.mintBurst > 0) {
    const started = performance.now();
    const burst = await Promise.all(
      Array.from({ length: ctx.config.mintBurst }, (_unused, index) =>
        ctx.client.mintTempCredentials({
          bucket: bucketA,
          permission: "object-read-only",
          ttlSeconds: workingTtl,
          prefixes: [`burst-tenant-${index}/`],
        }),
      ),
    );
    const wallMs = performance.now() - started;
    const succeeded = burst.filter((call) => call.ok).length;
    const rateLimited = burst.filter((call) => !call.ok && call.kind === "rate_limited").length;
    apiMintRateLimited += rateLimited;
    apiMintBurst = {
      concurrent: ctx.config.mintBurst,
      succeeded,
      rateLimited,
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
        const before = await ctx.client.getObject(shortLived.value, bucketA, "tenant-a/probe.txt");
        await sleep((minimumAcceptedTtlSeconds + 20) * 1000);
        const after = await ctx.client.getObject(shortLived.value, bucketA, "tenant-a/probe.txt");
        expiryCheck = {
          ran: true,
          ttlSeconds: minimumAcceptedTtlSeconds,
          deniedAfterExpiry: !after.ok,
          note: `before expiry: ${describe(before)}; after expiry: ${describe(after)}`,
        };
      }
    }
  }

  // -- overall leg verdict: the best result across the two mint modes --------
  const order: Record<Verdict, number> = {
    PASS: 6,
    PASS_WITH_CAVEAT: 5,
    RATE_LIMITED: 4,
    NOT_OBSERVED: 3,
    SKIPPED: 2,
    INCONCLUSIVE: 1,
    FAIL: 0,
  };
  const candidates = [apiMint, localMint].filter((matrix): matrix is ScopeMatrix => matrix !== null);
  const anyFail = candidates.some((matrix) => matrix.verdict === "FAIL");
  const best = candidates.reduce<ScopeMatrix | null>(
    (winner, matrix) => (winner === null || order[matrix.verdict] > order[winner.verdict] ? matrix : winner),
    null,
  );

  const verdict: Verdict = anyFail ? "FAIL" : (best?.verdict ?? "INCONCLUSIVE");
  const reason = anyFail
    ? `A mint mode reached data outside its prefix: ${candidates
        .filter((matrix) => matrix.verdict === "FAIL")
        .map((matrix) => `${matrix.mintMode} (${matrix.reason})`)
        .join("; ")}`
    : `${best?.mintMode ?? "no"} mint mode is the strongest result: ${best?.reason ?? "no matrix ran"}`;

  return {
    verdict,
    reason,
    setupError: null,
    ttlLadder,
    minimumAcceptedTtlSeconds,
    apiMint,
    localMint,
    apiMintLatencyMs: stats(mintLatencies),
    apiMintRateLimited,
    apiMintBurst,
    localMintsPerSecond,
    expiryCheck,
  };
}

// ---------------------------------------------------------------- cleanup

interface CleanupResult {
  bucketsSeen: number;
  bucketsDeleted: number;
  bucketsRemaining: string[];
  objectsDeleted: number;
  errors: string[];
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

  for (const bucket of names) {
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
  }

  const statement =
    remaining.length === 0
      ? `Cleanup complete: ${bucketsDeleted} bucket(s) and ${objectsDeleted} object(s) created by this run were deleted. Nothing was left behind.`
      : `Cleanup INCOMPLETE: ${remaining.length} bucket(s) survive. Re-run "bun run probe:r2 --cleanup-only" to remove them.`;

  return {
    bucketsSeen: names.length,
    bucketsDeleted,
    bucketsRemaining: remaining,
    objectsDeleted,
    errors: errors.slice(0, 20),
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
  }

  const authBlocked =
    latency.every((entry) => entry.verdict === "INCONCLUSIVE") && latency.length > 0 && created === 0;

  let verdict: Verdict;
  let headline: string;
  if (ramp?.termination === "quota_ceiling_observed") {
    verdict = "FAIL";
    headline =
      `A quota ceiling was OBSERVED at approximately ${ramp.quotaCeilingObservedAt} bucket(s) — ` +
      `below the ${TARGET_TENANTS.toLocaleString("en-US")}-tenant target. Bucket-per-tenant needs a ` +
      `limit increase in writing before it can be chosen.`;
  } else if (authBlocked || created === 0) {
    verdict = "INCONCLUSIVE";
    headline =
      "No bucket was created, so nothing about the operational envelope was measured. Check the " +
      "token's R2 permissions before reading this as a limit.";
  } else {
    verdict = "NOT_OBSERVED";
    headline =
      `Bucket creation works and its throughput envelope is measured, but NO quota ceiling was ` +
      `observed — because the account quota is not exposed by any R2 API. Proven headroom is ` +
      `>= ${provenHeadroom}; the ${TARGET_TENANTS.toLocaleString("en-US")}-tenant target is NOT proven ` +
      `by this run and must be confirmed by Cloudflare in writing.`;
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
      .map((entry) => `${entry.ttlSeconds}s ${entry.accepted ? "accepted" : "rejected"}`)
      .join(", ")}` +
      (temp.minimumAcceptedTtlSeconds === null
        ? " — no TTL accepted."
        : ` — shortest accepted TTL is ${temp.minimumAcceptedTtlSeconds}s.`),
  );
  for (const matrix of [temp.apiMint, temp.localMint]) {
    if (!matrix) continue;
    evidence.push(`${matrix.mintMode} mint: ${matrix.verdict} — ${matrix.reason}`);
    for (const cell of matrix.cells) {
      evidence.push(
        `    ${cell.matchesExpectation ? "as expected" : "UNEXPECTED"}  ${cell.id} ` +
          `(expect ${cell.expectation}) -> ${cell.outcome} [HTTP ${cell.status}]` +
          (cell.sideEffectCheck ? ` — ${cell.sideEffectCheck}` : ""),
      );
    }
  }
  evidence.push(
    `API mint latency: p50 ${temp.apiMintLatencyMs.p50 ?? "-"}ms, p95 ${temp.apiMintLatencyMs.p95 ?? "-"}ms ` +
      `over ${temp.apiMintLatencyMs.count} sequential mint(s), ${temp.apiMintRateLimited} throttled.`,
  );
  if (temp.apiMintBurst) {
    evidence.push(
      `API mint burst: ${temp.apiMintBurst.succeeded}/${temp.apiMintBurst.concurrent} concurrent mints ` +
        `succeeded in ${temp.apiMintBurst.wallMs}ms (${temp.apiMintBurst.achievedMintsPerSecond}/s), ` +
        `${temp.apiMintBurst.rateLimited} throttled.`,
    );
  }
  if (temp.localMintsPerSecond !== null) {
    evidence.push(
      `Local (no-API) minting ran at ~${temp.localMintsPerSecond}/s in-process — no network call, ` +
        `so it spends none of the ${DOCUMENTED.restApiRequestsPerFiveMinutes}-per-5-minute R2 REST budget.`,
    );
  }
  evidence.push(`Expiry check: ${temp.expiryCheck.note}`);

  const headline =
    temp.verdict === "PASS"
      ? "Prefix-scoped credentials mint AND the scope actually holds: a tenant-a credential was denied every read, write, delete, list and cross-bucket access against tenant-b."
      : temp.verdict === "PASS_WITH_CAVEAT"
        ? "Object access is fenced by prefix, but the credential can enumerate keys outside its prefix. Key names are content."
        : temp.verdict === "FAIL"
          ? "A credential scoped to one tenant's prefix REACHED another tenant's data. This option is not usable as an isolation boundary as configured."
          : "The scope could not be tested conclusively — read the reason before treating this as a no.";

  return {
    option: "B. prefix-scoped temporary credentials",
    verdict: temp.verdict,
    headline,
    evidence,
    planImpact: [
      "Choosing B fences access at the platform without bucket-per-user, and needs no bucket-quota answer at all — the quota question above stops being blocking.",
      "R10's blast radius: the fleet still holds the PARENT credential, so the register entry changes from 'fleet-wide object credential on the request path' to 'parent credential held outside the request path, request path holds a per-tenant credential with a bounded TTL'. That is a real reduction only if the parent key is not resolvable by the request-path identity (same rule R11 applies to connection strings).",
      "U2's storage accessor keeps deriving the prefix from authenticated tenant context, but a derivation bug is now caught by the platform instead of leaking across tenants — the guard becomes defence in depth rather than the only control.",
      "U16's attestation may report R2 as enforced rather than conventional, scoped to whichever mint mode was verified.",
      "Local (JWT) minting, if verified, removes the mint from the R2 REST budget entirely and makes per-request minting a non-question. If only the API mint verified, the mint rate above is the ceiling on the request path and a per-tenant credential cache with a TTL shorter than the credential's own is the mitigation.",
    ],
  };
}

// ------------------------------------------------------------------ rendering

function redact(text: string, accountId: string, s3Host: string): string {
  return text.split(s3Host).join("<R2_S3_ENDPOINT>").split(accountId).join("<R2_ACCOUNT_ID>");
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

function pasteBlock(
  report: Record<string, unknown>,
  options: OptionVerdict[],
  accountId: string,
  s3Host: string,
): string {
  const lines: string[] = [];
  lines.push("```");
  lines.push(`run_id:        ${String(report["runId"])}`);
  lines.push(`ran_at:        ${String(report["startedAt"])}`);
  for (const option of options) {
    lines.push(`${option.option}`);
    lines.push(`  verdict:     ${option.verdict}`);
    lines.push(`  headline:    ${redact(option.headline, accountId, s3Host)}`);
  }
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

  // The verdict logic is where a false pass or a false fail would actually be
  // manufactured, and a live run only ever exercises the one branch it lands
  // in. Every branch is pinned here instead, against synthetic matrices.
  const cell = (id: string, expectation: "allow" | "deny", outcome: CellOutcome): Cell => ({
    id,
    what: id,
    expectation,
    status: outcome === "allowed" ? 200 : 403,
    outcome,
    code: null,
    message: "",
    sideEffectCheck: null,
    matchesExpectation:
      expectation === "allow"
        ? outcome === "allowed"
        : outcome !== "allowed" && outcome !== "denied_but_took_effect",
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
  const noLeak: LeakCounts = { listOtherPrefixKeys: 0, unscopedListKeys: 0, distinctLeakedKeys: 0 };

  const verdictCases: Array<[string, Cell[], LeakCounts, Verdict]> = [
    ["everything denied, nothing enumerable", cleanMatrix(), noLeak, "PASS"],
    [
      "objects fenced but keys enumerable -> caveat, NOT a fail",
      cleanMatrix().map((entry) =>
        entry.id === "list_bucket_unscoped" ? cell(entry.id, "deny", "allowed") : entry,
      ),
      { listOtherPrefixKeys: 0, unscopedListKeys: 2, distinctLeakedKeys: 2 },
      "PASS_WITH_CAVEAT",
    ],
    [
      "a cross-tenant read succeeds -> fail",
      cleanMatrix().map((entry) =>
        entry.id === "read_other_prefix" ? cell(entry.id, "deny", "allowed") : entry,
      ),
      noLeak,
      "FAIL",
    ],
    [
      "a denied write that took effect -> fail",
      cleanMatrix().map((entry) =>
        entry.id === "write_other_prefix" ? cell(entry.id, "deny", "denied_but_took_effect") : entry,
      ),
      noLeak,
      "FAIL",
    ],
    [
      "positive control failed -> inconclusive, never fail",
      cleanMatrix().map((entry) =>
        entry.id === "read_own_prefix" ? cell(entry.id, "allow", "denied_403") : entry,
      ),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "permission control failed -> inconclusive, never pass",
      cleanMatrix().map((entry) =>
        entry.id === "write_own_prefix" ? cell(entry.id, "allow", "denied_403") : entry,
      ),
      noLeak,
      "INCONCLUSIVE",
    ],
    [
      "broken signer denies EVERYTHING -> inconclusive, never pass",
      cleanMatrix().map((entry) => cell(entry.id, entry.expectation, "denied_403")),
      noLeak,
      "INCONCLUSIVE",
    ],
  ];
  for (const [name, matrix, leak, expected] of verdictCases) {
    const actual = decideScopeVerdict(matrix, leak);
    cases.push({
      name: `scope verdict: ${name} -> ${expected}`,
      ok: actual.verdict === expected,
      detail: `got ${actual.verdict}`,
    });
  }

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
        ? "\nAll self-tests passed. The signer and the local minter are known-good, so a denial\n" +
            "observed against a real account is attributable to access control rather than to\n" +
            "this probe's own crypto.\n"
        : `\n${failed.length} self-test(s) FAILED. Do not trust a run against a real account until\n` +
            "this is resolved — a broken signer denies everything and looks like perfect isolation.\n",
    );
    return failed.length === 0 ? 0 : 1;
  }

  const { config, errors: argErrors } = parseArgs(argv);
  if (argErrors.length > 0) {
    for (const error of argErrors) console.error(`error: ${error}`);
    console.error(HELP);
    return 2;
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
      (config.legs.has("tempcreds") ? 6 + config.mintSamples + config.mintBurst : 0) +
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
`);
    return missing.length > 0 || envErrors.length > 0 ? 2 : 0;
  }

  if (env === null) {
    console.error("\nR2 boundary probe cannot run.\n");
    if (missing.length > 0) console.error(`  missing env: ${missing.join(", ")}`);
    for (const error of envErrors) console.error(`  ${error}`);
    console.error("\nSee scripts/probes/r2-boundary/README.md for how to create the token.\n");
    return 2;
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
    for (const error of result.errors) console.error(`  ${error}`);
    return result.bucketsRemaining.length === 0 ? 0 : 1;
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
    if (config.legs.has("ratelimit")) {
      rateLimit = await legRateLimit(ctx);
    }
    if (config.legs.has("ramp")) {
      ramp = await legRamp(ctx, inventory?.existingBuckets ?? 0);
    }
    if (config.legs.has("tempcreds")) {
      temp = await legTempCreds(ctx);
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

  if (config.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report, [optionA, optionB], headerLines));
    console.log("");
    console.log("-".repeat(78));
    console.log("Paste into RESULT.md (account identifiers redacted):");
    console.log("-".repeat(78));
    console.log(pasteBlock(report, [optionA, optionB], env.accountId, env.s3Host));
    console.log("");
  }

  if (config.write) {
    const path = config.out ?? `${import.meta.dir}/result-${runId}.json`;
    await Bun.write(path, `${JSON.stringify(report, null, 2)}\n`);
    if (!config.json) console.error(`Full report written to ${path} (gitignored).`);
  }

  if (crashed) return 3;
  if (optionA.verdict === "FAIL" || optionB.verdict === "FAIL") return 1;
  // An option that ran but could not be settled exits 3 whichever option it was
  // — a `--legs=inventory --ramp=…` run that fails on auth must not exit 0.
  // SKIPPED is not INCONCLUSIVE: a leg nobody asked for did not fail to answer.
  if (optionA.verdict === "INCONCLUSIVE" || optionB.verdict === "INCONCLUSIVE") return 3;
  return 0;
}

// Guarded so the module can be imported (by a test, or by a future harness)
// without the import itself running a probe and exiting the process.
if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
