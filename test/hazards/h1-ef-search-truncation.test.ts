/**
 * H1 — Silent candidate-pool truncation via `hnsw.ef_search`.
 *
 * Unported. See `docs/porting-hazards.md` for the full card: the mechanism, what
 * masked it upstream, and the `SET LOCAL` transaction discipline the fix requires.
 *
 * The skip below is the ledger entry the suite prints on every run. Delete it in
 * the same commit that lands the real guard, and move the card's status to
 * `guarded` — `registry-consistency.test.ts` fails if the two drift apart.
 */

import { test } from "bun:test";

test.skip(
  "H1 — pgvector defaults hnsw.ef_search to 40 and an HNSW scan returns at most that many rows regardless of LIMIT, so the candidate pool silently truncates and RRF fusion, per-page collapse, rerank and autocut all rank a fraction of the pool they were designed for, with no error anywhere. Guard, owned by U3's vector helper: seed a fixture brain with more than 200 chunks that all match one query above threshold, ask the vector arm for a 250-candidate pool, and assert at least 200 candidates come back — plus assert the fixture size itself, since a guard seeded under 40 chunks passes forever and is worse than no guard. It has to exercise behaviour: a grep for ef_search near the query passes while a bare SET leaks to the next tenant or evaporates before the query runs on a pooled connection, which is the actual failure mode.",
  () => {
    throw new Error(
      "H1 is unported: this stub asserts nothing. Implement the behavioural guard in U3's vector helper before removing .skip.",
    );
  },
);
