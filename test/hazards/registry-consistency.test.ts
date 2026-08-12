/**
 * The ledger and the suite must not drift apart.
 *
 * `docs/porting-hazards.md` is the source of truth for which gbrain failure modes
 * brainz has inherited and not yet guarded. This directory is the registry: one
 * skipped test per unported hazard, its reason string carrying the mechanism, the
 * behavioural shape of the guard that will replace it, and the unit that owns it.
 *
 * A ledger row with no stub is a hazard nobody is counting. A stub with no ledger
 * row (or a row that has since moved to `guarded`) is a stale skip inflating the
 * count. This test asserts both directions, plus that the parser still understands
 * the file — a regex that silently matches nothing would make every assertion below
 * pass vacuously, which is the same class of quiet failure the ledger exists to
 * catch.
 */

import { test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HAZARDS_DIR = import.meta.dir;
const LEDGER_PATH = join(HAZARDS_DIR, "..", "..", "docs", "porting-hazards.md");
const SELF = "registry-consistency.test.ts";

/** Status values the ledger's card format declares legal. */
const LEGAL_STATUS = /^(guarded|unported|accepted\(.+\))$/;

type LedgerCard = { id: string; title: string; status: string };

/** Parse `## H<n> — <title>` cards and their `**Status:** \`<value>\`` lines. */
function parseLedger(markdown: string): LedgerCard[] {
  const cards: LedgerCard[] = [];
  let current: { id: string; title: string } | undefined;

  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(H\d+)\s+—\s+(.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      current = { id: heading[1], title: heading[2].trim() };
      continue;
    }
    const status = /^\*\*Status:\*\*\s*`([^`]+)`/.exec(line);
    if (status?.[1] && current) {
      cards.push({ id: current.id, title: current.title, status: status[1] });
      current = undefined;
    }
  }

  return cards;
}

/**
 * Collect the names of every `test.skip(...)` in this directory, read from source
 * rather than from a hand-maintained list — a registry that reports on itself
 * cannot fail red when the stub is missing.
 */
function collectSkippedTestNames(): string[] {
  const names: string[] = [];

  for (const entry of readdirSync(HAZARDS_DIR)) {
    if (!entry.endsWith(".test.ts") || entry === SELF) continue;
    const source = readFileSync(join(HAZARDS_DIR, entry), "utf8");
    const skips = source.matchAll(/test\.skip\(\s*(["'`])([\s\S]*?)\1/g);
    for (const skip of skips) {
      if (skip[2]) names.push(skip[2]);
    }
  }

  return names;
}

/** `H1` must not match a future `H10`, in either direction. */
function namesFor(id: string, names: string[]): string[] {
  const boundary = new RegExp(`^${id}\\b`);
  return names.filter((name) => boundary.test(name));
}

const ledger = parseLedger(readFileSync(LEDGER_PATH, "utf8"));
const skipped = collectSkippedTestNames();

/**
 * Bun reports `N skip` but not the names behind it, and the names are where the
 * reasons live. Echo the roster so every run prints both the standing count and
 * what each unguarded hazard will cost if it is forgotten.
 */
function printRoster(): void {
  const unguarded = ledger.filter((card) => card.status === "unported");
  const rule = "─".repeat(78);

  console.log(rule);
  if (unguarded.length === 0) {
    console.log(" 0 hazards unguarded — every card in docs/porting-hazards.md is `guarded` or");
    console.log(" `accepted(...)`. That number should never reach zero by accident: confirm the");
    console.log(" guards exist before believing it.");
  } else {
    console.log(` ${unguarded.length} hazards known and not yet guarded — docs/porting-hazards.md`);
    for (const card of unguarded) {
      console.log("");
      for (const name of namesFor(card.id, skipped)) console.log(` [skip] ${name}`);
    }
  }
  console.log(rule);
}

printRoster();

test("the hazard ledger still parses — no vacuous pass", () => {
  expect(ledger.length).toBeGreaterThan(0);
  for (const card of ledger) {
    expect(card.status).toMatch(LEGAL_STATUS);
  }
});

test("every `unported` hazard in docs/porting-hazards.md has a skipped test here", () => {
  const unguarded = ledger.filter((card) => card.status === "unported");
  const missing = unguarded.filter((card) => namesFor(card.id, skipped).length === 0);

  expect(missing.map((card) => `${card.id} — ${card.title}`)).toEqual([]);
});

test("every skipped hazard test here is still `unported` in the ledger", () => {
  const ids = new Set(ledger.filter((card) => card.status === "unported").map((card) => card.id));
  const stale = skipped.filter((name) => {
    const id = /^(H\d+)\b/.exec(name)?.[1];
    return id === undefined || !ids.has(id);
  });

  expect(stale).toEqual([]);
});
