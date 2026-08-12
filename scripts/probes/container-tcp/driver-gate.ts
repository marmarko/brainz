/**
 * What the DRIVER can establish for itself, without believing the report.
 *
 * The container writes its own report, stamps its own `origin: 'container'`,
 * and computes its own verdict. Every one of those is a claim inside a JSON
 * body, and a run that never touched Cloudflare produces exactly the same
 * claims: `wrangler dev` runs the identical image in local Docker, which the
 * README's own prerequisites make a likely detour (Containers need a Workers
 * Paid plan, and the first amd64 build is slow). A probe that certifies
 * Assumption 4 from a laptop is worse than no probe, because the whole KTD2
 * rationale rests on the answer.
 *
 * So this module holds the half of the evidence the driver observed with its
 * own eyes — the URL it dialled, and Cloudflare's `cf-ray` on the response it
 * got back — and it may only ever DOWNGRADE a verdict, never upgrade one. The
 * container's answer is preserved in `driver.containerVerdict` so the written
 * artifact shows both what was claimed and why it was refused.
 *
 * It lives outside `container/` on purpose: that directory is the image payload
 * and must stay self-contained.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  hostFingerprint,
  materializeMeaning,
  VERDICTS,
  type CalibrationReceiptCheck,
  type DriverAttestation,
  type ProbeReport,
  type Verdict,
} from './container/report.ts';

export interface EndpointEvidence {
  scheme: string;
  hostShape: DriverAttestation['endpointHostShape'];
  fingerprint: string;
  cfRayPresent: boolean;
  cfRayColo: string | null;
}

/**
 * PUBLIC REPO: the `*.workers.dev` subdomain identifies the account, so the
 * endpoint is fingerprinted exactly like the Neon host and never written out.
 */
export function classifyEndpoint(base: string, headers: Headers | null): EndpointEvidence {
  const url = new URL(base);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  let hostShape: DriverAttestation['endpointHostShape'] = 'public';
  if (host === '') {
    hostShape = 'unknown';
  } else if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host)
  ) {
    hostShape = 'loopback';
  } else if (
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    !host.includes('.')
  ) {
    hostShape = 'private';
  }
  const ray = headers?.get('cf-ray') ?? null;
  return {
    scheme: url.protocol,
    hostShape,
    fingerprint: hostFingerprint(host),
    cfRayPresent: ray !== null && ray !== '',
    cfRayColo: ray !== null && ray.includes('-') ? (ray.split('-').pop() ?? null) : null,
  };
}

export type ParseOutcome =
  | { ok: true; report: ProbeReport }
  | { ok: false; problems: string[] };

/**
 * The report arrives as JSON from a URL the operator supplied. Reading
 * `verdictMeaning.exitCode` off whatever answered is how a probe ends up
 * exiting 0 on someone else's 200. Anything that is not this probe's own schema
 * is refused rather than coerced.
 */
export function parseReport(text: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the response body was not JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['the response was JSON, but not an object'] };
  }
  const candidate = parsed as Partial<ProbeReport>;
  const problems: string[] = [];
  if (candidate.probe !== 'container-tcp') problems.push('`probe` is not "container-tcp"');
  if (candidate.schemaVersion !== 3) {
    problems.push(`schemaVersion is ${String(candidate.schemaVersion)}, expected 3`);
  }
  if (candidate.origin !== 'container' && candidate.origin !== 'local') problems.push('`origin` is missing');
  if (typeof candidate.verdict !== 'string' || !(candidate.verdict in VERDICTS)) {
    problems.push("`verdict` is not one of this probe's verdicts");
  }
  if (typeof candidate.attestation !== 'object' || candidate.attestation === null) {
    problems.push('`attestation` is missing — an older image is deployed');
  }
  if (typeof candidate.transports !== 'object' || candidate.transports === null) {
    problems.push('`transports` is missing');
  }
  if (typeof candidate.verdictMeaning !== 'object' || candidate.verdictMeaning === null) {
    problems.push('`verdictMeaning` is missing');
  }
  if (typeof candidate.target !== 'object' || candidate.target === null) problems.push('`target` is missing');
  if (!Array.isArray(candidate.stages) || !Array.isArray(candidate.notes)) {
    problems.push('`stages`/`notes` are missing');
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, report: parsed as ProbeReport };
}

/* ------------------------------------------------------------------------- */
/* The calibration receipt                                                    */
/* ------------------------------------------------------------------------- */

/**
 * A `--local` run leaves a receipt saying whether THIS probe's hand-rolled
 * WebSocket client was ever observed carrying a session.
 *
 * It exists for one verdict: (c). A rejected WebSocket upgrade surfaces as
 * `EWSUPGRADE` with no HTTP status — the browser-shaped API withholds it — so a
 * platform block and a bug in this probe's own handshake are byte-identical in
 * the report. (a) and (b) each prove their own transport by construction; (c)
 * asserts a negative about a client that may never have worked anywhere, and it
 * is also the branch that costs a runtime rewrite.
 */
export interface CalibrationReceipt {
  probe: 'container-tcp';
  hostFingerprint: string;
  at: string;
  wsSessionSemantics: boolean;
  tcpSessionSemantics: boolean;
  wouldBeVerdict: Verdict | null;
}

export function writeReceipt(report: ProbeReport, receiptPath: string): void {
  const receipt: CalibrationReceipt = {
    probe: 'container-tcp',
    hostFingerprint: report.target.hostFingerprint,
    at: report.startedAt,
    wsSessionSemantics: report.transports.webSocket443.sessionSemantics,
    tcpSessionSemantics: report.transports.rawTcpPostgresPort.sessionSemantics,
    wouldBeVerdict: report.wouldBeVerdict,
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

const NO_RECEIPT: CalibrationReceiptCheck = {
  found: false,
  matchesTarget: false,
  wsSessionSemantics: false,
};

export function readReceipt(hostFingerprintOfRun: string, receiptPath: string): CalibrationReceiptCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return NO_RECEIPT;
  }
  if (typeof parsed !== 'object' || parsed === null) return NO_RECEIPT;
  const receipt = parsed as Partial<CalibrationReceipt>;
  if (receipt.probe !== 'container-tcp') return NO_RECEIPT;
  return {
    found: true,
    matchesTarget: receipt.hostFingerprint === hostFingerprintOfRun,
    wsSessionSemantics: receipt.wsSessionSemantics === true,
  };
}

/* ------------------------------------------------------------------------- */
/* The gate                                                                   */
/* ------------------------------------------------------------------------- */

export function gateReport(
  report: ProbeReport,
  evidence: EndpointEvidence,
  receiptPath: string,
): ProbeReport {
  const missing: string[] = [];
  if (evidence.scheme !== 'https:') {
    missing.push(`endpoint_https — PROBE_URL uses ${evidence.scheme} (a deployed Worker is https)`);
  }
  if (evidence.hostShape !== 'public') {
    missing.push(
      `endpoint_public_host — PROBE_URL points at a ${evidence.hostShape} address, which is what ` +
        '`wrangler dev` looks like, not a deployed Worker',
    );
  }
  if (!evidence.cfRayPresent) {
    missing.push(
      "endpoint_cf_ray — the response carried no `cf-ray` header, so it was not served by " +
        "Cloudflare's edge",
    );
  }
  if (report.origin !== 'container') {
    missing.push(`report_origin — the report claims origin "${report.origin}", not "container"`);
  }
  if (!report.attestation.originCorroborated) {
    missing.push(
      `container_attestation — ${report.attestation.missing.join('; ') || 'the container did not corroborate its own origin'}`,
    );
  }

  const receipt = report.verdict === 'C_BOTH_BLOCKED' ? readReceipt(report.target.hostFingerprint, receiptPath) : null;
  const driver: DriverAttestation = {
    mode: 'verdict',
    endpointScheme: evidence.scheme,
    endpointHostShape: evidence.hostShape,
    endpointFingerprint: evidence.fingerprint,
    cfRayPresent: evidence.cfRayPresent,
    cfRayColo: evidence.cfRayColo,
    containerVerdict: report.verdict,
    endpointCorroborated: missing.length === 0,
    missing,
    calibrationReceipt: receipt,
  };

  const notes = [...report.notes];
  let verdict = report.verdict;

  if (missing.length > 0) {
    verdict = 'INCONCLUSIVE_ORIGIN_UNVERIFIED';
    notes.unshift(
      `THE DRIVER REFUSED THIS VERDICT. The container reported ${report.verdict}, but this run ` +
        'could not be shown to have happened inside a deployed Cloudflare Container. Missing: ' +
        `${missing.join('; ')}.`,
    );
  } else if (
    report.verdict === 'C_BOTH_BLOCKED' &&
    !(receipt !== null && receipt.found && receipt.matchesTarget && receipt.wsSessionSemantics)
  ) {
    verdict = 'INCONCLUSIVE_WS_CLIENT_UNPROVEN';
    const why =
      receipt === null || !receipt.found
        ? 'no calibration receipt exists — run `bun run probe:container-tcp -- --local` first'
        : !receipt.matchesTarget
          ? 'the calibration receipt was written against a different Neon project'
          : "the calibration run's own `ws.*` stages did not carry a session either";
    notes.unshift(
      `THE DRIVER REFUSED (c). Both transports failed here, but this probe's WebSocket client has ` +
        `never been observed working anywhere: ${why}. A rejected upgrade and a bug in our own ` +
        'handshake are indistinguishable in the report, and (c) is the branch that costs a ' +
        'runtime rewrite.',
    );
  }

  if (
    evidence.cfRayColo !== null &&
    report.attestation.cloudflareColo !== null &&
    evidence.cfRayColo !== report.attestation.cloudflareColo
  ) {
    notes.push(
      `The colo on the response the driver received (${evidence.cfRayColo}) differs from the one ` +
        `stamped inside the report (${report.attestation.cloudflareColo}). Not fatal — record both ` +
        'in RESULT.md, since the egress question is asked of the colo the CONTAINER ran in.',
    );
  }

  if (verdict === report.verdict) return { ...report, driver, notes };
  return {
    ...report,
    verdict,
    verdictMeaning: materializeMeaning(VERDICTS[verdict], report.target.port),
    notes,
    driver,
  };
}
