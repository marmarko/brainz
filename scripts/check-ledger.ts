#!/usr/bin/env bun
/**
 * `bun run ledger:check` — the concepts-ledger gate (R7, R20; U1 approach step 3).
 *
 * `upstream/concepts.jsonl` is one JSON object per line, one line per capability
 * from `docs/research/2026-08-11-capability-parity.md`. Every row carries a
 * classification:
 *
 *   covered   — implemented, and `unit` names the implementation unit that did it
 *   not-yet   — planned, and `priority` says how urgently (p0 / p1 / p2)
 *   omitted   — declined, and `reason` says why plus `revisit_by` says when the
 *               decision gets re-taken
 *
 * The point of the gate is narrow and worth stating plainly: **a capability may
 * be declined, but it may never be silently forgotten.** So the check fails on an
 * unclassified row, on an `omitted` row with no reason or no revisit date, and on
 * a `revisit_by` that has already passed — a decision nobody re-took by its own
 * deadline is indistinguishable from a decision nobody remembers making.
 *
 * `covered` here means *implemented in this repo*, not *committed in the design*.
 * The parity audit's "Covered" column means the latter; conflating the two would
 * turn the ledger into a record of intentions.
 *
 * The clock is injected (`opts.today`) rather than read from `Date.now()` so the
 * date rule is testable without the test becoming true by the passage of time.
 */

export const LEDGER_STATUSES = ["covered", "not-yet", "omitted"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** Mirrors the audit's own three tiers: critical gaps, important gaps, deliberately out of scope. */
export const CRITICALITIES = ["critical", "important", "optional"] as const;

export const PRIORITIES = ["p0", "p1", "p2"] as const;

export const DEFAULT_LEDGER_PATH = "upstream/concepts.jsonl";

export interface LedgerFinding {
  /** 1-based line number in the JSONL file. */
  line: number;
  /** The row's id, or null when the row has none / could not be parsed. */
  id: string | null;
  message: string;
}

export interface LedgerReport {
  ok: boolean;
  /** Rows that parsed as objects. Blank lines are not rows. */
  total: number;
  counts: Record<LedgerStatus, number>;
  findings: LedgerFinding[];
}

export interface CheckOptions {
  /** Injected clock. Defaults to now. */
  today?: Date;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * True only for a syntactically well-formed AND calendar-real ISO day.
 * `2027-02-30` is well-formed and not real; both must be rejected, because a
 * revisit date that never arrives is the same failure as no revisit date.
 */
function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toIsoDay(parsed) === value;
}

export function checkLedger(content: string, opts: CheckOptions = {}): LedgerReport {
  const today = toIsoDay(opts.today ?? new Date());
  const findings: LedgerFinding[] = [];
  const counts: Record<LedgerStatus, number> = { covered: 0, "not-yet": 0, omitted: 0 };
  const seenIds = new Map<string, number>();
  let total = 0;

  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = (lines[index] ?? "").trim();
    if (raw.length === 0) continue;

    const fail = (id: string | null, message: string) => {
      findings.push({ line: lineNumber, id, message });
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(null, `malformed JSON: ${(error as Error).message}`);
      continue;
    }

    if (!isPlainObject(parsed)) {
      fail(null, "line is valid JSON but not a JSON object — one capability object per line");
      continue;
    }

    total += 1;

    const row = parsed;
    const id = nonEmptyString(row["id"]) ? row["id"] : null;

    if (id === null) {
      fail(null, 'missing "id" — every capability needs a stable id to be referred to by');
    } else {
      const firstSeen = seenIds.get(id);
      if (firstSeen !== undefined) {
        fail(id, `duplicate id ${JSON.stringify(id)} — first seen on line ${firstSeen}`);
      } else {
        seenIds.set(id, lineNumber);
      }
    }

    if (!nonEmptyString(row["capability"])) {
      fail(id, 'missing "capability" — say in prose what the capability is');
    }

    const criticality = row["criticality"];
    if (criticality === undefined) {
      fail(id, `missing "criticality" — one of ${CRITICALITIES.join(", ")}`);
    } else if (
      typeof criticality !== "string" ||
      !(CRITICALITIES as readonly string[]).includes(criticality)
    ) {
      fail(
        id,
        `unknown criticality ${JSON.stringify(criticality)} — must be one of ${CRITICALITIES.join(", ")}`,
      );
    }

    const status = row["status"];
    if (status === undefined || status === null || status === "") {
      fail(
        id,
        `missing "status" — classify it as ${LEDGER_STATUSES.join(" / ")}. ` +
          "A capability may be declined, but never left unclassified.",
      );
      continue;
    }

    if (typeof status !== "string" || !(LEDGER_STATUSES as readonly string[]).includes(status)) {
      fail(
        id,
        `unknown status ${JSON.stringify(status)} — must be one of ${LEDGER_STATUSES.join(", ")}`,
      );
      continue;
    }

    counts[status as LedgerStatus] += 1;

    if (status === "covered") {
      if (!nonEmptyString(row["unit"])) {
        fail(id, 'status "covered" requires "unit" — name the implementation unit that covers it');
      }
      continue;
    }

    if (status === "not-yet") {
      const priority = row["priority"];
      if (priority === undefined) {
        fail(id, `status "not-yet" requires "priority" — one of ${PRIORITIES.join(", ")}`);
      } else if (
        typeof priority !== "string" ||
        !(PRIORITIES as readonly string[]).includes(priority)
      ) {
        fail(
          id,
          `unknown priority ${JSON.stringify(priority)} — must be one of ${PRIORITIES.join(", ")}`,
        );
      }
      continue;
    }

    // status === "omitted"
    if (!nonEmptyString(row["reason"])) {
      fail(id, 'status "omitted" requires "reason" — say why this capability is declined');
    }

    const revisitBy = row["revisit_by"];
    if (revisitBy === undefined) {
      fail(
        id,
        'status "omitted" requires "revisit_by" — an ISO date (YYYY-MM-DD) when the decision gets re-taken',
      );
    } else if (typeof revisitBy !== "string" || !isIsoDay(revisitBy)) {
      fail(
        id,
        `"revisit_by" must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(revisitBy)}`,
      );
    } else if (revisitBy < today) {
      fail(
        id,
        `"revisit_by" ${revisitBy} has passed (today is ${today}) — re-take the decision and move the date, or flip the row`,
      );
    }
  }

  return { ok: findings.length === 0, total, counts, findings };
}

export function formatReport(report: LedgerReport, path: string = DEFAULT_LEDGER_PATH): string {
  if (report.ok) {
    return (
      `${path}: ${report.total} capabilities — ` +
      `${report.counts.covered} covered, ` +
      `${report.counts["not-yet"]} not-yet, ` +
      `${report.counts.omitted} omitted`
    );
  }

  const lines = report.findings.map((finding) => {
    const id = finding.id === null ? "<no id>" : finding.id;
    return `  ${path}:${finding.line}  [${id}]  ${finding.message}`;
  });

  return [
    `${path}: ${report.findings.length} problem${report.findings.length === 1 ? "" : "s"} ` +
      `across ${report.total} capabilit${report.total === 1 ? "y" : "ies"}`,
    "",
    ...lines,
    "",
    "  Every capability from the parity audit must be covered, not-yet, or omitted.",
    "  An omitted capability keeps a reason and a revisit date, so it stays declined",
    "  on purpose rather than forgotten by default.",
  ].join("\n");
}

if (import.meta.main) {
  const argPath = process.argv[2];
  const path =
    argPath ?? Bun.fileURLToPath(new URL(`../${DEFAULT_LEDGER_PATH}`, import.meta.url));
  const display = argPath ?? DEFAULT_LEDGER_PATH;

  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`${display}: not found — the concepts ledger is required (R7).`);
    process.exit(2);
  }

  const report = checkLedger(await file.text());
  const output = formatReport(report, display);

  if (report.ok) {
    console.log(output);
    process.exit(0);
  }

  console.error(output);
  process.exit(1);
}
