# `test/hazards/` — the unguarded-hazard count

`docs/porting-hazards.md` is the ledger. This directory is the part of it that runs.

A card that has been closed keeps its file here, as the guard that closed it —
`h1-…`, `h2-…` and `h3-…` are behavioural tests against a real Postgres with
pgvector, reached through `DATABASE_URL` (defaulting to the CI service
container's form) and sharing the corpus in `fixture.ts`. They are **not** gated
behind a flag: CI always has the service container, and a hazard guard that
skips itself is the unguarded state wearing a green tick.

Every hazard whose card says **Status:** `unported` ships here as a **skipped test
whose name is its reason**, so `bun test` prints both the count of hazards that are
known and not yet guarded and what each one costs if it is forgotten. That number
should go down as guards land, and it should never reach zero by accident —
`registry-consistency.test.ts` is what makes "by accident" fail the build.

## Adding H4 (the convention)

1. **Write the card first** in `docs/porting-hazards.md`: `## H4 — <title>`, then a
   `**Status:** \`unported\`` line. The ledger leads; the test follows.
2. **Add `h4-<short-slug>.test.ts` here** with exactly one `test.skip`, whose name
   starts with `H4 ` — the id, a space, then the reason. The prefix is load-bearing:
   `registry-consistency.test.ts` discovers stubs by scanning this directory's
   `*.test.ts` sources for `test.skip(` names, and matches ids on a word boundary so
   `H4` never collides with a later `H40`.
3. **Say three things in that name**, on one line (newlines wreck the output):
   - what the hazard is;
   - what the real guard will have to *do* — the behavioural shape. Every card in
     this ledger shares the property that a grep-style or presence-style check
     passes while the bug is live, so name the behaviour the guard exercises and why
     the cheap check would miss it;
   - which unit owns closing it.
4. **Make the body throw.** A stub whose body is empty turns green the moment
   someone deletes `.skip`, which is the failure mode this directory exists to
   prevent. Throwing means an un-skipped stub fails until it is actually implemented.

## When a guard lands

Delete the stub and move the card's status to `guarded` **in the same commit**. The
consistency test asserts both directions — an unported card with no stub fails, and
a stub whose card is no longer unported fails — so a stale skip cannot sit here
inflating the count, and a hazard cannot quietly drop out of the ledger.

## Why the reasons are echoed to stdout

Bun reports `N skip` but not the names behind it, and the names are where the reasons
live. `registry-consistency.test.ts` prints the roster it discovered by scanning, so
the printed list is derived from the same source as the assertions and cannot drift
from what is actually skipped.
