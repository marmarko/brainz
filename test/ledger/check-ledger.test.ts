/**
 * Tests for the concepts-ledger checker (R7 / R20, U1 approach step 3).
 *
 * The ledger's whole purpose is that a capability can be *declined* but never
 * silently *forgotten*. So the interesting assertions here are the ones that
 * prove the checker goes red — a checker that has only ever been green has not
 * been shown to check anything.
 *
 * `checkLedger` takes `today` as an injected option rather than reading the
 * wall clock, so the "revisit date has passed" test is deterministic instead of
 * becoming true by the passage of time.
 */

import { describe, expect, test } from "bun:test";
import { checkLedger, formatReport } from "../../scripts/check-ledger.ts";

/** Fixed clock so date assertions never depend on when the suite runs. */
const TODAY = new Date("2026-08-12T00:00:00Z");

function check(lines: string[]) {
  return checkLedger(lines.join("\n"), { today: TODAY });
}

const COVERED =
  '{"id":"a.covered","capability":"RRF fusion across recall arms","criticality":"critical","status":"covered","unit":"U5"}';
const NOT_YET =
  '{"id":"a.not-yet","capability":"Cross-encoder rerank","criticality":"critical","status":"not-yet","priority":"p0","unit":"U5"}';
const OMITTED =
  '{"id":"a.omitted","capability":"Code indexing end-to-end","criticality":"optional","status":"omitted","reason":"No repository ingestion surface.","revisit_by":"2027-06-30"}';

describe("checkLedger — classification is mandatory", () => {
  test("fails on a row with no classification", () => {
    const report = check([
      COVERED,
      '{"id":"a.unclassified","capability":"Alias hop on the read path","criticality":"critical"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.line).toBe(2);
    expect(report.findings[0]?.id).toBe("a.unclassified");
    expect(report.findings[0]?.message).toMatch(/status/);
  });

  test("fails on a row whose status is not one of the three", () => {
    const report = check([
      '{"id":"a.bogus","capability":"Title-phrase boost","criticality":"critical","status":"maybe"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/covered/);
    expect(report.findings[0]?.message).toMatch(/not-yet/);
    expect(report.findings[0]?.message).toMatch(/omitted/);
  });

  test("passes when every row is classified", () => {
    const report = check([COVERED, NOT_YET, OMITTED]);

    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(3);
    expect(report.counts).toEqual({ covered: 1, "not-yet": 1, omitted: 1 });
  });

  test("tolerates blank lines and a trailing newline", () => {
    const report = check([COVERED, "", NOT_YET, ""]);

    expect(report.ok).toBe(true);
    expect(report.total).toBe(2);
  });
});

describe("checkLedger — revisit dates", () => {
  test("fails when a revisit_by date is in the past", () => {
    const report = check([
      COVERED,
      NOT_YET,
      '{"id":"a.stale","capability":"LLM multi-query expansion","criticality":"optional","status":"omitted","reason":"Read-path model spend.","revisit_by":"2026-03-01"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.line).toBe(3);
    expect(report.findings[0]?.id).toBe("a.stale");
    expect(report.findings[0]?.message).toMatch(/revisit_by/);
    expect(report.findings[0]?.message).toMatch(/2026-03-01/);
  });

  test("a revisit_by date of today has not passed yet", () => {
    const report = check([
      '{"id":"a.today","capability":"Three-mode search picker","criticality":"optional","status":"omitted","reason":"One right answer.","revisit_by":"2026-08-12"}',
    ]);

    expect(report.ok).toBe(true);
  });

  test("fails on a revisit_by that is not an ISO calendar date", () => {
    const report = check([
      '{"id":"a.baddate","capability":"Expert routing","criticality":"optional","status":"omitted","reason":"No input.","revisit_by":"June 2027"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/revisit_by/);
  });

  test("fails on a calendar-invalid revisit_by", () => {
    const report = check([
      '{"id":"a.feb30","capability":"Citation-rot repair","criticality":"optional","status":"omitted","reason":"Low consumer value.","revisit_by":"2027-02-30"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/revisit_by/);
  });
});

describe("checkLedger — per-status required fields", () => {
  test("an omitted row missing its reason fails", () => {
    const report = check([
      '{"id":"a.noreason","capability":"brain_score composite","criticality":"optional","status":"omitted","revisit_by":"2027-06-30"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.id).toBe("a.noreason");
    expect(report.findings[0]?.message).toMatch(/reason/);
  });

  test("an omitted row missing its revisit_by fails", () => {
    const report = check([
      '{"id":"a.norevisit","capability":"Multi-pack lenses","criticality":"optional","status":"omitted","reason":"Contradicts zero-setup."}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.id).toBe("a.norevisit");
    expect(report.findings[0]?.message).toMatch(/revisit_by/);
  });

  test("a covered row must name the unit that covers it", () => {
    const report = check([
      '{"id":"a.nounit","capability":"Token-budget packing","criticality":"critical","status":"covered"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/unit/);
  });

  test("a not-yet row must carry a priority", () => {
    const report = check([
      '{"id":"a.nopriority","capability":"Per-prefix recency decay","criticality":"critical","status":"not-yet"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/priority/);
  });

  test("a not-yet row with an unknown priority fails", () => {
    const report = check([
      '{"id":"a.badpriority","capability":"Source-type priors","criticality":"critical","status":"not-yet","priority":"urgent"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/priority/);
  });
});

describe("checkLedger — row shape", () => {
  test("fails on malformed JSON, naming the line", () => {
    const report = check([COVERED, "{not json at all", NOT_YET]);

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.line).toBe(2);
    expect(report.findings[0]?.message).toMatch(/JSON/i);
  });

  test("fails when a line is valid JSON but not an object", () => {
    const report = check(["[1,2,3]"]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.line).toBe(1);
  });

  test("fails on a duplicated id, naming both lines", () => {
    const report = check([NOT_YET, COVERED, NOT_YET]);

    expect(report.ok).toBe(false);
    const dupe = report.findings.find((f) => /duplicate/i.test(f.message));
    expect(dupe).toBeDefined();
    expect(dupe?.line).toBe(3);
    expect(dupe?.message).toMatch(/line 1/);
  });

  test("fails on a missing id and still reports the line", () => {
    const report = check([
      '{"capability":"Contextual retrieval wrapping","criticality":"critical","status":"not-yet","priority":"p1"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.line).toBe(1);
    expect(report.findings[0]?.message).toMatch(/id/);
  });

  test("fails on a missing capability description", () => {
    const report = check([
      '{"id":"a.nodesc","criticality":"critical","status":"not-yet","priority":"p1"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/capability/);
  });

  test("fails on an unknown criticality", () => {
    const report = check([
      '{"id":"a.badcrit","capability":"Read-time dedup","criticality":"blocker","status":"not-yet","priority":"p0"}',
    ]);

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/criticality/);
  });

  test("reports every violation, not just the first", () => {
    const report = check([
      '{"id":"a.one","capability":"One","criticality":"critical"}',
      '{"id":"a.two","capability":"Two","criticality":"critical"}',
    ]);

    expect(report.findings).toHaveLength(2);
    expect(report.findings.map((f) => f.line)).toEqual([1, 2]);
  });
});

describe("formatReport", () => {
  test("prints per-status counts on success", () => {
    const out = formatReport(check([COVERED, NOT_YET, OMITTED]));

    expect(out).toMatch(/covered/);
    expect(out).toMatch(/not-yet/);
    expect(out).toMatch(/omitted/);
    expect(out).toMatch(/3/);
  });

  test("prints the line number and id of each violation on failure", () => {
    const out = formatReport(
      check([
        COVERED,
        '{"id":"a.unclassified","capability":"Alias hop","criticality":"critical"}',
      ]),
    );

    expect(out).toMatch(/:2/);
    expect(out).toMatch(/a\.unclassified/);
  });
});

describe("the committed ledger", () => {
  test("upstream/concepts.jsonl is clean against today's clock", async () => {
    const url = new URL("../../upstream/concepts.jsonl", import.meta.url);
    const report = checkLedger(await Bun.file(url).text());

    expect(formatReport(report)).toMatch(/\d/);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("carries a row for every critical capability the audit names", async () => {
    const url = new URL("../../upstream/concepts.jsonl", import.meta.url);
    const report = checkLedger(await Bun.file(url).text());

    // The audit counts 38 critical capabilities. The ledger must not be a
    // token gesture — if this number ever collapses, R7's traceability claim
    // has quietly stopped being true.
    expect(report.counts.covered + report.counts["not-yet"] + report.counts.omitted).toBe(
      report.total,
    );
    expect(report.total).toBeGreaterThanOrEqual(38);
  });
});
