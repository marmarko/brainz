/**
 * The report shape, the redactor, and the verdict rule for the Assumption 4
 * probe (plan: `Assumption 4`, `- KTD2.`, `### U1.` step 6).
 *
 * WHY THE VERDICT IS A RULE AND NOT A BOOLEAN
 * -------------------------------------------
 * The plan's no-branch is a three-way fork, and the three arms cost wildly
 * different amounts:
 *
 *   (a) raw TCP on 5432 works           -> KTD2 stands exactly as written.
 *   (b) raw TCP fails, WebSocket works  -> Containers are KEPT. Session and
 *                                          transaction semantics survive, so
 *                                          `SET LOCAL`, prepared statements and
 *                                          the per-tenant LRU all survive. Only
 *                                          the transport changes.
 *   (c) both fail                       -> Workers + the one-shot HTTP driver,
 *                                          which is where pooled TCP, prepared
 *                                          statements and the 128 MB headroom
 *                                          are genuinely forfeited.
 *
 * A probe that collapses (b) into (c) triggers a runtime rewrite that was never
 * needed. A probe that collapses (b) into (a) certifies pooled raw TCP that does
 * not exist. So the verdict is computed from named, independently observed
 * transports — never from "did the driver throw".
 *
 * WHY THERE ARE INCONCLUSIVE VERDICTS
 * -----------------------------------
 * A false fail is as expensive as a false pass here. If the probe's own wire
 * implementation is broken, or the credential is wrong, or the container has no
 * internet at all, then "both transports failed" is a statement about the probe,
 * not about Cloudflare. Those cases get their own verdicts with their own
 * remedies, and they are NOT reported as (c).
 */

import { createHash } from 'node:crypto';

/** How a single observation turned out. */
export type StageStatus =
  /** The stage proved what it set out to prove. */
  | 'ok'
  /** The stage ran and did not prove it. */
  | 'failed'
  /** Not run (precondition absent). Never counts for or against the verdict. */
  | 'skipped'
  /**
   * Failed, and failing is the expected, informative outcome. Used for the
   * one-shot HTTP transport's session-semantics stages: HTTP *should* lose the
   * session, and observing that is what proves the WebSocket transport is not
   * secretly the HTTP function.
   */
  | 'expected_failure';

export type DetailValue = string | number | boolean | null;

export interface StageResult {
  /** Stable machine id, e.g. `tcp.5432.connect`. */
  id: string;
  /** One sentence: what an `ok` here actually proves. */
  proves: string;
  status: StageStatus;
  ms: number;
  detail: Record<string, DetailValue>;
  /** Redacted. Never contains the DSN, the host, or the credential. */
  error: string | null;
}

export interface TransportSummary {
  /** Did the byte channel open at all (TCP handshake / WebSocket upgrade / HTTP response)? */
  channelOpen: boolean;
  /** Did a Postgres session authenticate and answer `SELECT 1`? */
  authenticated: boolean;
  /**
   * Did `SET LOCAL` inside an explicit transaction read back, stay scoped to
   * that transaction, land on one backend, and did a named prepared statement
   * survive between round trips? This — not the TCP handshake — is what KTD2
   * actually needs.
   */
  sessionSemantics: boolean;
}

export type Verdict =
  | 'A_RAW_TCP_OK'
  | 'B_WEBSOCKET_ONLY'
  | 'C_BOTH_BLOCKED'
  | 'INCONCLUSIVE_NO_BASELINE_EGRESS'
  | 'INCONCLUSIVE_TCP_REACHABLE'
  | 'INCONCLUSIVE_WS_OPEN'
  | 'INCONCLUSIVE_PRECONDITION';

export interface VerdictMeaning {
  label: string;
  /** What this verdict says about Assumption 4. */
  assumption4: string;
  /** What the plan should do next. */
  planAction: string;
  /** Process exit code used by `bun run probe:container-tcp`. */
  exitCode: number;
}

export const VERDICTS: Record<Verdict, VerdictMeaning> = {
  A_RAW_TCP_OK: {
    label: '(a) RAW TCP TO 5432 WORKS',
    assumption4: 'HOLDS. A deployed Cloudflare Container opened an unrestricted raw outbound TCP connection to Neon on 5432, completed TLS and SCRAM, and kept full session semantics.',
    planAction: 'KTD2 stands as written: pooled TCP, prepared statements, the per-tenant postgres.js connection LRU, no Hyperdrive slot. No re-decision needed before U6.',
    exitCode: 0,
  },
  B_WEBSOCKET_ONLY: {
    label: '(b) RAW TCP BLOCKED — WEBSOCKET ON 443 WORKS',
    assumption4: 'FAILS as literally worded, but the consequence is small. Raw TCP to 5432 did not work; the Postgres wire protocol over a WebSocket on 443 did, with full session semantics.',
    planAction: "KTD2's first no-branch applies and Containers are KEPT. Swap the transport to @neondatabase/serverless Pool/Client over WebSocket. `SET LOCAL hnsw.ef_search`, prepared statements, the per-tenant LRU and the 128 MB headroom all survive. Do NOT move to Workers. Update Assumption 4's line to record the transport change, and note that a connection now costs a WebSocket upgrade.",
    exitCode: 10,
  },
  C_BOTH_BLOCKED: {
    label: '(c) BOTH TRANSPORTS BLOCKED',
    assumption4: 'FAILS, and the expensive branch applies. Neither raw TCP on 5432 nor the Postgres protocol over a WebSocket on 443 reached Neon from inside the container, while ordinary HTTPS egress from the same container was proven working.',
    planAction: "Take KTD2's priced no-branch: Workers plus Neon's one-shot HTTP driver. Pooled TCP, prepared statements and the 128 MB headroom are forfeited, which puts self-hosted rerank (KTD4) out of reach and forces consolidation onto Containers anyway — a split runtime. Re-open the 128 MB question before U6 is built.",
    exitCode: 20,
  },
  INCONCLUSIVE_NO_BASELINE_EGRESS: {
    label: 'INCONCLUSIVE — no baseline egress',
    assumption4: 'UNSETTLED. Nothing reached Neon, including plain HTTPS on 443. That is a statement about this probe run, not about Cloudflare Containers.',
    planAction: 'Do not branch on this. Check the DSN, that the Neon project is not deleted or suspended past its wake window, and that the container has internet (enableInternet). Re-run.',
    exitCode: 30,
  },
  INCONCLUSIVE_TCP_REACHABLE: {
    label: 'INCONCLUSIVE — 5432 was reachable but the session did not complete',
    assumption4: 'UNSETTLED, and leaning toward (a). The container opened a TCP connection to Neon on 5432 and a real Postgres answered the SSL negotiation, so egress is NOT the blocker. Something after that — TLS, SCRAM, or this probe\'s own wire implementation — failed.',
    planAction: "Do not branch on this. Run the laptop calibration (`--local`) against the same DSN: if it fails there too, the fault is this probe, not the platform. If calibration passes and the container does not, escalate to the real drivers per the README's escalation section.",
    exitCode: 30,
  },
  INCONCLUSIVE_WS_OPEN: {
    label: 'INCONCLUSIVE — the WebSocket opened but the session did not complete',
    assumption4: "UNSETTLED, and leaning toward (b). The container completed a WebSocket upgrade to Neon's wire proxy on 443, so 443 egress is not the blocker. Something after that failed.",
    planAction: "Do not branch on this. Run the laptop calibration (`--local`) first, then the README's escalation to @neondatabase/serverless.",
    exitCode: 30,
  },
  INCONCLUSIVE_PRECONDITION: {
    label: 'INCONCLUSIVE — the probe refused to run',
    assumption4: 'UNSETTLED. A precondition was not met, so no transport was tested.',
    planAction: 'Read the precondition stage in the report and fix the input. Nothing here says anything about Cloudflare Containers.',
    exitCode: 30,
  },
};

export interface ProbeReport {
  probe: 'container-tcp';
  settles: 'Assumption 4 — a deployed Cloudflare Container can open unrestricted raw outbound TCP to Neon';
  schemaVersion: 1;
  startedAt: string;
  totalMs: number;
  /**
   * `container` is the only value that settles anything. `local` is the
   * calibration run — it proves the probe's own wire implementation works
   * against this Neon project, so that a container failure is attributable to
   * the platform rather than to this code.
   */
  origin: 'container' | 'local';
  environment: Record<string, DetailValue>;
  target: {
    hostFingerprint: string;
    hostSuffix: string;
    port: number;
    isPoolerEndpoint: boolean;
  };
  stages: StageResult[];
  transports: {
    /** (a) — raw TCP on the Postgres port. */
    rawTcp5432: TransportSummary;
    /** (b) — the Postgres wire protocol tunnelled over a WebSocket on 443. */
    webSocket443: TransportSummary;
    /** The negative control. Neon's one-shot HTTP SQL endpoint on 443. */
    httpOneShot443: TransportSummary;
  };
  verdict: Verdict;
  verdictMeaning: VerdictMeaning;
  notes: string[];
}

/* ------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The report is designed to be pasted into RESULT.md, which is committed to a
 * PUBLIC repo. So the report can never contain the connection string, the role,
 * the password, or the Neon endpoint hostname — and the hostname is the one
 * that leaks by accident, because it rides inside error strings that nobody
 * reads before pasting (`getaddrinfo ENOTFOUND ep-xxxx-xxxx.region.aws.neon.tech`).
 *
 * Everything user-visible goes through this. The host is replaced by a stable
 * fingerprint so two runs against the same project are still comparable.
 */
export interface Redactor {
  (value: string): string;
}

export function hostFingerprint(host: string): string {
  return `host#${createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 12)}`;
}

/** The last two labels of a hostname (`neon.tech`), which identify no project. */
export function hostSuffix(host: string): string {
  const labels = host.split('.');
  return labels.slice(-2).join('.');
}

export function makeRedactor(secrets: readonly string[], host: string): Redactor {
  const fingerprint = hostFingerprint(host);
  // Longest first, so a password that contains the user name is masked whole.
  const needles = [...new Set(secrets.filter((s) => s.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  return (value: string): string => {
    let out = value;
    for (const needle of needles) out = out.split(needle).join('[redacted]');
    // Host last: some needles (the whole DSN) contain it.
    out = out.split(host).join(fingerprint);
    // Any surviving Neon endpoint id, e.g. from a CNAME in a DNS error.
    out = out.replace(/\bep-[a-z0-9-]+\b/gi, '[redacted-endpoint]');
    // Address literals. A connect error carries the resolved address
    // (`ECONNREFUSED 203.0.113.7:443`), which is shared AWS infrastructure
    // rather than a secret — but it is still an identifier, and this string is
    // headed for a file in a public repo.
    out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[redacted-ip]');
    out = out.replace(/\b(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{0,4}\b/gi, '[redacted-ip]');
    return out;
  };
}

/* ------------------------------------------------------------------------- */
/* The verdict rule                                                           */
/* ------------------------------------------------------------------------- */

export interface VerdictInputs {
  /** A precondition refused the run (bad DSN, pooler endpoint, ...). */
  precondition: { ok: boolean };
  rawTcp5432: TransportSummary;
  webSocket443: TransportSummary;
  httpOneShot443: TransportSummary;
  /** Plain HTTPS GET against the Neon host. Proves generic internet from here. */
  genericHttpsEgress: boolean;
  /**
   * A raw TCP handshake to the Neon host on 443 (no protocol). Separates
   * "this container cannot open ANY raw socket" from "port 5432 specifically
   * is filtered" — a distinction that changes what a fallback could look like.
   */
  rawTcp443Reachable: boolean;
}

export function decideVerdict(i: VerdictInputs): Verdict {
  if (!i.precondition.ok) return 'INCONCLUSIVE_PRECONDITION';

  // (a) is the only verdict that certifies raw pooled TCP, so it demands the
  // full session battery, not merely a handshake.
  if (i.rawTcp5432.sessionSemantics) return 'A_RAW_TCP_OK';

  // (b) likewise: KTD2's no-branch survives *because* session semantics do.
  if (i.webSocket443.sessionSemantics) return 'B_WEBSOCKET_ONLY';

  // Below here both real transports failed. Before that can mean (c), the
  // probe has to rule out itself.

  // Nothing at all got out. This is a config/credential/network problem.
  const baselineEgress = i.genericHttpsEgress || i.httpOneShot443.authenticated;
  if (!baselineEgress) return 'INCONCLUSIVE_NO_BASELINE_EGRESS';

  // Egress to 5432 demonstrably worked — a real Postgres answered the SSL
  // negotiation — so whatever failed afterwards is not the platform blocking
  // raw TCP. Calling this (c) would forfeit pooled TCP over a bug in this file.
  if (i.rawTcp5432.channelOpen) return 'INCONCLUSIVE_TCP_REACHABLE';

  // Same argument on the 443 side: the wire proxy accepted a WebSocket upgrade.
  if (i.webSocket443.channelOpen) return 'INCONCLUSIVE_WS_OPEN';

  return 'C_BOTH_BLOCKED';
}

export function summarizeNotes(i: VerdictInputs, verdict: Verdict): string[] {
  const notes: string[] = [];
  if (verdict === 'C_BOTH_BLOCKED' && i.rawTcp443Reachable) {
    notes.push(
      'A raw TCP handshake to the same host on port 443 DID succeed while 5432 did not. ' +
        'That is port filtering, not a blanket ban on outbound sockets — worth raising with ' +
        'Cloudflare before accepting the priced no-branch.',
    );
  }
  if (verdict === 'C_BOTH_BLOCKED' && !i.rawTcp443Reachable) {
    notes.push(
      'Raw TCP failed on both 5432 and 443 while HTTPS succeeded, which reads as ' +
        '"no raw sockets from this runtime at all" rather than "port 5432 is filtered".',
    );
  }
  if (verdict === 'A_RAW_TCP_OK' && !i.webSocket443.sessionSemantics) {
    notes.push(
      'The WebSocket transport did not complete. That does not affect the verdict — (a) is ' +
        'decided by raw TCP — but it means the (b) fallback is unproven if raw TCP is ever ' +
        'withdrawn.',
    );
  }
  if (i.httpOneShot443.sessionSemantics) {
    notes.push(
      "Neon's one-shot HTTP endpoint appeared to preserve session semantics. That should be " +
        'impossible and casts doubt on the session battery itself — treat the whole run as ' +
        'suspect and re-run the laptop calibration.',
    );
  }
  return notes;
}
