/**
 * The report shape, the redactor, and the verdict rule for the Assumption 4
 * probe (plan: `Assumption 4`, `- KTD2.`, `### U1.` step 6).
 *
 * WHY THE VERDICT IS A RULE AND NOT A BOOLEAN
 * -------------------------------------------
 * The plan's no-branch is a three-way fork, and the three arms cost wildly
 * different amounts:
 *
 *   (a) raw TCP on the Postgres port works -> KTD2 stands exactly as written.
 *   (b) raw TCP fails, WebSocket works     -> Containers are KEPT. Session and
 *                                             transaction semantics survive, so
 *                                             `SET LOCAL`, prepared statements
 *                                             and the per-tenant LRU all
 *                                             survive. Only the transport
 *                                             changes.
 *   (c) both fail                          -> Workers + the one-shot HTTP
 *                                             driver, which is where pooled TCP,
 *                                             prepared statements and the 128 MB
 *                                             headroom are genuinely forfeited.
 *
 * A probe that collapses (b) into (c) triggers a runtime rewrite that was never
 * needed. A probe that collapses (b) into (a) certifies pooled raw TCP that does
 * not exist. So the verdict is computed from named, independently observed
 * transports — never from "did the driver throw".
 *
 * WHY THERE ARE SO MANY INCONCLUSIVE VERDICTS
 * -------------------------------------------
 * The governing rule of this file: **absence of evidence is never evidence of
 * success.** A missing signal, a swallowed error, an unreachable control, an
 * instrument that could not be shown to discriminate — each produces an
 * explicitly named `INCONCLUSIVE_*` with a non-zero exit code, never a pass and
 * never a decisive fail. Every conclusive verdict (a)/(b)/(c) requires positive
 * evidence for each of its claims:
 *
 *   - that the run happened where it says it happened (origin corroboration),
 *   - that authentication established what it can establish on that transport —
 *     a verified SCRAM server signature on the Postgres port, where Neon offers
 *     SCRAM; and on the WebSocket leg, where Neon's proxy offers only a
 *     cleartext password inside its own TLS, that the peer at least CHALLENGED
 *     for a credential (see `PeerVerificationReason`),
 *   - that the instrument can register a negative (the HTTP one-shot control),
 *   - and, for (b)/(c), that raw TCP to the Postgres port genuinely did not open.
 *
 * WHY THE PEER GATE IS PER-TRANSPORT
 * ----------------------------------
 * It was not, and that was a bug with a price. `peerVerified` came from SCRAM's
 * server-signature check and gated (a) AND (b). Neon's WebSocket wire proxy
 * cannot produce a server signature — it terminates TLS itself and then asks for
 * a cleartext password, offering no SASL at all — so (b) was unreachable against
 * real Neon. A deployed container with raw TCP blocked would have reported
 * INCONCLUSIVE_PEER_UNVERIFIED instead of (b), and (b) is the answer that KEEPS
 * Containers. The gate is now scoped per transport, and the job it was doing on
 * the WebSocket leg is carried by `classifyNegativeControl` plus the session
 * battery instead.
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
  /** Stable machine id, e.g. `tcp.channel_open`. */
  id: string;
  /** One sentence: what an `ok` here actually proves. */
  proves: string;
  status: StageStatus;
  ms: number;
  detail: Record<string, DetailValue>;
  /** Redacted. Never contains the DSN, the host, or the credential. */
  error: string | null;
}

/**
 * WHY `peerVerified: false` IS NOT ONE FACT BUT SEVERAL
 * ----------------------------------------------------
 * A bare false collapses three situations that mean completely different things:
 * a peer that refused to prove itself, a peer that was never asked, and a peer
 * that CANNOT be asked because the endpoint does not offer a mechanism with
 * mutual proof. Neon's WebSocket wire proxy is the third: it asks for a
 * cleartext password inside the `wss` tunnel and does not offer SASL/SCRAM at
 * all, so there is no server signature to verify on that leg by design.
 *
 * The distinction is load-bearing rather than cosmetic. `peerVerified` used to
 * gate BOTH (a) and (b); against real Neon that made (b) unreachable, so a
 * container with raw TCP blocked would have reported an inconclusive instead of
 * the branch that KEEPS Containers. The reason is what lets the gate be
 * per-transport without becoming a hole.
 */
export type PeerVerificationReason =
  /** SCRAM-SHA-256 completed and the server's `v=` signature verified. */
  | 'scram_server_signature_verified'
  /**
   * The endpoint asked for `AuthenticationCleartextPassword` and offered no
   * SASL. Authentication succeeded; the peer proved nothing to us at the
   * Postgres layer, because this mechanism carries nothing for it to prove with.
   */
  | 'cleartext_auth_no_server_signature'
  /**
   * The far end asked for NO authentication and went straight to
   * AuthenticationOk. This is the terminator signature, and it never unlocks a
   * conclusive verdict on any transport.
   */
  | 'no_authentication_requested'
  /** Authentication was attempted and did not complete. */
  | 'auth_incomplete'
  /** The channel never opened, so authentication was never attempted. */
  | 'auth_not_attempted'
  /**
   * The one-shot HTTP endpoint authenticates inside Neon from a connection
   * string in a header, not over the wire from here. It carries no evidence
   * about the peer in either direction, by construction.
   */
  | 'one_shot_http_no_wire_auth';

export interface TransportSummary {
  /** Did the byte channel open at all (TCP handshake / WebSocket upgrade / HTTP response)? */
  channelOpen: boolean;
  /** Did a Postgres session authenticate and answer `SELECT 1`? */
  authenticated: boolean;
  /**
   * Did a SCRAM-SHA-256 exchange run to completion AND the server's final
   * signature verify? This is recorded as a fact rather than asserted in prose,
   * because on a transport that OFFERS SCRAM it is the only thing standing
   * between "a Postgres answered" and "something accepted the socket".
   *
   * False does not mean "suspicious" on its own — read `peerVerificationReason`,
   * which says WHICH of the several very different situations produced it.
   *
   * NOTE ON WHAT THIS DOES NOT RULE OUT, WHEN TRUE: plain SCRAM (no channel
   * binding — see `scram.ts`) cannot detect a *relaying* proxy, which forwards
   * the exchange upstream and returns a signature that verifies legitimately. It
   * rules out a terminator that merely accepted the socket, not a byte forwarder.
   */
  peerVerified: boolean;
  /** Why `peerVerified` holds the value it does. See PeerVerificationReason. */
  peerVerificationReason: PeerVerificationReason;
  /**
   * Did `SET LOCAL` inside an explicit transaction read back, stay scoped to
   * that transaction, land on one backend, and did a named prepared statement
   * survive between round trips? This — not the TCP handshake — is what KTD2
   * actually needs.
   *
   * On the WebSocket leg this is now the WHOLE of the anti-terminator argument,
   * since that endpoint offers no mechanism with mutual proof. See
   * `classifyNegativeControl` for the check that keeps it honest.
   */
  sessionSemantics: boolean;
}

/** The five session assertions, as observed on one channel. */
export interface SessionAssertions {
  selectOne: boolean;
  setLocalReadback: boolean;
  sameBackendInTxn: boolean;
  localScopedOut: boolean;
  preparedStatement: boolean;
}

/**
 * What the negative control (Neon's one-shot HTTP SQL endpoint) established.
 *
 * `discriminated` is the only value that certifies the session battery can
 * register a negative. `absent` means the control never ran — which is NOT the
 * same as it having behaved, and must never be read as if it had.
 */
export type NegativeControlState =
  /**
   * It authenticated and then failed the assertions that can only hold on a real
   * session — the `SET LOCAL` nonce readback and the prepared statement.
   */
  | 'discriminated'
  /** It never authenticated, so the battery's null check did not happen. */
  | 'absent'
  /** It appeared to KEEP per-session state, which should be impossible. */
  | 'suspect';

/**
 * WHY THIS IS STRICTER THAN "the control did not pass the battery"
 * ---------------------------------------------------------------
 * `peerVerified` no longer gates (b), because Neon's WebSocket proxy offers no
 * mechanism that could produce it. The job that gate was doing — refusing to let
 * a thing that merely accepted a channel be read as a real Postgres session —
 * falls entirely to the session battery on that leg. So the battery has to be
 * shown to DISCRIMINATE, not merely to have returned a non-pass.
 *
 * Two of the four session assertions are the ones a channel with no session
 * behind it cannot pass, and they are the two checked here:
 *
 *   setLocalReadback   a nonce written by one statement is read back by the next
 *   preparedStatement  a named statement created by one round trip runs in a later one
 *
 * Either of those passing on Neon's one-shot HTTP endpoint would mean the
 * channel held state it cannot hold, so the instrument is measuring something
 * other than what it claims and NO verdict from it is usable — `suspect`.
 *
 * `sameBackendInTxn` is deliberately NOT required to fail. Neon's HTTP endpoint
 * keeps warm backends and consecutive requests can genuinely land on the same
 * pid; requiring it to differ would make the control flap on a true negative.
 * `localScopedOut` is derived from `setLocalReadback` (see battery.ts) and so
 * cannot pass without it.
 */
export function classifyNegativeControl(
  authenticated: boolean,
  assertions: SessionAssertions,
): NegativeControlState {
  if (!authenticated) return 'absent';
  if (assertions.setLocalReadback || assertions.preparedStatement) return 'suspect';
  return 'discriminated';
}

export type Verdict =
  | 'A_RAW_TCP_OK'
  | 'B_WEBSOCKET_ONLY'
  | 'C_BOTH_BLOCKED'
  | 'CALIBRATION_ONLY'
  | 'INCONCLUSIVE_ORIGIN_UNVERIFIED'
  | 'INCONCLUSIVE_NO_BASELINE_EGRESS'
  | 'INCONCLUSIVE_TCP_REACHABLE'
  | 'INCONCLUSIVE_WS_OPEN'
  | 'INCONCLUSIVE_PEER_UNVERIFIED'
  | 'INCONCLUSIVE_CONTROL_ABSENT'
  | 'INCONCLUSIVE_CONTROL_SUSPECT'
  | 'INCONCLUSIVE_WS_CLIENT_UNPROVEN'
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

/**
 * `{port}` is substituted with the port actually dialled (see
 * `materializeMeaning`). The literal `5432` never appears in a verdict string:
 * the port is DSN-derived, and a label that hardcodes it would certify a port
 * that was never touched.
 */
export const VERDICTS: Record<Verdict, VerdictMeaning> = {
  A_RAW_TCP_OK: {
    label: '(a) RAW TCP TO {port} WORKS',
    assumption4:
      'HOLDS. A deployed Cloudflare Container opened an unrestricted raw outbound TCP connection to Neon on {port}, completed TLS and a verified SCRAM-SHA-256 exchange, and kept full session semantics.',
    planAction:
      'KTD2 stands as written: pooled TCP, prepared statements, the per-tenant postgres.js connection LRU, no Hyperdrive slot. No re-decision needed before U6.',
    exitCode: 0,
  },
  B_WEBSOCKET_ONLY: {
    label: '(b) RAW TCP BLOCKED — WEBSOCKET ON 443 WORKS (peer NOT cryptographically verified)',
    assumption4:
      'FAILS as literally worded, but the consequence is small. Raw TCP to {port} did not work; the Postgres wire protocol over a WebSocket on 443 did, with full session semantics. READ THIS BEFORE QUOTING IT AS EQUIVALENT TO (a): peer identity was NOT cryptographically verified at the Postgres layer on that transport. Neon\'s WebSocket wire proxy asks for a cleartext password inside the already-TLS tunnel and offers no SASL/SCRAM, so there is no server signature to check — by design, not by failure. What stands behind the peer\'s identity here is the runtime\'s TLS certificate validation of the `wss` endpoint, plus the session battery: SET LOCAL nonce readback, one backend pid across an explicit transaction, the GUC scoped out after COMMIT, and a prepared statement surviving a round trip — every one of which Neon\'s one-shot HTTP endpoint failed on the same run. That rules out a thing that merely accepted a channel. It is a strictly weaker claim than (a)\'s verified SCRAM server signature.',
    planAction:
      "KTD2's first no-branch applies and Containers are KEPT. Swap the transport to @neondatabase/serverless Pool/Client over WebSocket. `SET LOCAL hnsw.ef_search`, prepared statements, the per-tenant LRU and the 128 MB headroom all survive. Do NOT move to Workers. Update Assumption 4's line to record the transport change, note that a connection now costs a WebSocket upgrade, and record that the WebSocket leg authenticates with a cleartext password over TLS rather than SCRAM — so certificate validation of the wss endpoint is the thing that must not be disabled.",
    exitCode: 10,
  },
  C_BOTH_BLOCKED: {
    label: '(c) BOTH TRANSPORTS BLOCKED',
    assumption4:
      'FAILS, and the expensive branch applies. Neither raw TCP on {port} nor the Postgres protocol over a WebSocket on 443 reached Neon from inside the container, while ordinary HTTPS egress from the same container was proven working.',
    planAction:
      "Take KTD2's priced no-branch: Workers plus Neon's one-shot HTTP driver. Pooled TCP, prepared statements and the 128 MB headroom are forfeited, which puts self-hosted rerank (KTD4) out of reach and forces consolidation onto Containers anyway — a split runtime. Re-open the 128 MB question before U6 is built.",
    exitCode: 20,
  },
  CALIBRATION_ONLY: {
    label: 'CALIBRATION ONLY — NOT A VERDICT',
    assumption4:
      "NOT SETTLED, and this run cannot settle it. It measured the machine that invoked it, not a deployed Cloudflare Container. What it does establish is whether this probe's own wire implementation works against this Neon project — which is what makes a later container failure attributable to the platform rather than to this code. Read `wouldBeVerdict` for what the same evidence would have meant had it come from a container.",
    planAction:
      'Deploy the Worker and container and re-run WITHOUT --local. Only that run may be recorded in RESULT.md as the answer to Assumption 4. Nothing in the plan changes on this exit code.',
    exitCode: 50,
  },
  INCONCLUSIVE_ORIGIN_UNVERIFIED: {
    label: 'INCONCLUSIVE — this run cannot be shown to have happened on Cloudflare',
    assumption4:
      "UNSETTLED. The report claims it came from a container, but the evidence that would corroborate that — the Worker seeing a Cloudflare `cf` object on the incoming request, a colo, and a `cf-ray` response header observed by the driver itself — was not all present. `wrangler dev` runs the identical image in local Docker and would produce exactly this report from a laptop, so a pass here would certify Assumption 4 against somebody's machine.",
    planAction:
      'Do not branch on this, and do not record it in RESULT.md. Deploy for real (`wrangler deploy`) and run the driver against the deployed `*.workers.dev` URL over https. The report names which specific pieces of evidence were missing.',
    exitCode: 30,
  },
  INCONCLUSIVE_NO_BASELINE_EGRESS: {
    label: 'INCONCLUSIVE — no baseline egress',
    assumption4:
      'UNSETTLED. Nothing reached Neon, including plain HTTPS on 443. That is a statement about this probe run, not about Cloudflare Containers.',
    planAction:
      'Do not branch on this. Check the DSN, that the Neon project is not deleted or suspended past its wake window, and that the container has internet (enableInternet). If the report shows `cloudflare_egress_ca_present=true` with `extra_ca_configured=false`, Cloudflare is intercepting outbound HTTPS and the container is not trusting its CA — rebuild the image so the entrypoint exports NODE_EXTRA_CA_CERTS. Re-run.',
    exitCode: 30,
  },
  INCONCLUSIVE_TCP_REACHABLE: {
    label: 'INCONCLUSIVE — the Postgres port was reachable but the session did not complete',
    assumption4:
      "UNSETTLED, and leaning toward (a). A raw outbound TCP handshake to Neon on {port} completed, so egress on that port is NOT blocked. Something after that — TLS, SCRAM, or this probe's own wire implementation — did not finish. Reporting (b) or (c) here would forfeit pooled TCP over a transient or a bug in this code.",
    planAction:
      "Do not branch on this. Re-run first: a single lost packet on one read is enough to land here. If it repeats, run the laptop calibration (`--local`) against the same DSN — if it fails there too, the fault is this probe, not the platform — and then escalate to the real drivers per the README's escalation section.",
    exitCode: 30,
  },
  INCONCLUSIVE_WS_OPEN: {
    label: 'INCONCLUSIVE — the WebSocket opened but the session did not complete',
    assumption4:
      "UNSETTLED, and leaning toward (b). The container completed a WebSocket upgrade to Neon's wire proxy on 443, so 443 egress is not the blocker. Something after that failed.",
    planAction:
      "Do not branch on this. Re-run, then run the laptop calibration (`--local`), then the README's escalation to @neondatabase/serverless.",
    exitCode: 30,
  },
  INCONCLUSIVE_PEER_UNVERIFIED: {
    label: 'INCONCLUSIVE — the session worked but authentication established nothing about the peer',
    assumption4:
      'UNSETTLED. A transport carried a full Postgres session, but the authentication that happened on it was not one this probe accepts for that transport. On the raw TCP port that means no completed SCRAM-SHA-256 exchange with a verified server signature — Neon\'s Postgres DOES offer SCRAM on {port}, so its absence is the finding. On the WebSocket leg, a cleartext password inside the TLS tunnel IS accepted (that is all Neon\'s wire proxy offers), so reaching this verdict there means something else happened: most likely the far end asked for NO authentication at all and went straight to AuthenticationOk, which is exactly how a terminator that merely accepted the channel would look.',
    planAction:
      'Do not branch on this. Read the authenticate stage: `auth_method`, `scram_started`, `server_signature_verified` and `peer_verification_reason` are recorded there. `no_authentication_requested` means the peer was never challenged for anything and is the serious case; `auth_incomplete` means the exchange broke midway and a re-run is the first move.',
    exitCode: 30,
  },
  INCONCLUSIVE_CONTROL_ABSENT: {
    label: "INCONCLUSIVE — the battery's negative control did not run",
    assumption4:
      "UNSETTLED. A transport passed every session assertion, but Neon's one-shot HTTP endpoint — the null check that shows this battery can register a FAILING session — never authenticated, so it never demonstrated the negative. Four assertions that all pass, on an instrument never shown to be capable of failing, is not evidence.",
    planAction:
      'Do not branch on this. Read the `http.select_1` stage for why the control could not run (a 4xx from the endpoint, an unreachable host, or intercepted TLS) and fix that, then re-run. If `cloudflare_egress_ca_present=true` and `extra_ca_configured=false`, the container is not trusting Cloudflare\'s egress CA and every HTTPS candidate will fail certificate validation.',
    exitCode: 30,
  },
  INCONCLUSIVE_CONTROL_SUSPECT: {
    label: 'INCONCLUSIVE — the negative control kept state it cannot hold',
    assumption4:
      "UNSETTLED, and the instrument is in doubt. Neon's one-shot HTTP endpoint, which has no session behind it at all, read back the `SET LOCAL` nonce or ran a prepared statement created by an earlier round trip. That should be impossible, so the battery is measuring something other than what it claims, and no verdict computed from it can be trusted in either direction. It matters more than it used to: on the WebSocket leg the battery is now the WHOLE of the argument that the far end is a real Postgres session rather than something that accepted a channel.",
    planAction:
      'Do not branch on this, in either direction. Re-run the laptop calibration and read the `http.*` stages: the battery itself needs fixing before this probe can settle anything.',
    exitCode: 30,
  },
  INCONCLUSIVE_WS_CLIENT_UNPROVEN: {
    label: "INCONCLUSIVE — (c) claimed, but this probe's own WebSocket client was never proven anywhere",
    assumption4:
      "UNSETTLED. The evidence points at (c) — the expensive branch — but the WebSocket arm has never been observed working, here or in calibration. A rejected upgrade and a bug in this probe's hand-rolled WebSocket handshake are byte-identical in the report (`EWSUPGRADE` carries no HTTP status), so (c) cannot be distinguished from \"our WebSocket client is broken\" without a run where it worked.",
    planAction:
      'Do not branch on this — it is the branch that costs a runtime rewrite. Run `bun run probe:container-tcp -- --local` against the same Neon project and confirm the `ws.*` stages pass there; that writes the calibration receipt this check looks for. Then re-run the container probe.',
    exitCode: 30,
  },
  INCONCLUSIVE_PRECONDITION: {
    label: 'INCONCLUSIVE — the probe refused to run',
    assumption4: 'UNSETTLED. A precondition was not met, so no transport was tested.',
    planAction:
      'Read the precondition stage in the report and fix the input. Nothing here says anything about Cloudflare Containers.',
    exitCode: 30,
  },
};

export function materializeMeaning(meaning: VerdictMeaning, port: number): VerdictMeaning {
  const portText = port > 0 ? String(port) : 'the Postgres port';
  const sub = (text: string): string => text.split('{port}').join(portText);
  return {
    label: sub(meaning.label),
    assumption4: sub(meaning.assumption4),
    planAction: sub(meaning.planAction),
    exitCode: meaning.exitCode,
  };
}

/* ------------------------------------------------------------------------- */
/* Attestation — where did this run actually happen?                          */
/* ------------------------------------------------------------------------- */

/**
 * Evidence about WHERE the run happened, gathered inside the container.
 *
 * This block exists because the container stamps `origin: 'container'` on its
 * own report, and a self-declared origin is not evidence. `wrangler dev` runs
 * this identical image in local Docker on a laptop — a likely detour, since
 * Containers need a Workers Paid plan and the first amd64 build is slow — and
 * without corroboration that run is indistinguishable from a deployed one.
 *
 * PUBLIC REPO: names only, never values. `CLOUDFLARE_DEPLOYMENT_ID` and friends
 * carry account-scoped identifiers, so only the presence of each variable is
 * recorded. Same for the ray id: the colo suffix, never the id.
 */
export interface OriginAttestation {
  /** What the runtime says about itself. Not evidence on its own. */
  claimedOrigin: 'container' | 'local';
  /**
   * Did the Worker see a Cloudflare `cf` object on the incoming request? It is
   * present at the production edge and absent under a plain `wrangler dev`.
   */
  workerSawCfObject: boolean;
  /** The colo the Worker's request landed in. Null when there was no `cf`. */
  cloudflareColo: string | null;
  /** Colo suffix of the incoming `cf-ray` header, as the Worker saw it. */
  workerRayColo: string | null;
  /** NAMES ONLY of Cloudflare-injected container environment variables seen. */
  containerEnvMarkers: string[];
  /** Cloudflare's outbound HTTPS interception CA, if it is mounted. */
  cloudflareEgressCaPresent: boolean;
  /** Whether this process was started with NODE_EXTRA_CA_CERTS pointing at it. */
  extraCaConfigured: boolean;
  /**
   * True when the claimed origin is corroborated by the evidence above. A
   * `local` claim needs no corroboration — the CALIBRATION_ONLY verdict, not
   * this flag, is what stops a laptop run counting.
   */
  originCorroborated: boolean;
  /** Names each piece of missing evidence. Empty iff `originCorroborated`. */
  missing: string[];
}

/**
 * Evidence gathered by the DRIVER, about the endpoint it actually talked to.
 *
 * Everything in `OriginAttestation` is a claim inside a JSON body the driver
 * received; a report that lies about its origin would also lie here. This block
 * is the half the driver observed for itself — the URL scheme, the host shape,
 * and Cloudflare's own `cf-ray` response header, which a local `wrangler dev`
 * server does not emit and cannot forge into a real edge response.
 */
export interface DriverAttestation {
  mode: 'verdict' | 'calibration';
  /** `https:` or `http:`. Anything but https is refused in verdict mode. */
  endpointScheme: string;
  endpointHostShape: 'public' | 'loopback' | 'private' | 'unknown';
  /** Fingerprint, never the host: the workers.dev subdomain identifies the account. */
  endpointFingerprint: string;
  cfRayPresent: boolean;
  cfRayColo: string | null;
  /** The verdict as the container computed it, before any driver override. */
  containerVerdict: Verdict | null;
  /** Did the driver's own evidence corroborate a Cloudflare-served response? */
  endpointCorroborated: boolean;
  missing: string[];
  /** The `--local` calibration receipt this driver found, if any. */
  calibrationReceipt: CalibrationReceiptCheck | null;
}

export interface CalibrationReceiptCheck {
  found: boolean;
  /** The receipt was written against the same Neon host as this run. */
  matchesTarget: boolean;
  /** The WebSocket arm carried a full session during that calibration. */
  wsSessionSemantics: boolean;
}

export interface ProbeReport {
  probe: 'container-tcp';
  settles: 'Assumption 4 — a deployed Cloudflare Container can open unrestricted raw outbound TCP to Neon';
  /**
   * 3: per-transport `peerVerificationReason`, and the negative control's own
   * per-assertion results. Both exist because `peerVerified` stopped gating (b).
   */
  schemaVersion: 3;
  startedAt: string;
  totalMs: number;
  /**
   * SELF-DECLARED, and therefore not evidence. `attestation` is what says
   * whether this claim is corroborated; the verdict refuses to be conclusive
   * when it is not.
   */
  origin: 'container' | 'local';
  attestation: OriginAttestation;
  environment: Record<string, DetailValue>;
  target: {
    hostFingerprint: string;
    hostSuffix: string;
    port: number;
    isPoolerEndpoint: boolean;
  };
  stages: StageResult[];
  transports: {
    /** (a) — raw TCP on whatever port the DSN named. See `target.port`. */
    rawTcpPostgresPort: TransportSummary;
    /** (b) — the Postgres wire protocol tunnelled over a WebSocket on 443. */
    webSocket443: TransportSummary;
    /** The negative control. Neon's one-shot HTTP SQL endpoint on 443. */
    httpOneShot443: TransportSummary;
  };
  /** What the negative control established. See NegativeControlState. */
  negativeControl: NegativeControlState;
  /**
   * The negative control's own per-assertion results, so the claim "the battery
   * can register a negative" is checkable from the report rather than asserted.
   * Null only when the probe stopped before the control ran.
   */
  negativeControlAssertions: SessionAssertions | null;
  verdict: Verdict;
  /**
   * On a `--local` run, what the same evidence would have meant had it come
   * from a deployed container. Null on a container run, where `verdict` is
   * already that answer.
   */
  wouldBeVerdict: Verdict | null;
  verdictMeaning: VerdictMeaning;
  notes: string[];
  /** Filled in by the driver after the fetch. Always null inside the container. */
  driver: DriverAttestation | null;
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

/**
 * Needles shorter than this are not substituted: a one- or two-character
 * secret would match inside ordinary words and shred the report. They are
 * COUNTED instead — see `unmaskableSecretCount` — so the run can say out loud
 * that its redaction was incomplete rather than silently emitting a credential.
 */
const MIN_NEEDLE_LENGTH = 3;

export function unmaskableSecretCount(secrets: readonly string[]): number {
  return new Set(secrets.filter((s) => s.length > 0 && s.length < MIN_NEEDLE_LENGTH)).size;
}

export function makeRedactor(secrets: readonly string[], host: string): Redactor {
  const fingerprint = hostFingerprint(host);
  // Longest first, so a password that contains the user name is masked whole.
  const needles = [...new Set(secrets.filter((s) => s.length >= MIN_NEEDLE_LENGTH))].sort(
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
  /** A precondition refused the run (bad DSN, pooler endpoint, odd port, ...). */
  precondition: { ok: boolean };
  /**
   * The run's claim about where it happened is corroborated. False here is
   * fatal to every conclusive verdict: a measurement whose location is unknown
   * measures nothing about Cloudflare.
   */
  originCorroborated: boolean;
  rawTcpPostgresPort: TransportSummary;
  /**
   * A raw outbound TCP handshake to the Postgres port completed at least once
   * during this run — from the reachability probe OR from the transport's own
   * connect. (b) and (c) both assert that raw TCP did not work, and neither may
   * be asserted over a socket that demonstrably opened.
   */
  rawTcpPortConnectOk: boolean;
  webSocket443: TransportSummary;
  httpOneShot443: TransportSummary;
  negativeControl: NegativeControlState;
  /** Plain HTTPS GET against the Neon host. Proves generic internet from here. */
  genericHttpsEgress: boolean;
  /**
   * A raw TCP handshake to the Neon host on 443 (no protocol). Separates
   * "this container cannot open ANY raw socket" from "the Postgres port
   * specifically is filtered" — a distinction that changes what a fallback
   * could look like. Meaningless, and recorded as such, if the DSN's port IS
   * 443.
   */
  rawTcp443Reachable: boolean;
}

/**
 * The peer-verification outcomes that do NOT block a (b) verdict.
 *
 * (b) turns on session semantics — that is the property KTD2 needs and the
 * property Containers are kept for. Neon's WebSocket wire proxy cannot produce a
 * server signature at all, so requiring one there does not raise the bar; it
 * makes (b) unreachable against real Neon and converts a KEEP-Containers answer
 * into an inconclusive, which is nearly as expensive as converting it into (c).
 *
 * What is emphatically NOT on this list is `no_authentication_requested`. A far
 * end that challenges for nothing is the terminator shape the gate was built
 * for, and it stays fatal on every transport.
 */
const PEER_REASONS_COMPATIBLE_WITH_B: readonly PeerVerificationReason[] = [
  'scram_server_signature_verified',
  'cleartext_auth_no_server_signature',
];

export function decideVerdict(i: VerdictInputs): Verdict {
  if (!i.precondition.ok) return 'INCONCLUSIVE_PRECONDITION';

  // Nothing below means anything about Cloudflare if this did not run on
  // Cloudflare. This gate comes first for that reason.
  if (!i.originCorroborated) return 'INCONCLUSIVE_ORIGIN_UNVERIFIED';

  // The instrument failed its own null check: a channel with no session behind
  // it kept session semantics. No verdict computed from this battery is usable
  // in either direction.
  if (i.negativeControl === 'suspect') return 'INCONCLUSIVE_CONTROL_SUSPECT';

  // (a) is the only verdict that certifies raw pooled TCP, so it demands the
  // full session battery — plus a verified peer and a control that showed it
  // can fail. This gate is UNCHANGED and deliberately strictest: Neon's Postgres
  // does offer SCRAM-SHA-256 on the Postgres port, so a missing server signature
  // there is a real absence rather than an endpoint that cannot supply one.
  // Accepting a cleartext password on this transport would be a downgrade, and
  // `SCRAM_ONLY` in run.ts means the exchange never even gets that far.
  if (i.rawTcpPostgresPort.sessionSemantics) {
    if (!i.rawTcpPostgresPort.peerVerified) return 'INCONCLUSIVE_PEER_UNVERIFIED';
    if (i.negativeControl === 'absent') return 'INCONCLUSIVE_CONTROL_ABSENT';
    return 'A_RAW_TCP_OK';
  }

  // A raw socket to the Postgres port opened and no session came out of it.
  // Both (b) and (c) claim raw TCP did NOT work, so neither may be issued here
  // — not even when the WebSocket arm sailed through. This is the (a)->(b)
  // false negative that one lost packet would otherwise produce.
  if (i.rawTcpPortConnectOk) return 'INCONCLUSIVE_TCP_REACHABLE';

  // (b) rests on session semantics, which is exactly the property KTD2's
  // no-branch survives on. Peer identity is gated by REASON here rather than by
  // the bare `peerVerified` flag: the endpoint offers no mechanism that could
  // set it, so requiring it would forbid (b) against real Neon rather than
  // making the claim stronger. `no_authentication_requested` is still fatal.
  if (i.webSocket443.sessionSemantics) {
    if (!PEER_REASONS_COMPATIBLE_WITH_B.includes(i.webSocket443.peerVerificationReason)) {
      return 'INCONCLUSIVE_PEER_UNVERIFIED';
    }
    if (i.negativeControl === 'absent') return 'INCONCLUSIVE_CONTROL_ABSENT';
    return 'B_WEBSOCKET_ONLY';
  }

  // Below here both real transports failed. Before that can mean (c), the
  // probe has to rule out itself.

  // Nothing at all got out. This is a config/credential/network problem.
  const baselineEgress = i.genericHttpsEgress || i.httpOneShot443.authenticated;
  if (!baselineEgress) return 'INCONCLUSIVE_NO_BASELINE_EGRESS';

  // The wire proxy accepted a WebSocket upgrade, so 443 egress is not the
  // blocker and whatever failed afterwards is not the platform.
  if (i.webSocket443.channelOpen) return 'INCONCLUSIVE_WS_OPEN';

  return 'C_BOTH_BLOCKED';
}

export function summarizeNotes(i: VerdictInputs, verdict: Verdict, port: number): string[] {
  const notes: string[] = [];
  const portText = port > 0 ? String(port) : 'the Postgres port';

  if (verdict === 'C_BOTH_BLOCKED' && i.rawTcp443Reachable) {
    notes.push(
      `A raw TCP handshake to the same host on port 443 DID succeed while ${portText} did not. ` +
        'That is port filtering, not a blanket ban on outbound sockets — worth raising with ' +
        'Cloudflare before accepting the priced no-branch.',
    );
  }
  if (verdict === 'C_BOTH_BLOCKED' && !i.rawTcp443Reachable) {
    notes.push(
      `Raw TCP failed on both ${portText} and 443 while HTTPS succeeded, which reads as ` +
        '"no raw sockets from this runtime at all" rather than "one port is filtered".',
    );
  }
  if (verdict === 'INCONCLUSIVE_TCP_REACHABLE' && i.webSocket443.sessionSemantics) {
    notes.push(
      'The WebSocket arm DID carry a full Postgres session on this run, so the (b) fallback is ' +
        'proven and this is not the expensive branch. The re-run is only needed to settle (a) ' +
        `versus (b): a raw socket to ${portText} opened, so raw TCP cannot be reported as blocked.`,
    );
  }
  if (verdict === 'A_RAW_TCP_OK' && !i.webSocket443.sessionSemantics) {
    notes.push(
      'The WebSocket transport did not complete. That does not affect the verdict — (a) is ' +
        'decided by raw TCP — but it means the (b) fallback is unproven if raw TCP is ever ' +
        'withdrawn.',
    );
  }
  if (
    verdict === 'B_WEBSOCKET_ONLY' &&
    i.webSocket443.peerVerificationReason === 'cleartext_auth_no_server_signature'
  ) {
    notes.push(
      'WHAT (b) DOES NOT CLAIM: peer identity was not cryptographically verified at the Postgres ' +
        "layer on the WebSocket transport. Neon's wire proxy asked for a cleartext password " +
        '(authentication request 3) inside the already-TLS `wss` tunnel and offered no ' +
        'SASL/SCRAM, so there was no server signature to check — `peer_verification_reason` on ' +
        'that transport reads `cleartext_auth_no_server_signature`. This is Neon\'s documented ' +
        'design for the serverless endpoint, not a failure of this run, and it is why (b) is ' +
        'gated on session semantics rather than on a verified peer. Do not write (b) up as ' +
        'carrying the same assurance as (a).',
    );
    notes.push(
      'WHAT (b) DOES claim, and what carries it: the far end held a real Postgres session. The ' +
        'same battery that passed here — `SET LOCAL` nonce readback, one backend pid across an ' +
        'explicit transaction, the GUC scoped out after COMMIT, and a prepared statement ' +
        "surviving a round trip — was failed on the same run by Neon's one-shot HTTP endpoint, " +
        'which authenticates identically and holds no session. That contrast is the whole ' +
        'anti-terminator argument on this leg; if the control had not discriminated, this would ' +
        'have been an inconclusive instead. Beyond that, the peer is only as trusted as the ' +
        "runtime's TLS certificate validation of the `wss` endpoint — so never disable it.",
    );
  }
  if (i.negativeControl === 'absent') {
    notes.push(
      "The negative control did not run: Neon's one-shot HTTP endpoint never authenticated, so " +
        'the session battery was never shown to be capable of FAILING. Four assertions passing ' +
        'on an instrument with no demonstrated null result is not evidence, which is why a ' +
        'passing transport reports INCONCLUSIVE_CONTROL_ABSENT rather than (a) or (b). The ' +
        '`http.select_1` stage carries the reason.',
    );
  }
  if (i.negativeControl === 'suspect') {
    notes.push(
      "Neon's one-shot HTTP endpoint read back the `SET LOCAL` nonce or ran a prepared statement " +
        'created by an earlier round trip. It holds no session, so that should be impossible, and ' +
        'it casts doubt on the session battery itself — treat the whole run as suspect and re-run ' +
        'the laptop calibration. (Note that the control landing on the SAME BACKEND PID is not ' +
        'suspicious and is not what triggered this: Neon keeps warm backends, so consecutive ' +
        'one-shot requests can genuinely reach the same one.)',
    );
  }
  if (!i.originCorroborated) {
    notes.push(
      'This run could not be shown to have happened inside a deployed Cloudflare Container. ' +
        'The report names the missing evidence under `attestation.missing`. `wrangler dev` runs ' +
        'the identical image in local Docker, so an uncorroborated pass would be a measurement ' +
        "of the operator's laptop wearing the container's name.",
    );
  }
  return notes;
}
