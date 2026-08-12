/**
 * H3 — Post-filter recall collapse (H1 one layer down).
 *
 * Unported. See `docs/porting-hazards.md` for the full card: why every production
 * read carries at least one predicate, and why both GUCs belong in the one vector
 * helper rather than at a call site.
 *
 * The skip below is the ledger entry the suite prints on every run. Delete it in
 * the same commit that lands the real guard, and move the card's status to
 * `guarded` — `registry-consistency.test.ts` fails if the two drift apart.
 */

import { test } from "bun:test";

test.skip(
  "H3 — pgvector applies WHERE predicates AFTER the HNSW scan, so hnsw.ef_search sizes the scan and not the qualifying yield; every brainz read carries an origin fence, a soft-delete exclusion and a junk-quarantine filter, which is the ordinary steady state rather than an edge case, so the vector arm starves even after H1's fix raises the GUC. Guard, owned by U3's vector helper: re-run H1's fixture with those production-shaped predicates present — more than 200 matching chunks plus origin-fenced, tombstoned and quarantined rows that must be excluded, a 250-candidate pool requested — and still assert at least 200 QUALIFYING rows come back. H1's guard cannot see this: specified unfiltered, it passes at any ef_search above the pool size and keeps passing forever while production, which never issues an unfiltered vector query, degrades exactly as H1 described. The remedy is SET LOCAL hnsw.iterative_scan (pgvector 0.8+) alongside ef_search in the same transaction, so the scan resumes instead of truncating at the first batch.",
  () => {
    throw new Error(
      "H3 is unported: this stub asserts nothing. Implement the filtered-fixture guard in U3's vector helper before removing .skip.",
    );
  },
);
