/**
 * H2 — The vector index that quietly isn't there.
 *
 * Unported. See `docs/porting-hazards.md` for the full card: the indexable-vs-storable
 * dimension ceilings, and why a per-tenant provisioning step is the thing that has to
 * assert, not a one-off schema review.
 *
 * The skip below is the ledger entry the suite prints on every run. Delete it in
 * the same commit that lands the real guard, and move the card's status to
 * `guarded` — `registry-consistency.test.ts` fails if the two drift apart.
 */

import { test } from "bun:test";

test.skip(
  "H2 — a missing HNSW index does not break correctness: Postgres falls back to a sequential scan, which returns exact nearest neighbours, so recall goes UP and the accuracy evals pass harder than production ever will, right up until the first real brain turns every query into a full table scan and the symptom reads as we got slow rather than as a shipped defect. Guard, owned by U3's provisioning + migration layer: after initSchema, query pg_indexes per tenant and assert an hnsw index exists on the chunk embedding column — in provisioning itself, so a tenant without one fails loudly instead of serving slowly — and assert at migration-definition time that the declared embedding dimension stays inside the type's index ceiling (2000 for vector, 4000 for halfvec), so a future model swap is rejected by the suite rather than by production CREATE INDEX. Presence-checking the CREATE INDEX text in a schema file passes while the DDL fails on one tenant of a fleet and every test that could notice gets more accurate.",
  () => {
    throw new Error(
      "H2 is unported: this stub asserts nothing. Implement the per-tenant index assertion and the dimension-ceiling assertion in U3's provisioning + migration layer before removing .skip.",
    );
  },
);
