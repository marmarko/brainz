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

/** Confidence values a machine-written discovery may carry (U19). */
export const CONFIDENCES = ["low", "medium", "high"] as const;

/**
 * Top-level directories a backticked string has to start with before this file
 * will treat it as a claim about a file in this repo.
 *
 * Deliberately a fixed list. Without it, `websearch_to_tsquery`, a CLI flag, and
 * a Postgres type name are all "paths that do not exist" and the evidence rule
 * becomes noise a reviewer switches off.
 */
const REPO_ROOTS = ["src", "test", "tests", "scripts", "evals", "docs", "upstream", "deploy"];

/**
 * Repo paths a row's prose cites, with any `:symbol` suffix dropped.
 *
 * Exported because the rule built on it — *a `covered` row may not cite a file
 * nobody wrote* — is only as good as what it recognises, and that deserves its
 * own tests rather than being an implementation detail of the checker.
 */
export function citedRepoPaths(notes: string): string[] {
  const pattern = new RegExp(
    "`((?:" + REPO_ROOTS.join("|") + ")\\/[A-Za-z0-9_@./-]+?\\.[A-Za-z0-9]+)(?::[A-Za-z0-9_]+)?`",
    "g",
  );
  const found: string[] = [];
  for (const match of notes.matchAll(pattern)) {
    const path = match[1];
    if (path !== undefined && !found.includes(path)) found.push(path);
  }
  return found;
}

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
  /**
   * Injected filesystem, for the evidence rule. Defaults to a real check against
   * the working directory. Injected for the same reason the clock is: a rule
   * about what exists should be testable without the test depending on what
   * happens to be on disk.
   */
  pathExists?: (path: string) => boolean;
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
  const exists = opts.pathExists ?? ((path: string): boolean => Bun.file(path).size > 0);
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

    // -----------------------------------------------------------------------
    // U19: rows a machine discovered.
    //
    // The watcher writes `not-yet` and cannot write anything else — that is a
    // property of `src/upstream/classify.ts`, which has no code path to another
    // status. This is the half that does not depend on trusting that module: a
    // row carrying a discovery block and no human's `reviewed_by` is refused any
    // status but `not-yet`, whatever wrote it.
    //
    // And it expires. A discovery is not a violation on the day it lands — a
    // gate red on every PR trains people to ignore it, which is the reasoning
    // `upstream/memory-verbs-v1-partial.json` already applies to its own CI job.
    // It becomes one when its own `review_by` passes with nobody's name on it.
    // -----------------------------------------------------------------------
    const discovery = row["discovered_by"];
    let discovered = false;

    if (discovery !== undefined) {
      if (!isPlainObject(discovery)) {
        fail(id, '"discovered_by" must be an object naming the watcher, the run and the review deadline');
      } else {
        discovered = true;
        const reviewedBy = discovery["reviewed_by"];
        const reviewed = nonEmptyString(reviewedBy);

        if (!nonEmptyString(discovery["watcher"])) {
          fail(id, '"discovered_by.watcher" is missing — a machine-written row says which machine wrote it');
        }

        const confidence = discovery["confidence"];
        if (
          typeof confidence !== "string" ||
          !(CONFIDENCES as readonly string[]).includes(confidence)
        ) {
          fail(
            id,
            `"discovered_by.confidence" must be one of ${CONFIDENCES.join(", ")}, got ` +
              `${JSON.stringify(confidence)} — confidence orders a reviewer's queue and belongs in the row`,
          );
        }

        const evidence = discovery["evidence"];
        if (!Array.isArray(evidence) || evidence.length === 0) {
          fail(
            id,
            '"discovered_by.evidence" must be a non-empty list of the upstream paths that produced this row — ' +
              "a discovery nobody can check is not a discovery",
          );
        }

        if (!reviewed) {
          const reviewByRaw = discovery["review_by"];
          if (typeof reviewByRaw !== "string" || !isIsoDay(reviewByRaw)) {
            fail(
              id,
              '"discovered_by.review_by" must be an ISO calendar date (YYYY-MM-DD) — an undated discovery ' +
                "is a row that never becomes anybody's problem",
            );
          } else if (reviewByRaw < today) {
            fail(
              id,
              `"discovered_by.review_by" ${reviewByRaw} has passed (today is ${today}) and nobody has ` +
                'reviewed it. Classify the row and record who did it in "discovered_by.reviewed_by".',
            );
          }

          if (status !== "not-yet") {
            fail(
              id,
              `an unreviewed discovery may only be "not-yet", not ${JSON.stringify(status)}. ` +
                'A machine may say a capability exists upstream; only a human may say this repo covers it, ' +
                'or declines it. Add "discovered_by.reviewed_by" when you have looked.',
            );
          }
        }
      }
    }

    if (status === "covered") {
      if (!nonEmptyString(row["unit"])) {
        fail(id, 'status "covered" requires "unit" — name the implementation unit that covers it');
      }

      // The evidence rule, repo-wide rather than watcher-only. `covered` retires
      // a capability from every list an operator reads, so the one thing it must
      // never be is a claim about a module nobody wrote.
      const cited = citedRepoPaths(typeof row["notes"] === "string" ? row["notes"] : "");
      for (const path of cited) {
        if (!exists(path)) {
          fail(
            id,
            `status "covered" cites \`${path}\`, which does not exist. A capability is not covered by a ` +
              "file nobody wrote — either the path is stale or the coverage claim is.",
          );
        }
      }

      if (discovered && cited.length === 0) {
        fail(
          id,
          'a reviewed discovery flipped to "covered" must cite at least one path in this repo in its ' +
            '"notes". Saying "we have this" is the claim; the path is the evidence.',
        );
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
