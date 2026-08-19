/**
 * The staleness fix point: an edge whose only support was just retired.
 *
 * **The seam.** Reconciliation reads the live fact set; staleness *changes* it;
 * and the plan's phase order puts reconciliation first. So the phase that moves
 * the inputs re-runs the phase that reads them — a fix point, inside
 * `runDeterministicPhase`'s `staleness` arm. An edge whose only supporting fact
 * has just been retired is Gap #18's cancelled meeting still in the briefing,
 * and the fix point is the only thing that takes it down.
 *
 * Both halves of the phase belong to one call, and that is the property under
 * test twice over:
 *
 *   **The whole cycle takes the edge down.** Staleness retires the claim and the
 *   fix point removes the edge it supported, inside one pass, so a cycle that
 *   reports itself complete has a graph that agrees with its facts.
 *
 *   **A phase does not bank a completion for work it triggered and did not
 *   finish.** `reconcileAllEdges` reports `done: false` when it yields to a lost
 *   lease, and dropping that on the floor would have staleness claim a
 *   completion over an edge set nothing reconciled.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConsolidationCycle, runDeterministicPhase } from '../../src/worker/consolidate/cycle.ts';
import { createAttemptBudget } from '../../src/worker/consolidate/deadline.ts';
import { reconcileAllEdges } from '../../src/worker/consolidate/deterministic.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createGateway,
  createTenantFixture,
  seedFact,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture('fixpoint');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/**
 * One upstream item, ingested twice, saying something different the second time.
 *
 * Both sentences are `relation_verb_sentence`s on the same subject and the same
 * topic (`employment`), which is exactly the extractor's own supersession key —
 * so the newer page's fact *replaces* the older one rather than contradicting
 * it, and each fact implies a `works_at` edge. That is the smallest shape in
 * which "an edge outlives the fact that was its only support" is expressible.
 */
async function seedSupersededPair(externalRef: string, subject: string): Promise<{
  readonly stalePageId: string;
  readonly livePageId: string;
}> {
  const { sql } = tenant;
  const older = await seedPage(sql, {
    origin: 'personal:mail',
    sourceType: 'email',
    title: `Where ${subject} works`,
    body: `${subject} joined Acme Corp.`,
    externalRef,
    createdAt: '2026-01-01T00:00:00Z',
  });
  await seedFact(sql, {
    statement: `${subject} joined Acme Corp.`,
    origins: ['personal:mail'],
    pageId: older.pageId,
    chunkIds: older.chunkIds,
    confidence: 0.8,
  });

  const newer = await seedPage(sql, {
    origin: 'personal:mail',
    sourceType: 'email',
    title: `Where ${subject} works`,
    body: `${subject} joined Globex Ltd.`,
    externalRef,
    createdAt: '2026-02-01T00:00:00Z',
  });
  await seedFact(sql, {
    statement: `${subject} joined Globex Ltd.`,
    origins: ['personal:mail'],
    pageId: newer.pageId,
    chunkIds: newer.chunkIds,
    confidence: 0.8,
  });

  return { stalePageId: older.pageId, livePageId: newer.pageId };
}

/** Every employer the live edge set still claims, by name. The whole assertion. */
async function liveEmployers(): Promise<string[]> {
  const rows = (await tenant.sql`
    SELECT object.canonical_name AS name
      FROM entity_edge edge
      JOIN entity object ON object.entity_id = edge.object_entity_id
     WHERE edge.deleted_at IS NULL AND edge.edge_type = 'works_at'
     ORDER BY object.canonical_name
  `) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('a phase does not bank a completion for work it triggered and did not finish', () => {
  test(
    'staleness reports a restart when the reconcile it fired could not run',
    async () => {
      await seedSupersededPair('mail:thread-1', 'Alice Chen');
      const now = new Date('2026-03-01T00:00:00Z');

      // The state a real cycle is in when it reaches staleness: reconciliation
      // has run over a fact set in which both claims are still live, so both
      // edges stand.
      const reconciled = await reconcileAllEdges(tenant.sql, { taxonomyVersion: 1 });
      expect(reconciled.done).toBe(true);
      expect(await liveEmployers()).toEqual(['Acme Corp', 'Globex Ltd']);

      // The lease goes away while the fix-point reconcile is walking the fact
      // set. That is the one interruption `reconcileAllEdges` takes — it cannot
      // bank a partial position, because a half-built desired set would make the
      // diff *delete* edges nothing had stopped stating — and it reports it as
      // `done: false`. Aborted before the call rather than during it: staleness
      // itself finishes its walk without consulting the clock (one superseded
      // page is a short batch), so the only thing the signal can interrupt is
      // the fix point, which is the seam under test.
      const dispossessed = new AbortController();
      dispossessed.abort();

      const outcome = await runDeterministicPhase(tenant.sql, 'staleness', {
        now,
        attempt: createAttemptBudget({ signal: dispossessed.signal }),
      });

      // **The claim.** The reconcile's restart used to be dropped on the floor
      // and the phase reported `done`, so the cycle banked staleness complete
      // over an edge set nothing had reconciled.
      expect(outcome.done).toBe(false);

      // And the two facts that make that a real defect rather than a bookkeeping
      // one: the claim really was retired, and the edge it supported really is
      // still live, so a phase banked complete here would be banking a lie.
      expect(await countRows(tenant.sql, 'fact', 'superseded_by IS NOT NULL')).toBe(1);
      expect(await liveEmployers()).toEqual(['Acme Corp', 'Globex Ltd']);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('a cycle that reports itself complete has a graph that agrees with its facts', () => {
  test(
    'staleness retires the claim and the fix point takes down the edge it supported',
    async () => {
      await seedSupersededPair('mail:thread-2', 'Bella Novak');
      const now = new Date('2026-03-01T00:00:00Z');

      // Free tier, so nothing is paid for and the deterministic tier is the
      // whole cycle. One pass, uninterrupted: `link_reconcile` runs over both
      // live claims, `staleness` retires the older one, and the fix point inside
      // that same phase reconciles what it just changed.
      const { gateway } = createGateway();
      const cycle = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'free', now },
      );
      expect(cycle.stopReason).toBe('free_tier');

      // **The claim.** Reconciliation ran *before* staleness, so on the phase
      // order alone the edge to the employer nothing states any more would still
      // be standing — over a cycle that reported itself finished, which is the
      // strongest form of the defect: not "not yet reconciled" but "reconciled,
      // and wrong".
      expect(await countRows(tenant.sql, 'fact', 'superseded_by IS NOT NULL')).toBe(1);
      expect(await liveEmployers()).toEqual(['Globex Ltd']);
    },
    SETUP_TIMEOUT_MS,
  );
});
