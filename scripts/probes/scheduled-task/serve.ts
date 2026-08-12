#!/usr/bin/env bun
/**
 * Phase 0 probe — Assumption 3.
 *
 *   "Claude Desktop and Claude Code scheduled tasks can invoke a custom-connector
 *    MCP tool unattended."
 *
 * This is the entire v1 briefing delivery channel (KTD12 / R21). If it fails, the
 * product is "ask for a briefing" rather than "wake up to one" — a different
 * product, and the plan wants that surfaced now rather than discovered in Phase 3.
 *
 * WHAT THIS FILE IS
 * -----------------
 * A throwaway, dependency-free, dual-era MCP server exposing ONE tool
 * (`probe_briefing`). Every invocation appends a record to an append-only JSONL
 * log: server-clock timestamp, a server-minted nonce the caller cannot forge, and
 * every scrap of caller identity the transport actually reveals.
 *
 * The log is append-only and carries a monotonic `seq`, so truncation, a wiped
 * volume, or a torn write are DETECTABLE. It is not tamper-PROOF: the operator
 * holds the file and could rewrite it. The integrity checks exist to catch
 * accidents (ephemeral filesystem, redeploy, volume swap), not an adversary.
 *
 * It also carries the analysis, because a raw log does not settle an assumption —
 * a verdict does. `report` classifies the log against pre-registered firing
 * windows and prints one of six named outcomes. See README.md.
 *
 * THE TRAP THIS IS BUILT AROUND
 * -----------------------------
 * The user will test the tool by hand while wiring it up. A naive log cannot tell
 * that apart from the scheduled task firing at 07:00 while they were asleep, and
 * a probe that counts the manual test as proof certifies the assumption falsely.
 * So: nothing is proof unless it was ARMED FIRST (`arm` writes the expected fire
 * time and a secret label into the log BEFORE the window opens), and the verdict
 * demands at least one discriminator that a manual test could not have produced.
 *
 * THE SECOND TRAP, WHICH IS WORSE
 * -------------------------------
 * ABSENCE OF EVIDENCE MUST NEVER SCORE AS EVIDENCE OF SUCCESS. v1 of this probe
 * failed that: `independent = beacon === "machine_absent" || transportUnseen`,
 * where BOTH disjuncts were satisfied by a missing signal. A dead beacon loop, a
 * closed terminal, a rotated admin token, a server restart that cleared in-memory
 * state, or an empty manual-identity set each read as positive evidence. A hand
 * test run at 07:00 with the operator sitting at the keyboard could score CLEAN.
 *
 * Every discriminator here is therefore a POSITIVE test with an explicit
 * "unavailable" state:
 *
 *   - the beacon discriminator requires an ABSENCE BRACKET — a beacon stream that
 *     was demonstrably running, went quiet BEFORE the call, and stayed quiet for a
 *     margin AFTER it. "Stale" alone proves nothing: a machine that woke at 07:05
 *     and fired a catch-up task at 07:06 with the operator at the keyboard has a
 *     stale beacon too, and its beacon resumes seconds later. That is the shape we
 *     now detect and refuse.
 *   - the transport discriminator requires a NON-EMPTY, TRUSTWORTHY manual
 *     baseline and compares on both an exact and a coarsened identity, so an
 *     empty log or a DHCP renewal cannot manufacture novelty.
 *   - `NO_INVOCATION_OBSERVED` requires POSITIVE evidence the server was up across
 *     the whole window (heartbeat records). A dead server is not a silent client.
 *
 * FALSE FAILS ARE AS EXPENSIVE AS FALSE PASSES. A false fail triggers an
 * architectural no-branch (server-side push, promoted to a Phase 4 commitment)
 * that was never needed. So this server is deliberately LENIENT: it never rejects
 * a request for spec non-compliance, it speaks both the modern (2026-07-28) and
 * legacy (initialize-handshake) protocol eras, and it logs every request it
 * refuses so "the client tried and failed" can never be misread as "the client
 * never tried". Ambient noise the server tolerates by design (scanner 404s, a
 * legacy GET on the MCP endpoint, an unknown JSON-RPC method) is recorded and
 * reported but does NOT invalidate a window — flags are classified by DIRECTION,
 * so noise that could hide a real fire blocks the negative verdict, and only
 * noise that could make an attended call look unattended blocks the positive one.
 *
 * SUBCOMMANDS (entrypoint is fixed by package.json's `probe:scheduled-task`)
 *   bun run probe:scheduled-task                       # serve (default)
 *   bun run probe:scheduled-task doctor                # is the wiring right?
 *   bun run probe:scheduled-task arm --client desktop --fire-at <ISO8601+offset>
 *   bun run probe:scheduled-task report [--json] [--file <path>] [--now <ISO>]
 *   bun run probe:scheduled-task verify-nonce <nonce>
 *
 * NON-GOALS (deliberate, do not add): OAuth, SSE, subscriptions/listen, MRTR,
 * x-mcp-header, rate limiting, persistence beyond a JSONL file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const PROBE_VERSION = "2.0.0";
const SERVER_NAME = "brainz-scheduled-task-probe";
const TOOL_NAME = "probe_briefing";

/** Protocol revisions we answer. Modern = per-request `_meta`; legacy = `initialize`. */
const MODERN_VERSIONS = ["2026-07-28"] as const;
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LEGACY_FALLBACK_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------
// Thresholds. Every one of these is a place where "I did not see anything" is
// deliberately NOT allowed to mean "nothing happened".
// ---------------------------------------------------------------------------

/** Log at most one beacon per minute. The documented loop pings every 2 minutes. */
const BEACON_LOG_THROTTLE_MS = 60_000;

/**
 * Consecutive beacons further apart than this mean the loop was not actually
 * running, so the quiet period that follows proves nothing about the machine.
 */
const BEACON_STREAM_MAX_GAP_MS = 15 * 60_000;

/** How many consecutive on-cadence beacons prove the loop was alive before it went quiet. */
const BEACON_STREAM_MIN_SAMPLES = 3;

/** The machine must already have been unreachable this long when the call landed. */
const BEACON_PRE_CALL_QUIET_MS = 10 * 60_000;

/**
 * ...and must STAY unreachable this long afterwards. This is the disjunct that
 * kills the wake-triggered catch-up fire: a machine that woke to run the task
 * resumes beaconing within a minute or two of waking, i.e. right around the call.
 */
const BEACON_POST_CALL_QUIET_MS = 10 * 60_000;

/** Arming a few seconds before the window opens is not pre-registration. */
const MIN_ARM_LEAD_MS = 30 * 60_000;

/**
 * Two "distinct days" must be genuinely distinct. UTC-date keying let 16:30 and
 * 17:30 local on one afternoon count as two days; wide windows let ONE call
 * satisfy two of them.
 */
const MIN_WINDOW_SEPARATION_MS = 20 * 60 * 60_000;

/** `window_minutes` is a HALF-WIDTH: the window is fire_at ± window_minutes. */
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 120;

const HEARTBEAT_DEFAULT_SECONDS = 300;

// ---------------------------------------------------------------------------
// Record shapes. Everything on disk is one of these, one JSON object per line.
// Optional-ness is expressed as `| null`, never `?`, because the repo compiles
// with exactOptionalPropertyTypes. Fields added after v1 are read through
// tolerant accessors so a v1 log still parses.
// ---------------------------------------------------------------------------

type Era = "modern" | "legacy" | "unknown";

/** Where the operator's by-hand tests came from. Decides whether 5b is usable at all. */
type HandTestOrigin = "desktop" | "web" | "both" | "none" | "unspecified";

const HAND_TEST_ORIGINS: readonly HandTestOrigin[] = ["desktop", "web", "both", "none", "unspecified"];

interface TransportIdentity {
  /** Socket peer as the runtime sees it. Behind a platform proxy this is the proxy. */
  remote_ip: string | null;
  /** Whatever the edge said the real client was, if anything. CALLER-SUPPLIABLE. */
  edge_client_ip: string | null;
  /**
   * True when the socket peer is a private/loopback/CGNAT address, i.e. we really
   * are behind a platform proxy and the edge header is worth believing. A public
   * peer can set `cf-connecting-ip` to anything, so we do not believe it.
   */
  edge_trusted: boolean;
  /** The address identity comparisons actually use. See `trustedIp`. */
  identity_ip: string | null;
  user_agent: string | null;
  /** SHA-256 prefix of the Authorization header. Never the value itself. */
  authorization_fingerprint: string | null;
  /** Every non-sensitive header, verbatim (redacted + truncated). Raw intel for U6. */
  headers: { [name: string]: string };
}

interface BaseRecord {
  seq: number;
  id: string;
  /** Server clock. The server is the only clock in this system we trust. */
  ts: string;
  ts_epoch_ms: number;
  boot_id: string;
  kind: string;
}

interface BootRecord extends BaseRecord {
  kind: "server_boot";
  probe_version: string;
  log_path: string;
  log_durable_declared: boolean;
  records_at_boot: number;
  boots_in_log: number;
  runtime: string;
  server_utc_offset_minutes: number;
  heartbeat_seconds: number;
}

/**
 * Proof the server was up. Without these, "nothing arrived" is indistinguishable
 * from "the process was dead", and the probe would score a platform outage as
 * evidence against Assumption 3.
 */
interface HeartbeatRecord extends BaseRecord {
  kind: "heartbeat";
  interval_seconds: number;
  uptime_seconds: number;
}

interface ArmRecord extends BaseRecord {
  kind: "arm";
  arm_id: string;
  client: string;
  /** ISO 8601 WITH an explicit offset or Z. Enforced — a naive string is a timezone false-fail. */
  fire_at: string;
  fire_at_epoch_ms: number;
  /** HALF-WIDTH in minutes. The window is fire_at ± this. */
  window_minutes: number;
  /** Server-minted. The user pastes this into the scheduled prompt BEFORE the window. */
  expected_label: string;
  /** The user's assertion that they will not touch the client during the window. */
  attest_away: boolean;
  /** Pre-registered, so it cannot be re-told after the fact to rescue a window. */
  hand_tests_from: HandTestOrigin;
  note: string | null;
}

interface BeaconRecord extends BaseRecord {
  kind: "beacon";
  host_label: string | null;
  /**
   * Optional, operator-supplied corroboration (e.g. macOS HID idle seconds).
   * NEVER qualifies a window — it is measured by the machine under test and its
   * cross-sleep semantics are unverified. Printed, never counted.
   */
  user_idle_seconds: number | null;
  screen_locked: boolean | null;
  transport: TransportIdentity;
}

interface HttpRecord extends BaseRecord {
  kind: "http";
  http_method: string;
  path: string;
  status: number;
  reason: string;
  transport: TransportIdentity;
}

interface RpcRecord extends BaseRecord {
  kind: "mcp_rpc";
  method: string;
  rpc_id: string | number | null;
  era: Era;
  protocol_version: string | null;
  client_info: unknown;
  spec_deviations: string[];
  error_code: number | null;
  path: string;
  transport: TransportIdentity;
}

interface ToolCallRecord extends BaseRecord {
  kind: "tool_call";
  tool: string;
  /** Server-minted, unguessable, returned to the caller. The caller cannot forge it. */
  nonce: string;
  /** Caller-asserted and therefore FORGEABLE by the model. Corroboration, not proof. */
  run_label: string | null;
  caller_note: string | null;
  era: Era;
  protocol_version: string | null;
  client_info: unknown;
  spec_deviations: string[];
  /**
   * Seconds since the last beacon, as the process saw it. Seeded from the log at
   * boot so a restart no longer nulls it — but the VERDICT does not use this
   * field. The absence bracket is computed from beacon records, because staleness
   * at one instant cannot distinguish an absent machine from a dead beacon.
   */
  beacon_age_seconds: number | null;
  path: string;
  transport: TransportIdentity;
}

type ProbeRecord =
  | BootRecord
  | HeartbeatRecord
  | ArmRecord
  | BeaconRecord
  | HttpRecord
  | RpcRecord
  | ToolCallRecord;

// ---------------------------------------------------------------------------
// Redaction. The repo is public and the log gets pasted into a result doc, so
// nothing secret may ever reach a record.
// ---------------------------------------------------------------------------

const SECRETS: string[] = [];

function redact(input: string): string {
  let out = input;
  for (const secret of SECRETS) {
    if (secret.length >= 6 && out.includes(secret)) {
      out = out.split(secret).join("<redacted>");
    }
  }
  return out;
}

function safeString(value: unknown, max = 400): string | null {
  if (typeof value !== "string") return null;
  return redact(value).slice(0, max);
}

function fingerprint(value: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish string compare, so admin-token checks don't leak by timing. */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * `process.exit` is not typed as `never` under this tsconfig's type set, so the
 * compiler cannot see that these paths terminate. Make the never-ness explicit.
 */
function fatal(code: number, ...lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(code);
  throw new Error("unreachable");
}

function env(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
}

/**
 * `secret` controls the lecture. The token-rotation paragraph is true of the two
 * secrets and nonsense attached to a URL, which is where a user most often meets
 * this error.
 */
function requireEnv(name: string, why: string, secret = false): string {
  const value = env(name);
  if (value === null) {
    const lines = [`[probe] FATAL: ${name} is not set.`, `[probe] ${why}`];
    if (secret) {
      lines.push(
        "[probe] This probe never auto-generates secrets: a restart that silently",
        "[probe] rotated the token would break the connector URL and read as",
        "[probe] 'the scheduled task did not fire' — a false FAIL. Set it explicitly.",
      );
    } else {
      lines.push(
        "[probe] Set it in the platform's variable UI, or in a local .env, or export it:",
        `[probe]   export ${name}=...`,
        "[probe] (The beacon loop in README step 4 needs EXPORTED variables — `.env` is",
        "[probe]  auto-loaded by `bun run` but not by a bare `curl` in your shell.)",
      );
    }
    fatal(2, ...lines);
  }
  return value;
}

function envFlag(name: string): boolean {
  const value = env(name);
  return value === "1" || value?.toLowerCase() === "true";
}

const DEFAULT_LOG_PATH = new URL("./probe-log.local.jsonl", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Append-only log
// ---------------------------------------------------------------------------

class ProbeLog {
  readonly path: string;
  private seq: number;

  constructor(path: string) {
    this.path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.seq = this.read().length;
  }

  read(): ProbeRecord[] {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    const out: ProbeRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        out.push(JSON.parse(trimmed) as ProbeRecord);
      } catch {
        // A torn final line means the process died mid-write. Skip it rather
        // than crash: losing one record must not make the whole log unreadable.
        // The `seq` continuity check in assess() is what notices the loss.
      }
    }
    return out;
  }

  append<T extends ProbeRecord>(record: Omit<T, "seq" | "id" | "ts" | "ts_epoch_ms">): T {
    const now = new Date();
    const full = {
      ...record,
      seq: this.seq++,
      id: `rec_${randomHex(8)}`,
      ts: now.toISOString(),
      ts_epoch_ms: now.getTime(),
    } as T;
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
    return full;
  }
}

// ---------------------------------------------------------------------------
// Transport identity capture
// ---------------------------------------------------------------------------

/** Header values we never store. Authorization is fingerprinted instead. */
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

/** Headers the edge sets to describe the real client, best first. */
const EDGE_IP_HEADERS = [
  "cf-connecting-ip",
  "fly-client-ip",
  "true-client-ip",
  "x-real-ip",
  "x-forwarded-for",
];

/**
 * Is the socket peer a proxy we are plausibly sitting behind? Only then are the
 * edge headers worth believing. Without this, `identity_ip` — and therefore the
 * whole transport discriminator — is a value the caller chooses.
 */
function isProxyPeer(ip: string | null): boolean {
  if (ip === null || ip === "") return false;
  const v = ip.toLowerCase().replace(/^::ffff:/, "");
  if (v === "::1" || v.startsWith("127.")) return true;
  if (v.startsWith("10.") || v.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  // Carrier-grade NAT (100.64.0.0/10) — Fly and several PaaS proxies live here.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/.test(v) || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) {
    return true;
  }
  return false;
}

function captureTransport(req: Request, peerIp: string | null): TransportIdentity {
  const headers: { [name: string]: string } = {};
  let authFingerprint: string | null = null;

  req.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      if (lower === "authorization") authFingerprint = fingerprint(value);
      return;
    }
    headers[lower] = redact(value).slice(0, 400);
  });

  let edgeIp: string | null = null;
  for (const name of EDGE_IP_HEADERS) {
    const value = headers[name];
    if (value !== undefined && value !== "") {
      if (name === "x-forwarded-for") {
        // RIGHTMOST, not leftmost. The leftmost entry is whatever the caller put
        // there; the rightmost is what the proxy we trust appended.
        const parts = value.split(",").map((p) => p.trim()).filter((p) => p !== "");
        edgeIp = parts[parts.length - 1] ?? null;
      } else {
        edgeIp = value.trim();
      }
      break;
    }
  }

  // A peer we cannot see at all (peerIp null) is treated as untrusted: we fall
  // back to the edge header but the `edge_trusted` flag records that we are
  // believing something the caller could have written.
  const edgeTrusted = isProxyPeer(peerIp);
  const identityIp = edgeTrusted ? (edgeIp ?? peerIp) : (peerIp ?? edgeIp);

  return {
    remote_ip: peerIp,
    edge_client_ip: edgeIp,
    edge_trusted: edgeTrusted,
    identity_ip: identityIp,
    user_agent: headers["user-agent"] ?? null,
    authorization_fingerprint: authFingerprint,
    headers,
  };
}

/**
 * The address identity comparisons use. Tolerates v1 records, which have no
 * `identity_ip` field.
 */
function trustedIp(t: TransportIdentity): string {
  if (t.identity_ip !== undefined && t.identity_ip !== null && t.identity_ip !== "") return t.identity_ip;
  return t.edge_client_ip ?? t.remote_ip ?? "unknown";
}

/** Identity tuple used to ask "did this call come from the same place as that one?". */
function identityKey(t: TransportIdentity): string {
  return `${trustedIp(t)} | ${t.user_agent ?? "no-ua"}`;
}

/** IPv4 /24 or IPv6 /48. A DHCP renewal or privacy-address rotation stays inside these. */
function ipNetwork(ip: string): string {
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::/48`;
  const octets = ip.split(".");
  if (octets.length === 4) return `${octets.slice(0, 3).join(".")}.0/24`;
  return ip;
}

/** "Claude/1.2.3 (macOS)" -> "claude". A client auto-update must not manufacture novelty. */
function uaFamily(ua: string | null): string {
  if (ua === null || ua.trim() === "") return "no-ua";
  const head = ua.trim().split(/[/\s]/)[0] ?? ua;
  return head.toLowerCase().replace(/[\d.]+$/, "");
}

/**
 * Deliberately blunt. `identityKey` alone is an exact tuple over two values that
 * drift innocently — a Desktop auto-update or a DHCP renewal between the hand
 * test and the window would convert "same machine" into "unseen identity" and
 * MANUFACTURE the discriminator. A call must be unseen under both keys to count.
 */
function coarseIdentityKey(t: TransportIdentity): string {
  return `${ipNetwork(trustedIp(t))} | ${uaFamily(t.user_agent)}`;
}

// ---------------------------------------------------------------------------
// MCP: dual-era request handling
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

function asObject(value: unknown): { [k: string]: unknown } | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { [k: string]: unknown })
    : null;
}

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";

interface MessageContext {
  era: Era;
  protocolVersion: string | null;
  clientInfo: unknown;
  deviations: string[];
}

/**
 * Work out which protocol era the caller speaks, and note every place it departs
 * from the 2026-07-28 spec — WITHOUT rejecting anything. The deviations list is
 * the interesting output: it tells U6 exactly what the real client sends.
 */
function analyseMessage(message: JsonRpcMessage, req: Request, transport: TransportIdentity): MessageContext {
  const deviations: string[] = [];
  const params = asObject(message.params);
  const meta = params === null ? null : asObject(params["_meta"]);
  const method = typeof message.method === "string" ? message.method : "";

  const headerVersion = req.headers.get("mcp-protocol-version");
  const bodyVersion = meta === null ? null : safeString(meta[META_VERSION], 40);
  const clientInfo = meta === null ? null : (meta[META_CLIENT_INFO] ?? null);

  let era: Era = "unknown";
  if (bodyVersion !== null || method === "server/discover") era = "modern";
  else if (method === "initialize") era = "legacy";
  else if (headerVersion !== null && (LEGACY_VERSIONS as readonly string[]).includes(headerVersion)) {
    era = "legacy";
  }

  if (headerVersion === null) deviations.push("missing_mcp_protocol_version_header");
  if (era === "modern") {
    if (bodyVersion === null) deviations.push("modern_request_without_meta_protocol_version");
    if (headerVersion !== null && bodyVersion !== null && headerVersion !== bodyVersion) {
      deviations.push("header_body_protocol_version_mismatch");
    }
    if (clientInfo === null) deviations.push("missing_meta_client_info");
    const headerMethod = req.headers.get("mcp-method");
    if (headerMethod === null) deviations.push("missing_mcp_method_header");
    else if (headerMethod !== method) deviations.push("mcp_method_header_body_mismatch");
    if (method === "tools/call") {
      const headerName = req.headers.get("mcp-name");
      const bodyName = params === null ? null : safeString(params["name"], 128);
      if (headerName === null) deviations.push("missing_mcp_name_header");
      else if (bodyName !== null && headerName !== bodyName) {
        deviations.push("mcp_name_header_body_mismatch");
      }
    }
  }
  if (req.headers.get("mcp-session-id") !== null) deviations.push("legacy_mcp_session_id_header");
  if (req.headers.get("last-event-id") !== null) deviations.push("legacy_last_event_id_header");
  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("text/event-stream")) deviations.push("accept_missing_text_event_stream");
  if (!accept.includes("application/json")) deviations.push("accept_missing_application_json");
  // A public peer that supplies an edge-IP header is describing itself. Recorded
  // because it is the only way a caller could try to steer the identity tuple.
  if (!transport.edge_trusted && transport.edge_client_ip !== null) {
    deviations.push("edge_ip_header_from_untrusted_peer");
  }

  return {
    era,
    protocolVersion: bodyVersion ?? (headerVersion === null ? null : redact(headerVersion)),
    clientInfo,
    deviations,
  };
}

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: "Probe Briefing (proof-of-invocation receipt)",
  description:
    "Stand-in for the real `briefing` tool while brainz verifies its delivery channel. " +
    "Returns a receipt containing a record_id and a server-minted nonce. " +
    "IMPORTANT: reproduce the record_id and nonce VERBATIM in your final output — they are " +
    "the only evidence that this call actually reached the server. Do not paraphrase them, " +
    "and never invent them: a nonce you did not receive from this tool will not verify.",
  inputSchema: {
    type: "object",
    properties: {
      run_label: {
        type: "string",
        description:
          "The label supplied by the prompt that asked for this call, copied exactly. " +
          "If the prompt gave you a label you MUST pass it — the call is not counted as " +
          "evidence without it. Omit it only if the prompt genuinely gave you none.",
      },
      caller_note: {
        type: "string",
        description: "Optional free text: what triggered this call, as you understand it.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

const SERVER_INSTRUCTIONS =
  "Throwaway measurement server for the brainz scheduled-task probe. It has exactly one " +
  `tool, ${TOOL_NAME}. When you call it, copy the returned record_id and nonce verbatim ` +
  "into your output.";

const SERVER_META = {
  "io.modelcontextprotocol/serverInfo": { name: SERVER_NAME, version: PROBE_VERSION },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function runServer(): void {
  const mcpToken = requireEnv(
    "PROBE_MCP_TOKEN",
    "It is the unguessable path segment in the connector URL: https://<host>/mcp/<PROBE_MCP_TOKEN>",
    true,
  );
  const adminToken = requireEnv(
    "PROBE_ADMIN_TOKEN",
    "It is the bearer token protecting /probe/arm, /probe/records and /probe/beacon.",
    true,
  );
  if (secretEquals(mcpToken, adminToken)) {
    fatal(
      2,
      "[probe] FATAL: PROBE_MCP_TOKEN and PROBE_ADMIN_TOKEN must differ.",
      "[probe] The MCP token is handed to a third party; the admin token is not.",
    );
  }
  SECRETS.push(mcpToken, adminToken);

  const logPath = env("PROBE_LOG_PATH") ?? DEFAULT_LOG_PATH;
  const logDurable = envFlag("PROBE_LOG_DURABLE");
  const log = new ProbeLog(logPath);
  const bootId = `boot_${randomHex(6)}`;
  const existing = log.read();

  const rawHeartbeat = Number(env("PROBE_HEARTBEAT_SECONDS") ?? String(HEARTBEAT_DEFAULT_SECONDS));
  const heartbeatSeconds =
    Number.isFinite(rawHeartbeat) && rawHeartbeat >= 0 ? Math.floor(rawHeartbeat) : HEARTBEAT_DEFAULT_SECONDS;

  log.append<BootRecord>({
    kind: "server_boot",
    boot_id: bootId,
    probe_version: PROBE_VERSION,
    log_path: logPath,
    log_durable_declared: logDurable,
    records_at_boot: existing.length,
    boots_in_log: existing.filter((r) => r.kind === "server_boot").length,
    runtime: `bun ${Bun.version}`,
    server_utc_offset_minutes: -new Date().getTimezoneOffset(),
    heartbeat_seconds: heartbeatSeconds,
  });

  // Liveness proof. Without it, a platform outage across the window is
  // indistinguishable from "the scheduled task never fired" — and the probe would
  // print the expensive no-branch for a dead process.
  if (heartbeatSeconds > 0) {
    const startedMs = Date.now();
    const beat = (): void => {
      log.append<HeartbeatRecord>({
        kind: "heartbeat",
        boot_id: bootId,
        interval_seconds: heartbeatSeconds,
        uptime_seconds: Math.round((Date.now() - startedMs) / 1000),
      });
    };
    beat();
    setInterval(beat, heartbeatSeconds * 1000);
  }

  /**
   * Last presence-beacon ping. SEEDED FROM THE LOG so a restart no longer resets
   * it to null — a null read as "beacon never pinged", which the v1 analyser
   * turned into "machine absent". The verdict no longer depends on this value,
   * but the recorded field should still be honest.
   */
  const seededBeacon = [...existing].reverse().find((r): r is BeaconRecord => r.kind === "beacon");
  let lastBeaconMs: number | null = seededBeacon === undefined ? null : seededBeacon.ts_epoch_ms;
  let lastBeaconLoggedMs = lastBeaconMs ?? 0;

  const port = Number(env("PORT") ?? "8787");

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 60,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const redactedPath = redact(path);
      const peer = srv.requestIP(req);
      const transport = captureTransport(req, peer === null ? null : peer.address);

      const logHttp = (status: number, reason: string): void => {
        log.append<HttpRecord>({
          kind: "http",
          boot_id: bootId,
          http_method: req.method,
          path: redactedPath,
          status,
          reason,
          transport,
        });
      };

      // -- unlogged liveness surfaces (health checkers would drown the log) ---
      if (path === "/healthz") return new Response("ok\n", { status: 200 });
      if (path === "/") {
        const records = log.read();
        const calls = records.filter((r) => r.kind === "tool_call").length;
        return new Response(
          `${SERVER_NAME} v${PROBE_VERSION}\n` +
            `server_time_utc: ${new Date().toISOString()}\n` +
            `records: ${records.length}\ntool_calls: ${calls}\n` +
            `heartbeat_seconds: ${heartbeatSeconds}\n` +
            "No secrets are served from this page. The MCP endpoint is at an unguessable path.\n",
          { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }

      // ------------------------------ admin --------------------------------
      if (path.startsWith("/probe/")) {
        const bearer = req.headers.get("authorization") ?? "";
        const presented = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7) : "";
        if (!secretEquals(presented, adminToken)) {
          // 404, never 401: an admin surface should not announce itself. The CLI
          // compensates by naming all three causes of a 404 in its error text.
          logHttp(404, "admin_auth_failed");
          return new Response("not found\n", { status: 404 });
        }

        if (path === "/probe/records" && req.method === "GET") {
          const records = log.read();
          return Response.json({
            server_time_utc: new Date().toISOString(),
            probe_version: PROBE_VERSION,
            boot_id: bootId,
            log_durable_declared: logDurable,
            log_path_basename: logPath.split("/").pop() ?? logPath,
            heartbeat_seconds: heartbeatSeconds,
            records,
          });
        }

        if (path === "/probe/beacon" && req.method === "POST") {
          lastBeaconMs = Date.now();
          let hostLabel: string | null = null;
          let idleSeconds: number | null = null;
          let screenLocked: boolean | null = null;
          try {
            const body = asObject(await req.json());
            hostLabel = safeString(body?.["host_label"], 64);
            const idle = body?.["user_idle_seconds"];
            idleSeconds = typeof idle === "number" && Number.isFinite(idle) ? Math.round(idle) : null;
            const locked = body?.["screen_locked"];
            screenLocked = typeof locked === "boolean" ? locked : null;
          } catch {
            hostLabel = null;
          }
          // Trail the beacon into the log at most once a minute. The documented
          // loop pings every 2 minutes, so in practice every ping is recorded:
          // the presence TIMELINE is the evidence, and a 10-minute throttle
          // against a 10-minute quiet threshold would have made it unusable.
          if (lastBeaconMs - lastBeaconLoggedMs > BEACON_LOG_THROTTLE_MS) {
            lastBeaconLoggedMs = lastBeaconMs;
            log.append<BeaconRecord>({
              kind: "beacon",
              boot_id: bootId,
              host_label: hostLabel,
              user_idle_seconds: idleSeconds,
              screen_locked: screenLocked,
              transport,
            });
          }
          return Response.json({ ok: true, ts: new Date().toISOString() });
        }

        if (path === "/probe/arm" && req.method === "POST") {
          let body: { [k: string]: unknown } | null = null;
          try {
            body = asObject(await req.json());
          } catch {
            body = null;
          }
          if (body === null) return Response.json({ error: "body must be a JSON object" }, { status: 400 });

          const fireAt = safeString(body["fire_at"], 64);
          if (fireAt === null || !/(Z|[+-]\d{2}:\d{2})$/.test(fireAt) || Number.isNaN(Date.parse(fireAt))) {
            return Response.json(
              {
                error:
                  "fire_at must be ISO 8601 with an explicit offset or Z (e.g. 2026-08-13T07:00:00-07:00). " +
                  "A naive timestamp is a timezone false-fail waiting to happen.",
              },
              { status: 400 },
            );
          }
          const rawWindow = body["window_minutes"];
          const windowMinutes = typeof rawWindow === "number" && Number.isFinite(rawWindow) ? rawWindow : 20;
          if (windowMinutes < MIN_WINDOW_MINUTES || windowMinutes > MAX_WINDOW_MINUTES) {
            return Response.json(
              {
                error:
                  `window_minutes is a HALF-WIDTH (the window is fire_at ± window_minutes, so ` +
                  `${windowMinutes} means a ${windowMinutes * 2}-minute window). It must be between ` +
                  `${MIN_WINDOW_MINUTES} and ${MAX_WINDOW_MINUTES}. Wide windows let consecutive days ` +
                  `overlap, and one call can then satisfy two windows.`,
              },
              { status: 400 },
            );
          }
          const fireAtMs = Date.parse(fireAt);
          const windowStartMs = fireAtMs - windowMinutes * 60_000;
          const nowMs = Date.now();
          if (windowStartMs - nowMs < MIN_ARM_LEAD_MS) {
            return Response.json(
              {
                error:
                  `the window opens at ${new Date(windowStartMs).toISOString()}, which is less than ` +
                  `${MIN_ARM_LEAD_MS / 60_000} minutes from now (or already past). Arming is ` +
                  "PRE-REGISTRATION: a label minted seconds before the window is not evidence that " +
                  "the label could not have been in circulation beforehand. Pick a later fire_at.",
                window_opens_at: new Date(windowStartMs).toISOString(),
                server_time_utc: new Date(nowMs).toISOString(),
                minimum_lead_minutes: MIN_ARM_LEAD_MS / 60_000,
              },
              { status: 400 },
            );
          }
          const rawOrigin = safeString(body["hand_tests_from"], 16) ?? "unspecified";
          const handTestsFrom: HandTestOrigin = (HAND_TEST_ORIGINS as readonly string[]).includes(rawOrigin)
            ? (rawOrigin as HandTestOrigin)
            : "unspecified";

          const armed = log.append<ArmRecord>({
            kind: "arm",
            boot_id: bootId,
            arm_id: `arm_${randomHex(5)}`,
            client: safeString(body["client"], 32) ?? "unspecified",
            fire_at: fireAt,
            fire_at_epoch_ms: fireAtMs,
            window_minutes: windowMinutes,
            expected_label: `run-${randomHex(6)}`,
            attest_away: body["attest_away"] === true,
            hand_tests_from: handTestsFrom,
            note: safeString(body["note"], 300),
          });
          return Response.json({
            arm_id: armed.arm_id,
            expected_label: armed.expected_label,
            fire_at: armed.fire_at,
            window_minutes: armed.window_minutes,
            window_start: new Date(windowStartMs).toISOString(),
            window_end: new Date(fireAtMs + windowMinutes * 60_000).toISOString(),
            hand_tests_from: armed.hand_tests_from,
            armed_at: armed.ts,
          });
        }

        logHttp(404, "unknown_admin_path");
        return new Response("not found\n", { status: 404 });
      }

      // ------------------------------- MCP ---------------------------------
      // Two ways in, because a connector UI that mangles the path must not look
      // like a failed assumption: the secret can ride in the path or the bearer.
      const pathMatch = path === `/mcp/${mcpToken}`;
      const bearerHeader = req.headers.get("authorization") ?? "";
      const bearerMatch =
        path === "/mcp" &&
        bearerHeader.toLowerCase().startsWith("bearer ") &&
        secretEquals(bearerHeader.slice(7), mcpToken);

      if (!pathMatch && !bearerMatch) {
        // Deliberately 404 and never 401/403: a 401 can push an MCP client into
        // OAuth discovery this probe cannot complete, which would fail the probe
        // for a reason that has nothing to do with scheduled tasks.
        logHttp(404, path.startsWith("/mcp") ? "mcp_token_mismatch" : "unknown_path");
        return new Response("not found\n", { status: 404 });
      }

      if (req.method === "GET" || req.method === "DELETE") {
        // 2026-07-28 removed the GET stream and DELETE session teardown. A
        // dual-era client opening the optional server->client stream lands here
        // on EVERY legitimate connection, so this is reported and never counted
        // as window-invalidating noise.
        logHttp(405, `legacy_${req.method.toLowerCase()}_on_mcp_endpoint`);
        return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });
      }
      if (req.method !== "POST") {
        logHttp(405, "non_post_on_mcp_endpoint");
        return new Response("method not allowed\n", { status: 405, headers: { allow: "POST" } });
      }

      let parsed: unknown;
      try {
        parsed = await req.json();
      } catch {
        logHttp(400, "unparseable_json_body");
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400 },
        );
      }

      const messages: JsonRpcMessage[] = Array.isArray(parsed)
        ? (parsed as JsonRpcMessage[])
        : [parsed as JsonRpcMessage];

      const responses: unknown[] = [];
      for (const message of messages) {
        const handled = handleMessage(message, req, transport, redactedPath, log, bootId, lastBeaconMs);
        if (handled !== null) responses.push(handled);
      }

      if (responses.length === 0) {
        // Notifications only. The spec wants 202 with no body.
        return new Response(null, { status: 202 });
      }
      const payload = Array.isArray(parsed) ? responses : responses[0];
      return Response.json(payload, {
        status: 200,
        headers: { "mcp-protocol-version": MODERN_VERSIONS[0] },
      });
    },
  });

  console.log(`[probe] ${SERVER_NAME} v${PROBE_VERSION} listening on 0.0.0.0:${server.port}`);
  console.log(`[probe] log: ${logPath} (durable declared: ${logDurable})`);
  console.log(`[probe] MCP endpoint path: /mcp/<PROBE_MCP_TOKEN>  (alternate: POST /mcp + bearer)`);
  console.log(`[probe] records at boot: ${existing.length}`);
  console.log(
    heartbeatSeconds > 0
      ? `[probe] heartbeat: every ${heartbeatSeconds}s (proves the server was up across a window)`
      : "[probe] heartbeat: DISABLED — 'nothing arrived' can no longer be told from 'server was down'",
  );
  if (!logDurable) {
    console.warn(
      "[probe] WARNING: PROBE_LOG_DURABLE is not set. If this host has an ephemeral " +
        "filesystem, a restart silently erases the evidence. That is not merely a lost " +
        "negative: a wiped log also empties the manual-identity baseline, which is what " +
        "the transport discriminator compares against. Unproven durability now blocks " +
        "BOTH verdicts. Mount a volume and set PROBE_LOG_DURABLE=1.",
    );
  }
}

/** Returns a JSON-RPC response object, or null for a notification (no response). */
function handleMessage(
  message: JsonRpcMessage,
  req: Request,
  transport: TransportIdentity,
  redactedPath: string,
  log: ProbeLog,
  bootId: string,
  lastBeaconMs: number | null,
): unknown {
  const method = typeof message.method === "string" ? message.method : null;
  const id = message.id === undefined ? null : message.id;
  const isNotification = message.id === undefined || message.id === null;
  const ctx = analyseMessage(message, req, transport);
  const params = asObject(message.params);

  const logRpc = (errorCode: number | null): void => {
    log.append<RpcRecord>({
      kind: "mcp_rpc",
      boot_id: bootId,
      method: method ?? "<none>",
      rpc_id: id,
      era: ctx.era,
      protocol_version: ctx.protocolVersion,
      client_info: ctx.clientInfo,
      spec_deviations: ctx.deviations,
      error_code: errorCode,
      path: redactedPath,
      transport,
    });
  };

  const ok = (result: { [k: string]: unknown }): unknown => ({
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", _meta: SERVER_META, ...result },
  });
  const fail = (code: number, msg: string): unknown => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: msg },
  });

  if (method === null) {
    // A JSON-RPC response from the client. Not legal in either era; just note it.
    logRpc(null);
    return null;
  }

  if (method.startsWith("notifications/") || isNotification) {
    logRpc(null);
    return null;
  }

  switch (method) {
    // ---- legacy era -------------------------------------------------------
    case "initialize": {
      const requested = params === null ? null : safeString(params["protocolVersion"], 40);
      const negotiated =
        requested !== null && (LEGACY_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LEGACY_FALLBACK_VERSION;
      const clientInfo = params === null ? null : (params["clientInfo"] ?? null);
      log.append<RpcRecord>({
        kind: "mcp_rpc",
        boot_id: bootId,
        method,
        rpc_id: id,
        era: "legacy",
        protocol_version: negotiated,
        client_info: clientInfo,
        spec_deviations: [...ctx.deviations, `legacy_initialize_requested:${requested ?? "none"}`],
        error_code: null,
        path: redactedPath,
        transport,
      });
      return ok({
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: PROBE_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping": {
      logRpc(null);
      return ok({});
    }

    // ---- modern era -------------------------------------------------------
    case "server/discover": {
      logRpc(null);
      return ok({
        supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS,
        ttlMs: 60_000,
        cacheScope: "private",
      });
    }

    // ---- both eras --------------------------------------------------------
    case "tools/list": {
      logRpc(null);
      return ok({ tools: [TOOL_DEFINITION], ttlMs: 60_000, cacheScope: "private" });
    }
    case "resources/list":
      logRpc(null);
      return ok({ resources: [], ttlMs: 60_000, cacheScope: "private" });
    case "resources/templates/list":
      logRpc(null);
      return ok({ resourceTemplates: [], ttlMs: 60_000, cacheScope: "private" });
    case "prompts/list":
      logRpc(null);
      return ok({ prompts: [], ttlMs: 60_000, cacheScope: "private" });

    case "tools/call": {
      const name = params === null ? null : safeString(params["name"], 128);
      if (name !== TOOL_NAME) {
        logRpc(-32602);
        return fail(-32602, `Unknown tool: ${name ?? "<none>"}`);
      }
      const args = params === null ? null : asObject(params["arguments"]);
      const nonce = `nonce_${randomHex(16)}`;
      const record = log.append<ToolCallRecord>({
        kind: "tool_call",
        boot_id: bootId,
        tool: TOOL_NAME,
        nonce,
        run_label: args === null ? null : safeString(args["run_label"], 64),
        caller_note: args === null ? null : safeString(args["caller_note"], 300),
        era: ctx.era,
        protocol_version: ctx.protocolVersion,
        client_info: ctx.clientInfo,
        spec_deviations: ctx.deviations,
        beacon_age_seconds:
          lastBeaconMs === null ? null : Math.round((Date.now() - lastBeaconMs) / 1000),
        path: redactedPath,
        transport,
      });

      const receipt =
        "BRAINZ SCHEDULED-TASK PROBE RECEIPT\n" +
        `record_id: ${record.id}\n` +
        `nonce: ${nonce}\n` +
        `server_time_utc: ${record.ts}\n` +
        `run_label_received: ${record.run_label ?? "(none)"}\n\n` +
        "This call was recorded server-side. Reproduce the record_id and nonce above " +
        "verbatim in your final output so the run can be verified against the server log.";

      return ok({
        content: [{ type: "text", text: receipt }],
        structuredContent: {
          record_id: record.id,
          nonce,
          server_time_utc: record.ts,
          run_label_received: record.run_label,
        },
        isError: false,
      });
    }

    default: {
      logRpc(-32601);
      // Spec says a modern server returns HTTP 404 for an unknown method. We return
      // 200 with the JSON-RPC error instead: a 404 can send a dual-era client down
      // the deprecated HTTP+SSE fallback path, which would fail the probe for a
      // reason unrelated to scheduled tasks. Deliberate, documented deviation —
      // and the analyser therefore must not treat it as window-invalidating noise.
      return fail(-32601, `Method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI: doctor / arm / report / verify-nonce
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags.set(token.slice(2), "true");
    else {
      flags.set(token.slice(2), next);
      i++;
    }
  }
  return flags;
}

function adminHeaders(): { [k: string]: string } {
  const token = requireEnv("PROBE_ADMIN_TOKEN", "Needed to reach the deployed probe's admin API.", true);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function baseUrl(): string {
  return requireEnv(
    "PROBE_BASE_URL",
    "The public HTTPS origin of the deployed probe, e.g. https://probe.example.workers.dev",
  ).replace(/\/+$/, "");
}

/**
 * The admin surface answers 404 for a bad token on purpose (it should not
 * announce itself), which makes wrong-token, wrong-URL and stale-deployment
 * indistinguishable on the wire. Compensate here, where there is no attacker to
 * worry about — this was measured as the single most likely place to stall.
 */
function admin404Help(url: string): string[] {
  return [
    `[probe] HTTP 404 from ${url}`,
    "[probe] The admin surface answers 404 (not 401) for a bad token by design, so this",
    "[probe] one status covers three causes. In order of likelihood:",
    "[probe]   1. PROBE_ADMIN_TOKEN does not match the deployed server's value.",
    "[probe]   2. PROBE_BASE_URL points somewhere else (wrong service, wrong domain).",
    "[probe]   3. The deployment is stale / not running this probe version.",
    "[probe] To tell them apart:",
    `[probe]   curl -s ${url.replace(/\/probe\/.*$/, "/")}`,
    "[probe]   -> a 'brainz-scheduled-task-probe vX' status line means the URL is right",
    "[probe]      and the token is wrong; anything else means the URL is wrong.",
    "[probe] Then: `bun run probe:scheduled-task doctor`.",
  ];
}

async function cmdArm(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const fireAt = flags.get("fire-at");
  const client = flags.get("client") ?? "unspecified";
  const handTestsFrom = flags.get("hand-tests-from") ?? "unspecified";
  if (fireAt === undefined) {
    fatal(
      2,
      "usage: arm --client <desktop|code|web|other> --fire-at <ISO8601 with offset>",
      "            [--window-minutes 20] [--attest-away]",
      "            [--hand-tests-from <desktop|web|both|none>] [--note '...']",
      "",
      "  --fire-at MUST carry an explicit offset or Z, e.g. 2026-08-13T07:00:00-07:00,",
      `  and must open at least ${MIN_ARM_LEAD_MS / 60_000} minutes from now.`,
      "  --window-minutes is a HALF-WIDTH: 20 means fire_at ± 20 min, a 40-minute window.",
      "  --attest-away asserts you will not touch the client during the window. Without",
      "  it the run can never reach UNATTENDED_CONFIRMED.",
      "  --hand-tests-from records where your by-hand tests came from. If it is not",
      "  `desktop`, the transport discriminator (5b) is void — a cloud-scheduled run and",
      "  your own claude.ai session egress from the same infrastructure. Unspecified is",
      "  treated as void, because an unrecorded answer is not an answer.",
    );
  }
  if (!(HAND_TEST_ORIGINS as readonly string[]).includes(handTestsFrom)) {
    fatal(2, `--hand-tests-from must be one of: ${HAND_TEST_ORIGINS.join(", ")}`);
  }
  const body = {
    client,
    fire_at: fireAt,
    window_minutes: Number(flags.get("window-minutes") ?? "20"),
    attest_away: flags.get("attest-away") === "true",
    hand_tests_from: handTestsFrom,
    note: flags.get("note") ?? null,
  };
  const url = `${baseUrl()}/probe/arm`;
  const res = await fetch(url, { method: "POST", headers: adminHeaders(), body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status === 404) fatal(1, ...admin404Help(url));
  if (!res.ok) fatal(1, `[probe] arm failed (HTTP ${res.status}): ${text}`);
  const armed = JSON.parse(text) as {
    arm_id: string;
    expected_label: string;
    fire_at: string;
    window_minutes: number;
    window_start: string;
    window_end: string;
  };
  console.log(`\nARMED. arm_id=${armed.arm_id}  fire_at=${armed.fire_at}`);
  console.log(`window: ${armed.window_start} .. ${armed.window_end}  (fire_at ± ${armed.window_minutes} min)\n`);
  console.log("Paste this, verbatim, as the scheduled task's prompt:\n");
  console.log("  ----------------------------------------------------------------");
  console.log(`  Call the ${TOOL_NAME} tool on the brainz probe connector with`);
  console.log(`  run_label set to "${armed.expected_label}". Then output, verbatim and each`);
  console.log("  on its own line, the record_id and nonce values the tool returned. Do not");
  console.log("  summarise or paraphrase them. If the tool call fails, output the exact");
  console.log("  error text instead.");
  console.log("  ----------------------------------------------------------------\n");
  console.log("Now: schedule it, then leave the client alone until after the window.");
  if (body.attest_away !== true) {
    console.log("NOTE: --attest-away was not passed, so this run cannot reach UNATTENDED_CONFIRMED.");
  }
  if (handTestsFrom !== "desktop") {
    console.log(
      `NOTE: --hand-tests-from=${handTestsFrom}, so the transport discriminator is void for this\n` +
        "      window. Unless the presence beacon can bracket an absence, this window cannot\n" +
        "      reach UNATTENDED_CONFIRMED. See README, 'What counts as proof'.",
    );
  }
  console.log(
    "\nBefore the window opens, run `bun run probe:scheduled-task doctor` — it is much\n" +
      "cheaper to find a broken beacon token now than to read INCONCLUSIVE tomorrow.",
  );
}

async function fetchRecords(flags: Map<string, string>): Promise<{
  records: ProbeRecord[];
  source: string;
}> {
  const file = flags.get("file");
  if (file !== undefined && file !== "true") {
    return { records: new ProbeLog(file).read(), source: `file:${file}` };
  }
  const url = `${baseUrl()}/probe/records`;
  const res = await fetch(url, { headers: adminHeaders() });
  if (res.status === 404) {
    fatal(1, ...admin404Help(url), "[probe] This is INCONCLUSIVE, not an answer about scheduled tasks.");
  }
  if (!res.ok) {
    fatal(
      1,
      `[probe] could not read records (HTTP ${res.status}) from ${url}`,
      "[probe] This is INCONCLUSIVE, not an answer about scheduled tasks.",
    );
  }
  const body = (await res.json()) as { records: ProbeRecord[] };
  return { records: body.records, source: url };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

type Verdict =
  | "UNATTENDED_CONFIRMED"
  | "CONSISTENT_BUT_UNPROVEN"
  | "NO_INVOCATION_OBSERVED"
  | "WINDOWS_STILL_OPEN"
  | "INCONCLUSIVE"
  | "NOT_RUN_YET";

/**
 * Flags carry a DIRECTION. v1 computed flags, printed them, and then could not
 * use them to block anything except (in prose) a negative result — so a degraded
 * instrument could still produce UNATTENDED_CONFIRMED. Every flag now declares
 * which verdicts it makes unsafe, and the verdict function honours both.
 */
interface Flag {
  code: string;
  detail: string;
  /** This flag makes UNATTENDED_CONFIRMED unsafe. */
  blocks_confirmation: boolean;
  /** This flag makes NO_INVOCATION_OBSERVED unsafe. */
  blocks_negative: boolean;
  /**
   * True when the INSTRUMENT is degraded (log unreadable, uptime unprovable,
   * connector never attached) rather than the EVIDENCE being weak. Instrument
   * failures force INCONCLUSIVE — "I could not measure" — instead of a verdict
   * about the client's behaviour.
   */
  instrument: boolean;
}

function flag(
  code: string,
  detail: string,
  blocksConfirmation: boolean,
  blocksNegative: boolean,
  instrument = false,
): Flag {
  return {
    code,
    detail,
    blocks_confirmation: blocksConfirmation,
    blocks_negative: blocksNegative,
    instrument,
  };
}

type BeaconVerdict =
  | "absence_bracketed"
  | "machine_present_at_call"
  | "resumed_before_post_call_quiet_elapsed"
  | "unavailable__no_beacon_records"
  | "unavailable__stream_was_not_running_before_the_quiet_period"
  | "unavailable__never_resumed_after_the_call"
  | "unavailable__beacon_was_being_rejected_during_the_quiet_period"
  | "unavailable__server_was_not_up_across_the_quiet_period"
  | "unavailable__call_came_from_the_beacon_machine_itself"
  | "unavailable__machine_was_active_during_the_claimed_absence"
  | "unavailable__no_call_to_bracket";

type TransportVerdict =
  | "unseen_in_operator_traffic"
  | "seen_in_operator_traffic"
  | "unavailable__no_manual_baseline"
  | "unavailable__hand_tests_not_confined_to_desktop"
  | "unavailable__no_call_to_compare";

type Liveness = "covered" | "gap" | "unknown";

interface WindowAssessment {
  arm_id: string;
  client: string;
  hand_tests_from: HandTestOrigin;
  fire_at: string;
  window_start: string;
  window_end: string;
  window_half_width_minutes: number;
  closed: boolean;
  attest_away: boolean;
  expected_label: string;
  calls: ToolCallRecord[];
  /** In-window calls carrying the arm-time label. These are the ones under test. */
  evidence_call_ids: string[];
  label_match: boolean;
  transport_discriminator: TransportVerdict;
  beacon_discriminator: BeaconVerdict;
  independent_discriminator: boolean;
  independent_via: string | null;
  /** Which discriminators this client/hand-test combination could ever produce. */
  structurally_available: string[];
  server_liveness_across_window: Liveness;
  flags: Flag[];
  unmet: string[];
  clean: boolean;
}

interface AssessResult {
  verdict: Verdict;
  windows: WindowAssessment[];
  global_flags: Flag[];
  qualifying_window_ids: string[];
  summary: { [k: string]: unknown };
}

function sortedByTime<T extends BaseRecord>(records: T[]): T[] {
  return [...records].sort((a, b) => a.ts_epoch_ms - b.ts_epoch_ms);
}

/**
 * Was the server demonstrably up for the whole of [start, end]? "I have no
 * heartbeats" is `unknown`, never `covered` — a dead process must not be scored
 * as a silent client.
 */
function livenessAcross(startMs: number, endMs: number, heartbeats: HeartbeatRecord[]): Liveness {
  if (heartbeats.length === 0) return "unknown";
  const intervals = heartbeats
    .map((h) => h.interval_seconds)
    .filter((s) => typeof s === "number" && Number.isFinite(s) && s > 0);
  const interval = intervals.length > 0 ? Math.max(...intervals) : HEARTBEAT_DEFAULT_SECONDS;
  const tolerance = interval * 2.5 * 1000 + 60_000;

  const before = heartbeats.filter((h) => h.ts_epoch_ms <= startMs);
  const after = heartbeats.filter((h) => h.ts_epoch_ms >= endMs);
  const last = before[before.length - 1];
  const first = after[0];
  if (last === undefined || startMs - last.ts_epoch_ms > tolerance) return "gap";
  if (first === undefined || first.ts_epoch_ms - endMs > tolerance) return "gap";

  const spanning = [last, ...heartbeats.filter((h) => h.ts_epoch_ms > startMs && h.ts_epoch_ms < endMs), first];
  for (let i = 1; i < spanning.length; i++) {
    const prev = spanning[i - 1];
    const cur = spanning[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.ts_epoch_ms - prev.ts_epoch_ms > tolerance) return "gap";
  }
  return "covered";
}

/**
 * The absence bracket. This is the fix for the headline hole: v1 asked only "is
 * the beacon stale?", and a stale beacon is produced by a dead loop, a closed
 * terminal, a rotated token, a restarted server, or a machine that woke up
 * ninety seconds ago — none of which are an absent machine.
 *
 * A bracket requires all of:
 *   - a beacon stream that was demonstrably RUNNING (>= 3 samples on cadence)
 *     before it went quiet;
 *   - quiet for at least BEACON_PRE_CALL_QUIET_MS when the call landed;
 *   - a beacon that RESUMED afterwards — proving the loop was alive all along
 *     and the quiet was the machine, not the instrument;
 *   - that resume being at least BEACON_POST_CALL_QUIET_MS after the call, so a
 *     wake-then-catch-up-fire (resume seconds later) does not qualify;
 *   - no admin auth failures during the quiet period (a rejected beacon looks
 *     exactly like an absent machine);
 *   - the server itself up across the quiet period;
 *   - and the CALL DID NOT COME FROM THE BEACON MACHINE. A machine that just
 *     made an HTTPS request was manifestly reachable, so the beacon cannot
 *     testify to its absence at that instant no matter how the timings line up.
 *     This is what makes a Desktop-LOCAL schedule unconfirmable by 5a — and it
 *     is the root-level fix for the wake-then-catch-up-fire scenario, which
 *     otherwise only fails on a timing margin. Compared on IP, not the full
 *     identity tuple: the beacon is `curl` and the client is not, so their
 *     user-agents differ while the machine is the same.
 *   - and NOTHING ELSE from that machine touched the server during the quiet
 *     period either. The same argument applies across the whole gap, not just at
 *     the call instant: a hand test at 06:00 from the laptop, with the beacon
 *     loop dead since 05:00, is presence evidence sitting in the log — the
 *     "absence" is contradicted by a record we already hold.
 */
function beaconBracket(
  callMs: number,
  callTransport: TransportIdentity,
  beacons: BeaconRecord[],
  adminAuthFailures: HttpRecord[],
  heartbeats: HeartbeatRecord[],
  /** Timestamps of non-beacon traffic from an address the beacon also posts from. */
  beaconMachineActivityMs: number[],
): BeaconVerdict {
  if (beacons.length === 0) return "unavailable__no_beacon_records";
  const callIp = trustedIp(callTransport);
  const callNet = ipNetwork(callIp);
  if (beacons.some((b) => trustedIp(b.transport) === callIp || ipNetwork(trustedIp(b.transport)) === callNet)) {
    return "unavailable__call_came_from_the_beacon_machine_itself";
  }
  const before = beacons.filter((b) => b.ts_epoch_ms <= callMs);
  const lastBefore = before[before.length - 1];
  if (lastBefore === undefined || before.length < BEACON_STREAM_MIN_SAMPLES) {
    return "unavailable__stream_was_not_running_before_the_quiet_period";
  }
  const cadence = before.slice(-BEACON_STREAM_MIN_SAMPLES);
  for (let i = 1; i < cadence.length; i++) {
    const prev = cadence[i - 1];
    const cur = cadence[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.ts_epoch_ms - prev.ts_epoch_ms > BEACON_STREAM_MAX_GAP_MS) {
      return "unavailable__stream_was_not_running_before_the_quiet_period";
    }
  }

  if (callMs - lastBefore.ts_epoch_ms < BEACON_PRE_CALL_QUIET_MS) return "machine_present_at_call";

  const after = beacons.find((b) => b.ts_epoch_ms > callMs);
  if (after === undefined) return "unavailable__never_resumed_after_the_call";
  if (after.ts_epoch_ms - callMs < BEACON_POST_CALL_QUIET_MS) {
    return "resumed_before_post_call_quiet_elapsed";
  }

  const quietStart = lastBefore.ts_epoch_ms;
  const quietEnd = after.ts_epoch_ms;
  if (adminAuthFailures.some((h) => h.ts_epoch_ms >= quietStart && h.ts_epoch_ms <= quietEnd)) {
    return "unavailable__beacon_was_being_rejected_during_the_quiet_period";
  }
  if (beaconMachineActivityMs.some((ms) => ms > quietStart && ms < quietEnd)) {
    return "unavailable__machine_was_active_during_the_claimed_absence";
  }
  if (livenessAcross(quietStart, quietEnd, heartbeats) !== "covered") {
    return "unavailable__server_was_not_up_across_the_quiet_period";
  }
  return "absence_bracketed";
}

/** Which discriminators this client + hand-test combination could ever produce. */
function structurallyAvailable(client: string, handTestsFrom: HandTestOrigin): string[] {
  const c = client.toLowerCase();
  const out: string[] = [];
  const local = c.includes("desktop") || c.includes("local");
  if (local) {
    out.push(
      "5b transport: UNAVAILABLE BY CONSTRUCTION — a Desktop-local schedule fires from " +
        "your own machine, so its identity is your identity. If a call DOES arrive from a " +
        "datacenter identity, that is the finding that Desktop schedules execute server-side.",
      "5a beacon: available only if the machine stays unreachable across AND after the call. " +
        "A machine that wakes to run a catch-up task resumes beaconing within a minute, which " +
        "this probe refuses — see README limit 8.",
    );
  } else {
    out.push(
      handTestsFrom === "desktop"
        ? "5b transport: available (hand tests confined to Desktop, so the cloud identity is clean)."
        : `5b transport: VOID — hand_tests_from=${handTestsFrom}. A cloud-scheduled run and your ` +
            "own claude.ai session egress from the same infrastructure.",
      "5a beacon: available if your machine was unreachable across and after the call.",
    );
  }
  return out;
}

function assess(records: ProbeRecord[], nowMs: number): AssessResult {
  const arms = sortedByTime(records.filter((r): r is ArmRecord => r.kind === "arm"));
  const calls = sortedByTime(records.filter((r): r is ToolCallRecord => r.kind === "tool_call"));
  const boots = sortedByTime(records.filter((r): r is BootRecord => r.kind === "server_boot"));
  const beacons = sortedByTime(records.filter((r): r is BeaconRecord => r.kind === "beacon"));
  const heartbeats = sortedByTime(records.filter((r): r is HeartbeatRecord => r.kind === "heartbeat"));
  const rpcs = sortedByTime(records.filter((r): r is RpcRecord => r.kind === "mcp_rpc"));
  const https = sortedByTime(records.filter((r): r is HttpRecord => r.kind === "http"));

  const halfWidthMs = (a: ArmRecord): number => a.window_minutes * 60_000;
  const inAnyWindow = (ms: number): boolean =>
    arms.some((a) => ms >= a.fire_at_epoch_ms - halfWidthMs(a) && ms <= a.fire_at_epoch_ms + halfWidthMs(a));

  const adminAuthFailures = https.filter((h) => h.reason === "admin_auth_failed");

  // Any non-beacon traffic from an address the beacon also posts from is direct
  // proof that machine was reachable at that moment. Used to contradict a claimed
  // absence anywhere inside the quiet period, not merely at the call instant.
  const beaconIps = new Set(beacons.map((b) => trustedIp(b.transport)));
  const beaconIpNets = new Set([...beaconIps].map(ipNetwork));
  const fromBeaconMachine = (t: TransportIdentity): boolean =>
    beaconIps.has(trustedIp(t)) || beaconIpNets.has(ipNetwork(trustedIp(t)));
  const beaconMachineActivityMs = [
    ...calls.filter((c) => fromBeaconMachine(c.transport)),
    ...rpcs.filter((r) => fromBeaconMachine(r.transport)),
    ...https.filter((h) => fromBeaconMachine(h.transport)),
  ].map((r) => r.ts_epoch_ms);

  // ---------------------------------------------------------------------
  // The operator-identity population. v1 built this from out-of-window TOOL
  // CALLS only, so an empty set made "this identity was never seen before"
  // VACUOUSLY TRUE for every window — including calls from the operator's own
  // desktop. Beacons are posted by the operator's machine BY CONSTRUCTION, and
  // every out-of-window RPC is the operator wiring the connector up; that data
  // was captured and then ignored.
  // ---------------------------------------------------------------------
  const operatorExact = new Set<string>();
  const operatorCoarse = new Set<string>();
  // IP sets too, because the beacon runs under `curl` while the MCP client does
  // not: on one machine the full identity tuples differ but the address does not.
  const operatorIps = new Set<string>();
  const operatorIpNets = new Set<string>();
  const addOperator = (t: TransportIdentity): void => {
    operatorExact.add(identityKey(t));
    operatorCoarse.add(coarseIdentityKey(t));
    operatorIps.add(trustedIp(t));
    operatorIpNets.add(ipNetwork(trustedIp(t)));
  };
  for (const b of beacons) addOperator(b.transport);
  for (const c of calls) if (!inAnyWindow(c.ts_epoch_ms)) addOperator(c.transport);
  for (const r of rpcs) if (!inAnyWindow(r.ts_epoch_ms)) addOperator(r.transport);

  const manualCalls = calls.filter((c) => !inAnyWindow(c.ts_epoch_ms));

  // ------------------------------ global flags -------------------------------
  const globalFlags: Flag[] = [];

  // Durability is DEMONSTRATED if the log survived a restart carrying records;
  // otherwise only ASSERTED. Derived from the boot records themselves so
  // `report --file` on a durable log is not falsely downgraded.
  const durabilityDeclared = boots.length > 0 && (boots[boots.length - 1]?.log_durable_declared ?? false);
  const durabilityDemonstrated = boots.some((b, i) => i > 0 && b.records_at_boot > 0);
  if (!durabilityDeclared && !durabilityDemonstrated) {
    globalFlags.push(
      flag(
        "log_durability_unproven",
        "Nothing shows this log survives a restart. That does not merely risk losing a " +
          "negative: a wiped log also empties the manual-identity baseline the transport " +
          "discriminator compares against, which is exactly how an attended call scores as " +
          "unattended. Blocks both verdicts.",
        true,
        true,
        true,
      ),
    );
  }

  // seq is assigned as (records read at construction) and increments per append,
  // so an intact log has seq === index. A gap means a torn write; a restart to 0
  // means the file was replaced.
  const seqBreak = records.findIndex((r, i) => r.seq !== i);
  if (seqBreak !== -1) {
    globalFlags.push(
      flag(
        "log_sequence_discontinuity",
        `record at index ${seqBreak} carries seq=${records[seqBreak]?.seq ?? "?"}. Records are ` +
          "missing or the file was replaced; the log cannot be read as complete.",
        true,
        true,
        true,
      ),
    );
  }
  const bootRegression = boots.findIndex(
    (b, i) => i > 0 && b.records_at_boot < (boots[i - 1]?.records_at_boot ?? 0),
  );
  if (bootRegression !== -1) {
    globalFlags.push(
      flag(
        "log_shrank_across_a_restart",
        "a later boot saw FEWER records than an earlier one — the log was wiped or replaced " +
          "(ephemeral filesystem, redeploy without a volume, volume swap).",
        true,
        true,
        true,
      ),
    );
  }

  if (!rpcs.some((r) => r.method === "tools/list")) {
    globalFlags.push(
      flag(
        "no_tools_list_ever_seen__connector_may_never_have_attached",
        "No client ever listed the tools. Nothing here is known to have come from an MCP " +
          "client at all, so a record in a window proves only that SOMETHING posted JSON-RPC.",
        true,
        true,
        true,
      ),
    );
  }
  if (https.some((h) => h.reason === "mcp_token_mismatch")) {
    globalFlags.push(
      flag(
        "requests_rejected_on_mcp_path__wrong_token_in_connector_url",
        "Something reached the MCP path with the wrong token. A real scheduled fire may have " +
          "been rejected, so 'nothing arrived' is not trustworthy.",
        false,
        true,
      ),
    );
  }
  if (heartbeats.length === 0) {
    globalFlags.push(
      flag(
        "no_server_heartbeats__uptime_unproven",
        "There are no heartbeat records, so there is no positive evidence the server was up " +
          "during any window. An outage and a silent client look identical without them. " +
          "(Upgrade the deployed probe, or set PROBE_HEARTBEAT_SECONDS.)",
        false,
        true,
        true,
      ),
    );
  }
  if (adminAuthFailures.length > 0) {
    globalFlags.push(
      flag(
        "admin_requests_rejected__beacon_may_have_been_silently_dead",
        `${adminAuthFailures.length} admin request(s) were rejected. If that was the presence ` +
          "beacon (wrong or unexported PROBE_ADMIN_TOKEN), its silence is the instrument, not " +
          "the machine. Beacon evidence is refused for any window whose quiet period overlaps one.",
        false,
        false,
      ),
    );
  }

  // ------------------------------ per window ---------------------------------
  const windows: WindowAssessment[] = arms.map((arm) => {
    const half = halfWidthMs(arm);
    const start = arm.fire_at_epoch_ms - half;
    const end = arm.fire_at_epoch_ms + half;
    const closed = nowMs > end;
    const handTestsFrom: HandTestOrigin = (HAND_TEST_ORIGINS as readonly string[]).includes(
      arm.hand_tests_from as string,
    )
      ? arm.hand_tests_from
      : "unspecified";
    const inWindow = calls.filter((c) => c.ts_epoch_ms >= start && c.ts_epoch_ms <= end);
    const expected = arm.expected_label.trim();
    const evidence = inWindow.filter((c) => (c.run_label ?? "").trim() === expected);
    const others = inWindow.filter((c) => (c.run_label ?? "").trim() !== expected);

    const flags: Flag[] = [];

    // ---- pre-registration -------------------------------------------------
    if (arm.ts_epoch_ms >= start) {
      flags.push(
        flag(
          "armed_after_window_opened__evidence_is_retrofitted",
          "the window was armed at or after it opened; this is fitting a story to a call you " +
            "already saw.",
          true,
          false,
        ),
      );
    } else if (start - arm.ts_epoch_ms < MIN_ARM_LEAD_MS) {
      flags.push(
        flag(
          "armed_less_than_30_min_before_the_window_opened",
          `armed ${Math.round((start - arm.ts_epoch_ms) / 60_000)} min before the window. ` +
            "Pre-registration is supposed to mean the label could not have been in circulation " +
            "beforehand; minting one and pasting it into a chat moments later does not show that.",
          true,
          false,
        ),
      );
    }

    // ---- ambient noise, classified by direction ---------------------------
    // v1 disqualified a window for ANY >=400 or any JSON-RPC error inside it,
    // which contradicted the server's own leniency posture: an internet scanner
    // hitting /wp-login.php, a dual-era client opening the optional GET stream,
    // or an unknown method the server deliberately answers 200 + -32601 each
    // killed a perfectly good day, and re-arming reproduced it.
    const httpIn = https.filter((h) => h.ts_epoch_ms >= start && h.ts_epoch_ms <= end);
    const rpcIn = rpcs.filter((r) => r.ts_epoch_ms >= start && r.ts_epoch_ms <= end);
    const ambient = httpIn.filter((h) => h.reason === "unknown_path").length;
    const legacyStream = httpIn.filter((h) => h.reason.startsWith("legacy_")).length;
    const methodNotFound = rpcIn.filter((r) => r.error_code === -32601).length;
    if (ambient > 0 || legacyStream > 0 || methodNotFound > 0) {
      flags.push(
        flag(
          "ambient_traffic_in_window__ignored_by_design",
          `${ambient} scanner 404(s), ${legacyStream} legacy GET/DELETE on the MCP endpoint, ` +
            `${methodNotFound} unknown JSON-RPC method(s). The server tolerates all of these on ` +
            "purpose, so they do not invalidate the window.",
          false,
          false,
        ),
      );
    }
    if (httpIn.some((h) => h.reason === "mcp_token_mismatch")) {
      flags.push(
        flag(
          "mcp_token_mismatch_inside_window",
          "a request reached the MCP path with the wrong token inside this window — a real fire " +
            "may have been rejected here.",
          false,
          true,
        ),
      );
    }
    if (rpcIn.some((r) => r.error_code === -32602)) {
      flags.push(
        flag(
          "unknown_tool_called_inside_window",
          "a client called a tool by a name this server does not have. Something tried and failed; " +
            "'nothing arrived' is not trustworthy for this window.",
          false,
          true,
        ),
      );
    }
    const restarted = boots.some((b) => b.ts_epoch_ms >= start && b.ts_epoch_ms <= end);
    if (restarted) {
      flags.push(
        flag(
          "server_restarted_inside_window",
          "the server booted inside this window (a redeploy, an OOM kill, or a scale-to-zero cold " +
            "start on Render/Fly/Cloud Run). A request arriving during the restart would be lost, " +
            "so a silent window proves nothing. A call that DID land is still a call.",
          false,
          true,
        ),
      );
    }

    // ---- label ------------------------------------------------------------
    // `.some`, not `.every`: a retry, or a second call where the model dropped
    // the optional argument, must not permanently sink a window — the README
    // disclaims measuring prompt adherence. But an unlabelled in-window call
    // from ANY other source than the evidence call is exactly the hand test this
    // probe exists to catch, so that fails closed.
    const labelMatch = evidence.length > 0;
    const evidenceIdentities = new Set(evidence.map((c) => identityKey(c.transport)));
    const strayIdentities = others.filter((c) => !evidenceIdentities.has(identityKey(c.transport)));
    if (strayIdentities.length > 0) {
      flags.push(
        flag(
          "unlabelled_in_window_call_from_a_different_source",
          `${strayIdentities.length} in-window call(s) did not carry the label AND did not come ` +
            "from the same identity as the labelled call. That is the shape of a hand test landing " +
            "in the window.",
          true,
          false,
        ),
      );
    }

    // ---- is this even an MCP client? --------------------------------------
    // Nothing in v1 bound an in-window record to an MCP client: a curl one-liner
    // from a VPS uptime check produced a record that was in-window, label-carrying
    // and from an unseen identity.
    if (evidence.some((c) => c.era === "unknown" && (c.client_info ?? null) === null)) {
      flags.push(
        flag(
          "in_window_call_not_identifiable_as_an_mcp_client",
          "the labelled call declared no protocol era and no clientInfo. A bare HTTP POST looks " +
            "exactly like this.",
          true,
          false,
        ),
      );
    }

    // ---- discriminator 5b: transport --------------------------------------
    let transportVerdict: TransportVerdict;
    if (evidence.length === 0) {
      transportVerdict = "unavailable__no_call_to_compare";
    } else if (handTestsFrom !== "desktop") {
      // README limit 2 as a check rather than an honour-system checkbox.
      transportVerdict = "unavailable__hand_tests_not_confined_to_desktop";
    } else if (manualCalls.length === 0) {
      transportVerdict = "unavailable__no_manual_baseline";
    } else {
      const unseen = evidence.every(
        (c) =>
          !operatorExact.has(identityKey(c.transport)) &&
          !operatorCoarse.has(coarseIdentityKey(c.transport)) &&
          !operatorIps.has(trustedIp(c.transport)) &&
          !operatorIpNets.has(ipNetwork(trustedIp(c.transport))),
      );
      transportVerdict = unseen ? "unseen_in_operator_traffic" : "seen_in_operator_traffic";
    }

    // ---- discriminator 5a: beacon absence bracket -------------------------
    let beaconVerdict: BeaconVerdict = "unavailable__no_call_to_bracket";
    for (const c of evidence) {
      const v = beaconBracket(
        c.ts_epoch_ms,
        c.transport,
        beacons,
        adminAuthFailures,
        heartbeats,
        beaconMachineActivityMs,
      );
      // Every evidence call must be bracketed; report the first that is not.
      if (v !== "absence_bracketed") {
        beaconVerdict = v;
        break;
      }
      beaconVerdict = v;
    }

    const independentVia =
      beaconVerdict === "absence_bracketed"
        ? "5a beacon absence bracket"
        : transportVerdict === "unseen_in_operator_traffic"
          ? "5b transport identity unseen in operator traffic"
          : null;
    const independent = independentVia !== null;

    const liveness = livenessAcross(start, end, heartbeats);
    if (closed && liveness !== "covered") {
      flags.push(
        flag(
          liveness === "gap"
            ? "server_liveness_gap_across_window"
            : "server_liveness_unknown_across_window",
          liveness === "gap"
            ? "heartbeats do not cover this window end to end — the server was down for part of it, " +
              "so a silent window is not evidence the client stayed silent."
            : "no heartbeat records cover this window, so there is no positive evidence the server " +
              "was up. Absence of a call is therefore not evidence of absence of a fire.",
          false,
          true,
        ),
      );
    }

    // ---- what is unmet ----------------------------------------------------
    const unmet: string[] = [];
    if (!closed) unmet.push(`window has not closed yet (closes ${new Date(end).toISOString()})`);
    if (inWindow.length === 0) unmet.push("no tool call landed inside the window");
    else if (!labelMatch) unmet.push("no in-window call carried the arm-time label");
    if (!arm.attest_away) unmet.push("no away attestation for this window");
    if (!independent) {
      unmet.push(
        "no discriminator independent of your attestation " +
          `(beacon: ${beaconVerdict}; transport: ${transportVerdict})`,
      );
    }
    for (const f of flags) if (f.blocks_confirmation) unmet.push(`${f.code}: ${f.detail}`);

    return {
      arm_id: arm.arm_id,
      client: arm.client,
      hand_tests_from: handTestsFrom,
      fire_at: arm.fire_at,
      window_start: new Date(start).toISOString(),
      window_end: new Date(end).toISOString(),
      window_half_width_minutes: arm.window_minutes,
      closed,
      attest_away: arm.attest_away,
      expected_label: arm.expected_label,
      calls: inWindow,
      evidence_call_ids: evidence.map((c) => c.id),
      label_match: labelMatch,
      transport_discriminator: transportVerdict,
      beacon_discriminator: beaconVerdict,
      independent_discriminator: independent,
      independent_via: independentVia,
      structurally_available: structurallyAvailable(arm.client, handTestsFrom),
      server_liveness_across_window: liveness,
      flags,
      unmet,
      clean: closed && unmet.length === 0,
    };
  });

  // ---------------------------------------------------------------------
  // Counting "distinct days". v1 keyed on the UTC date of window_start, so a
  // US-Pacific operator arming 16:30 and 17:30 local got two "days" an hour
  // apart; and because `window_minutes` is an unvalidated half-width, wide
  // windows overlapped and ONE call could satisfy two of them. Both are closed
  // by requiring the counted windows to be non-overlapping, >= 20 h apart, and
  // to rest on disjoint sets of calls.
  // ---------------------------------------------------------------------
  // Sorted by FIRE time, not arm time: re-arming day 1 after arming day 2 would
  // otherwise make the separation check compute a negative delta and discard a
  // genuinely independent window — a manufactured false fail.
  const cleanWindows = windows
    .filter((w) => w.clean)
    .sort((a, b) => Date.parse(a.fire_at) - Date.parse(b.fire_at));
  const qualifying: WindowAssessment[] = [];
  for (const w of cleanWindows) {
    const prev = qualifying[qualifying.length - 1];
    if (prev === undefined) {
      qualifying.push(w);
      continue;
    }
    const separated =
      Date.parse(w.fire_at) - Date.parse(prev.fire_at) >= MIN_WINDOW_SEPARATION_MS &&
      Date.parse(w.window_start) > Date.parse(prev.window_end);
    const disjoint = w.evidence_call_ids.every((id) => !prev.evidence_call_ids.includes(id));
    if (separated && disjoint) qualifying.push(w);
  }
  if (cleanWindows.length >= 2 && qualifying.length < 2) {
    globalFlags.push(
      flag(
        "clean_windows_are_not_independent",
        `${cleanWindows.length} clean windows, but only ${qualifying.length} are ` +
          `>= ${MIN_WINDOW_SEPARATION_MS / 3_600_000} h apart, non-overlapping, and resting on ` +
          "different calls. Two windows an hour apart — or one call satisfying two overlapping " +
          "windows — is one observation, not two.",
        true,
        false,
      ),
    );
  }

  const blocksConfirmation = globalFlags.some((f) => f.blocks_confirmation);
  const instrumentDegraded = globalFlags.some((f) => f.instrument && f.blocks_confirmation);
  const blocksNegative =
    globalFlags.some((f) => f.blocks_negative) ||
    windows.some((w) => w.closed && w.flags.some((f) => f.blocks_negative));
  const openWindows = windows.filter((w) => !w.closed);
  const closedWithCalls = windows.some((w) => w.closed && w.calls.length > 0);

  let verdict: Verdict;
  if (arms.length === 0) {
    verdict = "NOT_RUN_YET";
  } else if (qualifying.length >= 2 && !blocksConfirmation) {
    verdict = "UNATTENDED_CONFIRMED";
  } else if (openWindows.length > 0) {
    // The run is not finished. v1 had no such state and printed the expensive
    // no-branch for a window two days in the future.
    verdict = "WINDOWS_STILL_OPEN";
  } else if (instrumentDegraded) {
    // "I could not measure" outranks "the evidence was weak": if the log itself
    // cannot be trusted, neither a call nor its absence means anything.
    verdict = "INCONCLUSIVE";
  } else if (closedWithCalls) {
    verdict = "CONSISTENT_BUT_UNPROVEN";
  } else if (blocksNegative || blocksConfirmation) {
    verdict = "INCONCLUSIVE";
  } else {
    verdict = "NO_INVOCATION_OBSERVED";
  }

  return {
    verdict,
    windows,
    global_flags: globalFlags,
    qualifying_window_ids: qualifying.map((w) => w.arm_id),
    summary: {
      records: records.length,
      armings: arms.length,
      windows_still_open: openWindows.length,
      tool_calls_total: calls.length,
      tool_calls_in_a_window: calls.length - manualCalls.length,
      presumed_manual_calls: manualCalls.length,
      operator_identities_known: operatorExact.size,
      server_boots: boots.length,
      heartbeats: heartbeats.length,
      beacon_records: beacons.length,
      distinct_client_identities: new Set(calls.map((c) => identityKey(c.transport))).size,
      protocol_eras_seen: [...new Set(rpcs.map((r) => r.era))],
      protocol_versions_seen: [...new Set(rpcs.map((r) => r.protocol_version).filter((v) => v !== null))],
      spec_deviations_seen: [...new Set(rpcs.flatMap((r) => r.spec_deviations))],
      clean_windows: cleanWindows.length,
      qualifying_windows: qualifying.length,
    },
  };
}

const VERDICT_MEANING: { [K in Verdict]: string } = {
  UNATTENDED_CONFIRMED:
    "Assumption 3 HOLDS, to the strongest standard this instrument can reach: on at least " +
    "two independent days, >=20 h apart and resting on different calls, a labelled call " +
    "landed inside a window armed at least 30 minutes beforehand, with an away attestation, " +
    "and with a discriminator independent of that attestation. KTD12/R21 stand: ship recipes, " +
    "keep push out of v1. Read 'what this still does not prove' in the README before citing it.",
  CONSISTENT_BUT_UNPROVEN:
    "A call landed in a closed window but at least one guard is unmet. This is NOT a pass. " +
    "Read `unmet` below, fix that one thing, and re-arm. Do not cite this as evidence either way.",
  NO_INVOCATION_OBSERVED:
    "Every window closed with nothing arriving, AND the server is demonstrably up across them " +
    "(heartbeats), AND nothing in the log could have hidden a real fire. This is evidence " +
    "AGAINST Assumption 3 — re-run once more to rule out a one-off, then take the Phase 0 " +
    "decision: manual morning-pull recipe + push promoted to Phase 4.",
  WINDOWS_STILL_OPEN:
    "At least one armed window has not closed yet, so the run is not finished and no verdict " +
    "is due. Nothing below is a result. If flags are printed, fix them NOW — before the window " +
    "opens — or tomorrow's report will be INCONCLUSIVE.",
  INCONCLUSIVE:
    "The instrument was degraded, so the log cannot be read either way: something is missing " +
    "that would have to be present for silence to mean anything (durable log, heartbeats, a " +
    "connector that ever attached, an intact record sequence). This says NOTHING about " +
    "Assumption 3. Fix what is named and re-run. Recording this as a failure of the assumption " +
    "is the expensive mistake.",
  NOT_RUN_YET: "No arming records. Run `arm` before the scheduled task fires.",
};

const PROOF_STANDARD = [
  "WHAT WOULD BE PROOF, AND WHAT IS MERELY CONSISTENT WITH IT",
  "",
  "  Proof, to the limit of this instrument: on >=2 independent days, a call carrying a",
  "  label minted AFTER the window was registered landed inside that window, and at least",
  "  one discriminator held that your attestation did not produce —",
  "    5a  the presence beacon was demonstrably RUNNING, went quiet before the call, and",
  "        stayed quiet for >=10 min after it (so the quiet was the machine, not a dead",
  "        loop, and not a machine that had just woken up); or",
  "    5b  the call's transport identity appears nowhere in traffic known to be yours,",
  "        compared on both an exact and a coarsened key, against a NON-EMPTY baseline,",
  "        with your hand tests confined to Desktop.",
  "",
  "  Merely consistent with it: a call in the window with an honest attestation and no",
  "  independent discriminator. That is a true statement about a call you did not make —",
  "  and it is indistinguishable from a call you made and forgot. It is not a pass.",
  "",
  "  Not reachable at all: proof that no human was in the room. No HTTP server can see",
  "  that. A Desktop-LOCAL schedule additionally cannot be confirmed by this instrument,",
  "  because the machine must be awake to fire and a scheduled wake is indistinguishable",
  "  from you opening the lid. See README limit 8.",
].join("\n");

function printFlags(title: string, flags: Flag[], indent: string): void {
  if (flags.length === 0) return;
  console.log(`\n${indent}${title}`);
  for (const f of flags) {
    const dir =
      f.blocks_confirmation && f.blocks_negative
        ? "blocks BOTH verdicts"
        : f.blocks_confirmation
          ? "blocks UNATTENDED_CONFIRMED"
          : f.blocks_negative
            ? "blocks NO_INVOCATION_OBSERVED"
            : "informational";
    console.log(`${indent}  ! ${f.code}  [${dir}]`);
    console.log(`${indent}      ${f.detail}`);
  }
}

async function cmdReport(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const { records, source } = await fetchRecords(flags);
  const nowFlag = flags.get("now");
  const nowMs =
    nowFlag !== undefined && nowFlag !== "true" && !Number.isNaN(Date.parse(nowFlag))
      ? Date.parse(nowFlag)
      : Date.now();
  const result = assess(records, nowMs);

  if (flags.get("json") === "true") {
    console.log(
      JSON.stringify(
        {
          source,
          evaluated_at_utc: new Date(nowMs).toISOString(),
          ...result,
          verdict_meaning: VERDICT_MEANING[result.verdict],
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\nsource: ${source}`);
  console.log(`evaluated at: ${new Date(nowMs).toISOString()}`);
  console.log(`\n=== VERDICT: ${result.verdict} ===`);
  console.log(VERDICT_MEANING[result.verdict]);

  console.log("\n--- summary ---");
  for (const [k, v] of Object.entries(result.summary)) {
    console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
  }

  printFlags(
    result.verdict === "WINDOWS_STILL_OPEN"
      ? "--- global flags (fix these BEFORE the window, or tomorrow reads INCONCLUSIVE) ---"
      : "--- global flags ---",
    result.global_flags,
    "",
  );

  console.log("\n--- windows ---");
  if (result.windows.length === 0) console.log("  (none armed)");
  for (const w of result.windows) {
    console.log(
      `\n  ${w.arm_id}  client=${w.client}  hand_tests_from=${w.hand_tests_from}  fire_at=${w.fire_at}`,
    );
    console.log(
      `    window:  ${w.window_start} .. ${w.window_end}  (fire_at ± ${w.window_half_width_minutes} min)` +
        `  ${w.closed ? "[closed]" : "[STILL OPEN]"}`,
    );
    for (const note of w.structurally_available) console.log(`    structurally: ${note}`);
    console.log(`    calls in window: ${w.calls.length}  (labelled: ${w.evidence_call_ids.length})`);
    for (const c of w.calls) {
      console.log(
        `      - ${c.ts}  id=${c.id}  label=${c.run_label ?? "(none)"}  ` +
          `era=${c.era}  from=${identityKey(c.transport)}  beacon_age_s=${c.beacon_age_seconds ?? "n/a"}`,
      );
    }
    console.log(`    away attestation:          ${w.attest_away}`);
    console.log(`    5b transport:              ${w.transport_discriminator}`);
    console.log(`    5a beacon:                 ${w.beacon_discriminator}`);
    console.log(
      `    server up across window:   ${w.closed ? w.server_liveness_across_window : "(not evaluated — window still open)"}`,
    );
    console.log(
      `    independent discriminator: ${w.independent_discriminator}` +
        (w.independent_via === null ? "" : ` (via ${w.independent_via})`),
    );
    printFlags("flags:", w.flags, "    ");
    if (w.clean) console.log("    => CLEAN (counts toward confirmation)");
    else for (const u of w.unmet) console.log(`    => unmet: ${u}`);
  }

  if (result.qualifying_window_ids.length > 0) {
    console.log(`\nqualifying (independent) windows: ${result.qualifying_window_ids.join(", ")}`);
  }

  console.log(`\n${PROOF_STANDARD}`);
  console.log("\nRecord the outcome in RESULT.local.md (copy RESULT-TEMPLATE.md).\n");
}

/**
 * The wiring check. Every failure below is one a user would otherwise meet as an
 * undifferentiated 404 the morning after, when it is too late to fix.
 */
async function cmdDoctor(): Promise<void> {
  const base = baseUrl();
  const problems: string[] = [];
  const say = (okFlag: boolean, text: string): void => console.log(`  ${okFlag ? "ok  " : "FAIL"}  ${text}`);

  console.log(`\nchecking ${base}\n`);

  let root: Response | null = null;
  try {
    root = await fetch(`${base}/`);
  } catch (err) {
    say(false, `cannot reach ${base}/ — ${String(err)}`);
    problems.push("PROBE_BASE_URL is unreachable");
  }
  if (root !== null) {
    const text = await root.text();
    const isProbe = text.includes(SERVER_NAME);
    say(isProbe, isProbe ? `origin is a ${SERVER_NAME}` : `origin answered, but it is not this probe`);
    if (!isProbe) problems.push("PROBE_BASE_URL points at something that is not this probe");
    else console.log(text.split("\n").filter((l) => l !== "").map((l) => `        ${l}`).join("\n"));
  }

  const res = await fetch(`${base}/probe/records`, { headers: adminHeaders() });
  const adminOk = res.ok;
  say(adminOk, adminOk ? "PROBE_ADMIN_TOKEN accepted" : `admin API refused (HTTP ${res.status})`);
  if (!adminOk) {
    problems.push("PROBE_ADMIN_TOKEN does not match the deployed server");
    for (const line of admin404Help(`${base}/probe/records`)) console.log(`        ${line}`);
    console.log(`\n${problems.length} problem(s).\n`);
    process.exit(1);
  }

  const body = (await res.json()) as { records: ProbeRecord[]; log_durable_declared: boolean };
  const records = body.records;
  const result = assess(records, Date.now());

  const durable = body.log_durable_declared;
  say(durable, durable ? "log durability declared" : "PROBE_LOG_DURABLE is not set on the server");
  if (!durable) problems.push("mount a volume and set PROBE_LOG_DURABLE=1 — this blocks BOTH verdicts");

  const heartbeats = records.filter((r) => r.kind === "heartbeat").length;
  say(heartbeats > 0, heartbeats > 0 ? `${heartbeats} heartbeat record(s)` : "no heartbeats — uptime unprovable");
  if (heartbeats === 0) problems.push("no heartbeat records; 'nothing arrived' will be INCONCLUSIVE");

  const beacons = records.filter((r): r is BeaconRecord => r.kind === "beacon");
  const lastBeacon = beacons[beacons.length - 1];
  const beaconAgeS = lastBeacon === undefined ? null : Math.round((Date.now() - lastBeacon.ts_epoch_ms) / 1000);
  const beaconLive = beaconAgeS !== null && beaconAgeS < BEACON_STREAM_MAX_GAP_MS / 1000;
  say(
    beaconLive,
    lastBeacon === undefined
      ? "no beacon records — discriminator 5a will be unavailable"
      : `last beacon ${beaconAgeS}s ago (${beacons.length} record(s))`,
  );
  if (!beaconLive) {
    problems.push(
      "the presence beacon is not running (or its token is wrong). Without it 5a is unavailable; " +
        "if the loop dies mid-run the window reads INCONCLUSIVE, not CLEAN",
    );
  }

  const toolsList = records.some((r) => r.kind === "mcp_rpc" && r.method === "tools/list");
  say(toolsList, toolsList ? "a client has listed the tools (connector attached)" : "no tools/list ever seen");
  if (!toolsList) problems.push("the connector has never attached; add it and hand-test once");

  const manual = records.filter((r) => r.kind === "tool_call").length;
  say(manual > 0, manual > 0 ? `${manual} tool call(s) recorded` : "no tool call has ever been recorded");
  if (manual === 0) problems.push("hand-test the tool once from Desktop to establish the 5b baseline");

  for (const f of result.global_flags) {
    const blocking = f.blocks_confirmation || f.blocks_negative;
    say(!blocking, blocking ? `${f.code} — ${f.detail}` : `note: ${f.code}`);
    if (blocking && !problems.includes(f.code)) problems.push(f.code);
  }

  console.log(
    problems.length === 0
      ? "\nAll checks pass. Arm a window and go away.\n"
      : `\n${problems.length} problem(s) to fix BEFORE the window opens:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          "\n",
  );
  if (problems.length > 0) process.exit(1);
}

async function cmdVerifyNonce(argv: string[]): Promise<void> {
  const positional = argv.find((a) => !a.startsWith("--"));
  if (positional === undefined) {
    fatal(2, "usage: verify-nonce <nonce>   (the value the model claims the tool returned)");
  }
  const { records } = await fetchRecords(parseFlags(argv));
  const match = records.find((r): r is ToolCallRecord => r.kind === "tool_call" && r.nonce === positional);
  if (match === undefined) {
    console.log(`\nNOT FOUND: no tool call ever produced nonce ${positional}.`);
    console.log("The claim that this tool ran is UNSUPPORTED. Either the model reported a");
    console.log("nonce it never received (a hallucinated tool call — a real failure mode that");
    console.log("looks exactly like success in a transcript), or you are reading a different");
    console.log("server's log. Either way this is not evidence of an invocation.\n");
    process.exit(1);
  }
  console.log(`\nVERIFIED: nonce ${positional} was minted by this server.\n`);
  console.log(JSON.stringify(match, null, 2));
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const [subcommand = "serve", ...rest] = process.argv.slice(2);

switch (subcommand) {
  case "serve":
    runServer();
    break;
  case "doctor":
    await cmdDoctor();
    break;
  case "arm":
    await cmdArm(rest);
    break;
  case "report":
    await cmdReport(rest);
    break;
  case "verify-nonce":
    await cmdVerifyNonce(rest);
    break;
  default:
    console.error(`unknown subcommand: ${subcommand}`);
    console.error("usage: serve | doctor | arm | report | verify-nonce <nonce>");
    process.exit(2);
}
