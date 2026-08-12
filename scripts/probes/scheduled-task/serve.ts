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
 * (`probe_briefing`). Every invocation appends a tamper-evident record to an
 * append-only JSONL log: server-clock timestamp, a server-minted nonce the caller
 * cannot forge, and every scrap of caller identity the transport actually reveals.
 *
 * It also carries the analysis, because a raw log does not settle an assumption —
 * a verdict does. `report` classifies the log against pre-registered firing
 * windows and prints one of five named outcomes. See README.md.
 *
 * THE TRAP THIS IS BUILT AROUND
 * -----------------------------
 * The user will test the tool by hand while wiring it up. A naive log cannot tell
 * that apart from the scheduled task firing at 07:00 while they were asleep, and
 * a probe that counts the manual test as proof certifies the assumption falsely.
 * So: nothing is proof unless it was ARMED FIRST (`arm` writes the expected fire
 * time and a secret label into the log BEFORE the window opens), and the verdict
 * demands at least one discriminator that a manual test could not have produced.
 * README.md states plainly what is proof and what is merely consistent with it.
 *
 * FALSE FAILS ARE AS EXPENSIVE AS FALSE PASSES. A false fail triggers an
 * architectural no-branch (server-side push, promoted to a Phase 4 commitment)
 * that was never needed. So this server is deliberately LENIENT: it never rejects
 * a request for spec non-compliance, it speaks both the modern (2026-07-28) and
 * legacy (initialize-handshake) protocol eras, and it logs every request it
 * refuses so "the client tried and failed" can never be misread as "the client
 * never tried".
 *
 * SUBCOMMANDS (entrypoint is fixed by package.json's `probe:scheduled-task`)
 *   bun run probe:scheduled-task                       # serve (default)
 *   bun run probe:scheduled-task arm --client desktop --fire-at <ISO8601+offset>
 *   bun run probe:scheduled-task report [--json] [--file <path>]
 *   bun run probe:scheduled-task verify-nonce <nonce>
 *
 * NON-GOALS (deliberate, do not add): OAuth, SSE, subscriptions/listen, MRTR,
 * x-mcp-header, rate limiting, persistence beyond a JSONL file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const PROBE_VERSION = "1.0.0";
const SERVER_NAME = "brainz-scheduled-task-probe";
const TOOL_NAME = "probe_briefing";

/** Protocol revisions we answer. Modern = per-request `_meta`; legacy = `initialize`. */
const MODERN_VERSIONS = ["2026-07-28"] as const;
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LEGACY_FALLBACK_VERSION = "2025-06-18";

// ---------------------------------------------------------------------------
// Record shapes. Everything on disk is one of these, one JSON object per line.
// Optional-ness is expressed as `| null`, never `?`, because the repo compiles
// with exactOptionalPropertyTypes.
// ---------------------------------------------------------------------------

type Era = "modern" | "legacy" | "unknown";

interface TransportIdentity {
  /** Socket peer as the runtime sees it. Behind a platform proxy this is the proxy. */
  remote_ip: string | null;
  /** Whatever the edge said the real client was, if anything. */
  edge_client_ip: string | null;
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
}

interface ArmRecord extends BaseRecord {
  kind: "arm";
  arm_id: string;
  client: string;
  /** ISO 8601 WITH an explicit offset or Z. Enforced — a naive string is a timezone false-fail. */
  fire_at: string;
  fire_at_epoch_ms: number;
  window_minutes: number;
  /** Server-minted. The user pastes this into the scheduled prompt BEFORE the window. */
  expected_label: string;
  /** The user's assertion that they will not touch the client during the window. */
  attest_away: boolean;
  note: string | null;
}

interface BeaconRecord extends BaseRecord {
  kind: "beacon";
  host_label: string | null;
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
  /** Seconds since the presence beacon last pinged, or null if it never has. */
  beacon_age_seconds: number | null;
  path: string;
  transport: TransportIdentity;
}

type ProbeRecord =
  | BootRecord
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

function requireEnv(name: string, why: string): string {
  const value = env(name);
  if (value === null) {
    fatal(
      2,
      `[probe] FATAL: ${name} is not set.`,
      `[probe] ${why}`,
      "[probe] This probe never auto-generates secrets: a restart that silently",
      "[probe] rotated the token would break the connector URL and read as",
      "[probe] 'the scheduled task did not fire' — a false FAIL. Set it explicitly.",
    );
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
      // x-forwarded-for is a chain; the client is the leftmost entry.
      edgeIp = (value.split(",")[0] ?? value).trim();
      break;
    }
  }

  return {
    remote_ip: peerIp,
    edge_client_ip: edgeIp,
    user_agent: headers["user-agent"] ?? null,
    authorization_fingerprint: authFingerprint,
    headers,
  };
}

/** The most client-like address available. Used only to compare invocations to each other. */
function bestIp(t: TransportIdentity): string {
  return t.edge_client_ip ?? t.remote_ip ?? "unknown";
}

/** Identity tuple used to ask "did this call come from the same place as that one?". */
function identityKey(t: TransportIdentity): string {
  return `${bestIp(t)} | ${t.user_agent ?? "no-ua"}`;
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
function analyseMessage(message: JsonRpcMessage, req: Request): MessageContext {
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
          "Omit it if the prompt did not give you one.",
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
  );
  const adminToken = requireEnv(
    "PROBE_ADMIN_TOKEN",
    "It is the bearer token protecting /probe/arm, /probe/records and /probe/beacon.",
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
  });

  /** Last presence-beacon ping, in memory. Also trailed into the log, sparsely. */
  let lastBeaconMs: number | null = null;
  let lastBeaconLoggedMs = 0;

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
            "No secrets are served from this page. The MCP endpoint is at an unguessable path.\n",
          { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }

      // ------------------------------ admin --------------------------------
      if (path.startsWith("/probe/")) {
        const bearer = req.headers.get("authorization") ?? "";
        const presented = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7) : "";
        if (!secretEquals(presented, adminToken)) {
          // 404, never 401: an admin surface should not announce itself.
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
            records,
          });
        }

        if (path === "/probe/beacon" && req.method === "POST") {
          lastBeaconMs = Date.now();
          let hostLabel: string | null = null;
          try {
            hostLabel = safeString(asObject(await req.json())?.["host_label"], 64);
          } catch {
            hostLabel = null;
          }
          // Trail the beacon into the log at most every 10 minutes, so presence
          // history survives a server restart without flooding the file.
          if (lastBeaconMs - lastBeaconLoggedMs > 10 * 60_000) {
            lastBeaconLoggedMs = lastBeaconMs;
            log.append<BeaconRecord>({
              kind: "beacon",
              boot_id: bootId,
              host_label: hostLabel,
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
          const windowMinutes = typeof body["window_minutes"] === "number" ? body["window_minutes"] : 20;
          const armed = log.append<ArmRecord>({
            kind: "arm",
            boot_id: bootId,
            arm_id: `arm_${randomHex(5)}`,
            client: safeString(body["client"], 32) ?? "unspecified",
            fire_at: fireAt,
            fire_at_epoch_ms: Date.parse(fireAt),
            window_minutes: windowMinutes,
            expected_label: `run-${randomHex(6)}`,
            attest_away: body["attest_away"] === true,
            note: safeString(body["note"], 300),
          });
          return Response.json({
            arm_id: armed.arm_id,
            expected_label: armed.expected_label,
            fire_at: armed.fire_at,
            window_minutes: armed.window_minutes,
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
        // 2026-07-28 removed the GET stream and DELETE session teardown.
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
  if (!logDurable) {
    console.warn(
      "[probe] WARNING: PROBE_LOG_DURABLE is not set. If this host has an ephemeral " +
        "filesystem, a restart silently erases the evidence and an unattended call that " +
        "DID happen will read as 'never fired'. Mount a volume and set PROBE_LOG_DURABLE=1.",
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
  const ctx = analyseMessage(message, req);
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
      // reason unrelated to scheduled tasks. Deliberate, documented deviation.
      return fail(-32601, `Method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI: arm / report / verify-nonce
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
  const token = requireEnv("PROBE_ADMIN_TOKEN", "Needed to reach the deployed probe's admin API.");
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function baseUrl(): string {
  return requireEnv(
    "PROBE_BASE_URL",
    "The public HTTPS origin of the deployed probe, e.g. https://probe.example.workers.dev",
  ).replace(/\/+$/, "");
}

async function cmdArm(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const fireAt = flags.get("fire-at");
  const client = flags.get("client") ?? "unspecified";
  if (fireAt === undefined) {
    fatal(
      2,
      "usage: arm --client <desktop|code|web|other> --fire-at <ISO8601 with offset>",
      "            [--window-minutes 20] [--attest-away] [--note '...']",
      "",
      "  --fire-at MUST carry an explicit offset or Z, e.g. 2026-08-13T07:00:00-07:00.",
      "  --attest-away asserts you will not touch the client during the window. Without",
      "  it the run can never reach UNATTENDED_CONFIRMED.",
    );
  }
  const body = {
    client,
    fire_at: fireAt,
    window_minutes: Number(flags.get("window-minutes") ?? "20"),
    attest_away: flags.get("attest-away") === "true",
    note: flags.get("note") ?? null,
  };
  const res = await fetch(`${baseUrl()}/probe/arm`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fatal(1, `[probe] arm failed (HTTP ${res.status}): ${text}`);
  const armed = JSON.parse(text) as { arm_id: string; expected_label: string; fire_at: string };
  console.log(`\nARMED. arm_id=${armed.arm_id}  fire_at=${armed.fire_at}\n`);
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
}

async function fetchRecords(flags: Map<string, string>): Promise<{
  records: ProbeRecord[];
  logDurableDeclared: boolean;
  source: string;
}> {
  const file = flags.get("file");
  if (file !== undefined && file !== "true") {
    return { records: new ProbeLog(file).read(), logDurableDeclared: false, source: `file:${file}` };
  }
  const url = `${baseUrl()}/probe/records`;
  const res = await fetch(url, { headers: adminHeaders() });
  if (!res.ok) {
    fatal(
      1,
      `[probe] could not read records (HTTP ${res.status}) from ${url}`,
      "[probe] This is an INFRA_FAILURE, not an answer about scheduled tasks.",
    );
  }
  const body = (await res.json()) as { records: ProbeRecord[]; log_durable_declared: boolean };
  return { records: body.records, logDurableDeclared: body.log_durable_declared, source: url };
}

type Verdict =
  | "UNATTENDED_CONFIRMED"
  | "CONSISTENT_BUT_UNPROVEN"
  | "NO_INVOCATION_OBSERVED"
  | "INFRA_FAILURE"
  | "NOT_RUN_YET";

interface WindowAssessment {
  arm_id: string;
  client: string;
  fire_at: string;
  window_start: string;
  window_end: string;
  attest_away: boolean;
  expected_label: string;
  calls: ToolCallRecord[];
  label_match: boolean;
  transport_unseen_outside_windows: boolean;
  beacon: "machine_absent" | "machine_present" | "unknown";
  independent_discriminator: boolean;
  infra_flags: string[];
  unmet: string[];
}

function assess(records: ProbeRecord[], logDurableDeclared: boolean): {
  verdict: Verdict;
  windows: WindowAssessment[];
  global_flags: string[];
  summary: { [k: string]: unknown };
} {
  const arms = records.filter((r): r is ArmRecord => r.kind === "arm");
  const calls = records.filter((r): r is ToolCallRecord => r.kind === "tool_call");
  const boots = records.filter((r): r is BootRecord => r.kind === "server_boot");
  const beacons = records.filter((r): r is BeaconRecord => r.kind === "beacon");
  const rpcs = records.filter((r): r is RpcRecord => r.kind === "mcp_rpc");
  const https = records.filter((r): r is HttpRecord => r.kind === "http");

  const inAnyWindow = (ms: number): boolean =>
    arms.some((a) => {
      const half = a.window_minutes * 60_000;
      return ms >= a.fire_at_epoch_ms - half && ms <= a.fire_at_epoch_ms + half;
    });

  // Calls outside every armed window are the presumed-manual population.
  const manualIdentities = new Set(
    calls.filter((c) => !inAnyWindow(c.ts_epoch_ms)).map((c) => identityKey(c.transport)),
  );

  const globalFlags: string[] = [];
  // Durability is DEMONSTRATED if the log survived a restart; otherwise only asserted.
  if (boots.length < 2 && !logDurableDeclared) globalFlags.push("log_durability_unproven");
  if (!rpcs.some((r) => r.method === "tools/list")) {
    globalFlags.push("no_tools_list_ever_seen__connector_may_never_have_attached");
  }
  if (https.some((h) => h.reason === "mcp_token_mismatch")) {
    globalFlags.push("requests_rejected_on_mcp_path__wrong_token_in_connector_url");
  }

  const windows: WindowAssessment[] = arms.map((arm) => {
    const half = arm.window_minutes * 60_000;
    const start = arm.fire_at_epoch_ms - half;
    const end = arm.fire_at_epoch_ms + half;
    const armedBeforeWindow = arm.ts_epoch_ms < start;
    const inWindow = calls.filter((c) => c.ts_epoch_ms >= start && c.ts_epoch_ms <= end);

    const infra: string[] = [];
    if (!armedBeforeWindow) infra.push("armed_after_window_opened__evidence_is_retrofitted");
    if (boots.some((b) => b.ts_epoch_ms >= start && b.ts_epoch_ms <= end)) {
      infra.push("server_restarted_inside_window");
    }
    if (https.some((h) => h.ts_epoch_ms >= start && h.ts_epoch_ms <= end && h.status >= 400)) {
      infra.push("http_error_inside_window");
    }
    if (rpcs.some((r) => r.ts_epoch_ms >= start && r.ts_epoch_ms <= end && r.error_code !== null)) {
      infra.push("jsonrpc_error_inside_window");
    }

    const labelMatch = inWindow.length > 0 && inWindow.every((c) => c.run_label === arm.expected_label);
    const transportUnseen =
      inWindow.length > 0 && inWindow.every((c) => !manualIdentities.has(identityKey(c.transport)));

    // Beacon: was the user's own machine reachable around the fire time?
    let beacon: WindowAssessment["beacon"] = "unknown";
    const ages = inWindow.map((c) => c.beacon_age_seconds).filter((a): a is number => a !== null);
    if (ages.length > 0) {
      beacon = Math.min(...ages) > 15 * 60 ? "machine_absent" : "machine_present";
    } else if (beacons.length > 0) {
      const nearest = beacons.reduce((best, b) =>
        Math.abs(b.ts_epoch_ms - arm.fire_at_epoch_ms) < Math.abs(best.ts_epoch_ms - arm.fire_at_epoch_ms)
          ? b
          : best,
      );
      beacon =
        Math.abs(nearest.ts_epoch_ms - arm.fire_at_epoch_ms) > 15 * 60_000
          ? "machine_absent"
          : "machine_present";
    }

    const independent = beacon === "machine_absent" || transportUnseen;

    const unmet: string[] = [];
    if (inWindow.length === 0) unmet.push("no tool call landed inside the window");
    if (!labelMatch) unmet.push("in-window call did not carry the arm-time label");
    if (!arm.attest_away) unmet.push("no away attestation for this window");
    if (!independent) {
      unmet.push(
        "no discriminator independent of your attestation (beacon did not show the machine " +
          "absent, and the caller's transport identity also appears on out-of-window calls)",
      );
    }
    if (infra.length > 0) unmet.push(`infrastructure noise in the window: ${infra.join(", ")}`);

    return {
      arm_id: arm.arm_id,
      client: arm.client,
      fire_at: arm.fire_at,
      window_start: new Date(start).toISOString(),
      window_end: new Date(end).toISOString(),
      attest_away: arm.attest_away,
      expected_label: arm.expected_label,
      calls: inWindow,
      label_match: labelMatch,
      transport_unseen_outside_windows: transportUnseen,
      beacon,
      independent_discriminator: independent,
      infra_flags: infra,
      unmet,
    };
  });

  const clean = windows.filter((w) => w.unmet.length === 0);
  const cleanDays = new Set(clean.map((w) => w.window_start.slice(0, 10)));

  let verdict: Verdict;
  if (arms.length === 0) {
    verdict = "NOT_RUN_YET";
  } else if (cleanDays.size >= 2) {
    verdict = "UNATTENDED_CONFIRMED";
  } else if (windows.some((w) => w.calls.length > 0)) {
    verdict = "CONSISTENT_BUT_UNPROVEN";
  } else if (
    globalFlags.length > 0 ||
    windows.some((w) => w.infra_flags.length > 0)
  ) {
    verdict = "INFRA_FAILURE";
  } else {
    verdict = "NO_INVOCATION_OBSERVED";
  }

  return {
    verdict,
    windows,
    global_flags: globalFlags,
    summary: {
      records: records.length,
      armings: arms.length,
      tool_calls_total: calls.length,
      tool_calls_in_a_window: calls.filter((c) => inAnyWindow(c.ts_epoch_ms)).length,
      presumed_manual_calls: calls.length - calls.filter((c) => inAnyWindow(c.ts_epoch_ms)).length,
      server_boots: boots.length,
      distinct_client_identities: new Set(calls.map((c) => identityKey(c.transport))).size,
      protocol_eras_seen: [...new Set(rpcs.map((r) => r.era))],
      protocol_versions_seen: [...new Set(rpcs.map((r) => r.protocol_version).filter((v) => v !== null))],
      spec_deviations_seen: [...new Set(rpcs.flatMap((r) => r.spec_deviations))],
      clean_windows: clean.length,
      clean_window_days: [...cleanDays],
    },
  };
}

const VERDICT_MEANING: { [K in Verdict]: string } = {
  UNATTENDED_CONFIRMED:
    "Assumption 3 HOLDS. KTD12/R21 stand: ship recipes, keep push out of v1.",
  CONSISTENT_BUT_UNPROVEN:
    "A call landed in the window but at least one guard is unmet. This is NOT a pass. " +
    "Read `unmet` below, fix that one thing, and re-arm. Do not cite this as evidence.",
  NO_INVOCATION_OBSERVED:
    "The window opened and closed with nothing arriving, and the server was healthy. " +
    "This is evidence AGAINST Assumption 3 — re-run once more to rule out a one-off, " +
    "then take the Phase 0 decision: manual morning-pull recipe + push promoted to Phase 4.",
  INFRA_FAILURE:
    "The probe could not observe cleanly (restart, rejected requests, connector never " +
    "attached, unproven log durability). This says NOTHING about Assumption 3. Fix the " +
    "probe and re-run. Never record this as a failure of the assumption.",
  NOT_RUN_YET: "No arming records. Run `arm` before the scheduled task fires.",
};

async function cmdReport(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const { records, logDurableDeclared, source } = await fetchRecords(flags);
  const result = assess(records, logDurableDeclared);

  if (flags.get("json") === "true") {
    console.log(JSON.stringify({ source, ...result, verdict_meaning: VERDICT_MEANING[result.verdict] }, null, 2));
    return;
  }

  console.log(`\nsource: ${source}`);
  console.log(`\n=== VERDICT: ${result.verdict} ===`);
  console.log(VERDICT_MEANING[result.verdict]);

  console.log("\n--- summary ---");
  for (const [k, v] of Object.entries(result.summary)) {
    console.log(`  ${k}: ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
  }
  if (result.global_flags.length > 0) {
    console.log("\n--- global flags (these can invalidate a negative result) ---");
    for (const f of result.global_flags) console.log(`  ! ${f}`);
  }

  console.log("\n--- windows ---");
  if (result.windows.length === 0) console.log("  (none armed)");
  for (const w of result.windows) {
    console.log(`\n  ${w.arm_id}  client=${w.client}  fire_at=${w.fire_at}`);
    console.log(`    window:  ${w.window_start} .. ${w.window_end}`);
    console.log(`    calls in window: ${w.calls.length}`);
    for (const c of w.calls) {
      console.log(
        `      - ${c.ts}  id=${c.id}  label=${c.run_label ?? "(none)"}  ` +
          `era=${c.era}  from=${identityKey(c.transport)}  beacon_age_s=${c.beacon_age_seconds ?? "n/a"}`,
      );
    }
    console.log(`    label match:            ${w.label_match}`);
    console.log(`    away attestation:       ${w.attest_away}`);
    console.log(`    transport unseen in manual traffic: ${w.transport_unseen_outside_windows}`);
    console.log(`    beacon at fire time:    ${w.beacon}`);
    console.log(`    independent discriminator: ${w.independent_discriminator}`);
    if (w.unmet.length === 0) console.log("    => CLEAN (counts toward confirmation)");
    else for (const u of w.unmet) console.log(`    => unmet: ${u}`);
  }
  console.log("\nRecord the outcome in RESULT.local.md (copy RESULT-TEMPLATE.md).\n");
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
    console.error("usage: serve | arm | report | verify-nonce <nonce>");
    process.exit(2);
}
