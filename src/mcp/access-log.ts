/**
 * The content-free access log.
 *
 * **What it is for, stated as the question it answers.** After any keying bug —
 * a grant resolved to the wrong tenant, a cache serving a neighbour's row — the
 * question is "was my data reached". Without a log the honest answer is
 * *unknown*: the attestation and the canary prove isolation **forward** from
 * now, and neither reconstructs the past. Production signals that are not merely
 * content-free but *actor-free* cannot answer it at all.
 *
 * **Five fields, and the shape is the privacy control.** Grant id, tenant id,
 * tool name, timestamp, result class. There is no field for the query, no field
 * for the row, no field for an error message — because an error message is the
 * ordinary way a user's filename or a fragment of their mail ends up in a log
 * that R10's register says holds no content. The type below is the enforcement:
 * a future field that wants to carry text has to be added here, in front of a
 * test that enumerates the keys.
 *
 * **It is written off the response critical path and it never throws.** A log
 * sink that can fail a tool call is a log sink that gets removed the first time
 * it has a bad night.
 */

/**
 * How a call ended, coarsely enough to be useful and coarsely enough to be
 * content-free.
 *
 * `scope_denied` is separate from `unauthorized` deliberately: the first is a
 * valid credential reaching outside its origins, which is the event an isolation
 * incident is made of, and collapsing it into "auth error" is how it becomes
 * invisible.
 */
export const RESULT_CLASSES = [
  'ok',
  'degraded',
  'not_found',
  'invalid_params',
  'unauthorized',
  'scope_denied',
  'unknown_tool',
  'rate_limited',
  'unavailable',
  'error',
] as const;

export type ResultClass = (typeof RESULT_CLASSES)[number];

/** The exact field set. Pinned by `test/mcp/dispatch.test.ts`. */
export const ACCESS_LOG_FIELDS = ['at', 'grantId', 'resultClass', 'tenantId', 'tool'] as const;

export interface AccessLogRecord {
  /** ISO timestamp. */
  readonly at: string;
  /** The grant, or `anonymous` when the call never authenticated. */
  readonly grantId: string;
  readonly tenantId: string;
  readonly tool: string;
  readonly resultClass: ResultClass;
}

export interface AccessLog {
  /** Must not throw and must not await: dispatch calls it after the response. */
  record(entry: AccessLogRecord): void;
}

export interface InMemoryAccessLog extends AccessLog {
  readonly entries: readonly AccessLogRecord[];
}

/**
 * The test and local-development sink.
 *
 * The durable binding is deliberately absent: the control plane's alphabets
 * cannot hold a tool name enum it does not declare, and the retention policy for
 * an access log is a U15 decision with a legal half. What is fixed here is the
 * record shape, so the durable sink is a `record` implementation rather than a
 * redesign.
 */
export function createInMemoryAccessLog(): InMemoryAccessLog {
  const entries: AccessLogRecord[] = [];
  return {
    entries,
    record(entry) {
      // A shallow copy, deliberately **not** a field-by-field rebuild. Copying
      // five named fields would make this sink sanitise its own input, and a
      // sink that sanitises is a sink that hides a caller passing a sixth field
      // — which is exactly the regression the key assertion in
      // `test/mcp/dispatch.test.ts` exists to catch. The record shape is the
      // contract; this stores what it was handed.
      entries.push({ ...entry });
    },
  };
}
