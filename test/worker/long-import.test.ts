/**
 * A first import that outlives one attempt: it banks, and the next wake resumes
 * it.
 *
 * ============================================================================
 * WHAT WAS WRONG, MEASURED RATHER THAN GUESSED
 * ============================================================================
 *
 * `DEFAULT_MAX_ATTEMPT_MS` was fifteen minutes. `WorkerFleet.sleepAfter` is five
 * (`src/mcp/router.ts`), and `@cloudflare/containers` renews that window only
 * from requests through the Durable Object — `renewActivityTimeout` is reached
 * from the request path, and `isActivityExpired` stops the container when the
 * window lapses with nothing in flight. The only caller is `wakeWorkerFleet`,
 * which dials `/health` once per thirty-minute cron. So the process is
 * guaranteed roughly five minutes of life per wake, and the attempt ceiling
 * promised three times that.
 *
 * The consequence is not a slow import, it is an import that cannot finish. A
 * long pull is killed by the platform mid-attempt; the row stays `running` with
 * nobody alive to reclaim it; the next wake half an hour later reads
 * `attempt_deadline_at <= now`, calls it `attempt_timed_out`, charges the
 * attempt and pushes `run_at` out by the connector ladder — fifteen minutes,
 * then thirty, then hours. Twelve rungs later the lane dead-letters having
 * imported a few hundred of 247,000 messages.
 *
 * ============================================================================
 * WHY THIS FILE AND NOT A SHORTENED-DEADLINE TEST
 * ============================================================================
 *
 * A test that shrinks the deadline until a handler overruns proves the reaper
 * fires. That was never in doubt — the fleet had the receipts. What had no test
 * is the property the fix is actually for: **a pull too long for one attempt
 * banks what it did, returns without failing, and the next wake carries it to
 * completion — nothing re-paid, no page written twice.**
 *
 * So every case here drives the real runner against a real control plane and a
 * real brain, over as many wakes as convergence takes, and asserts the effect in
 * the databases rather than a return value.
 *
 * **The clock is virtual and it is spent where the money is.** `clockMs` only
 * moves when the embedding transport is invoked, which is what a written item
 * costs and what an `unchanged` one does not (`write-path.ts` takes the digest
 * shortcut before `embed_facts`). That asymmetry is the whole reason a held
 * cursor converges instead of replaying forever: the slice that re-lists a page
 * it half-imported walks its own prefix for free and spends its budget on the
 * items nobody has reached yet. Modelling the cost anywhere else — per loop
 * iteration, per listed item — would erase the asymmetry and prove convergence
 * of a system that does not have it.
 *
 * **Each wake is a fresh process**, because that is what the deployment does: a
 * container that slept is started again by the next cron. `processStartedAtMs`
 * moves with it, which is what gives every wake its own budget.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../src/ai/keys.ts';
import {
  createInMemorySpendMeter,
  createModelGateway,
  type ModelTransport,
  type TransportRequest,
} from '../../src/ai/gateway.ts';
import { HOSTED_PROFILE } from '../../src/ai/routing.ts';
import {
  createControlPlaneConnectorHealth,
  ensureConnectorHealthSchema,
} from '../../src/control/connector-health.ts';
import { fleetIdentity } from '../../src/control/secrets.ts';
import {
  SOURCE_TYPE_FOR,
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorState,
  type ConnectorStateStore,
} from '../../src/ingest/cursor.ts';
import type { TenantRuntime } from '../../src/ingest/import/run.ts';
import { createIngestPullHandler, enqueuePullIfDue } from '../../src/ingest/pipedream/pull.ts';
import type {
  ProviderListOutcome,
  ProviderListRequest,
  ProviderSource,
  PulledItem,
} from '../../src/ingest/pipedream/sources/types.ts';
import {
  ATTEMPT_BANK_RESERVE_MS,
  DEFAULT_STEAL_GRACE_MS,
  FLEET_WAKE_WINDOW_MS,
  attemptYieldAtMs,
} from '../../src/worker/locks.ts';
import { ACTIVE_EMBEDDING_SEAT, seatColumnSql } from '../../src/schema/embedding-seat.ts';
import { createJobQueue, createLeaseChannel } from '../../src/worker/queue.ts';
import { createJobRunner } from '../../src/worker/runner.ts';
import { createEmbeddingTransport } from '../core/write/fixture.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from './fixture.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

const TENANT = 'longimport-alice';
const ACCOUNT_KEY = 'owner@example.test';
const BASE = new Date('2026-08-17T09:00:00.000Z');

/** One provider page. Small enough to run here, larger than one slice's budget. */
const PAGE_ITEMS = 6;
/** Two pages, so the second one proves the cursor moved rather than reset. */
const MAILBOX_ITEMS = 12;

/**
 * What one embedding call costs the virtual clock.
 *
 * Chosen so a slice's budget covers four calls and not six: the item loop must
 * run out of time inside a page, which is the case that had no coverage. Written
 * as a division of the budget rather than a bare number so the two move together.
 */
const EMBED_COST_MS = Math.floor((FLEET_WAKE_WINDOW_MS - ATTEMPT_BANK_RESERVE_MS) / 4.8);

/**
 * A page the item loop finishes with nothing left of the window.
 *
 * Sized so the loop runs out of items on the same call that runs out of clock, so it never takes its own
 * break and the only thing standing between the slice and the platform's kill is
 * the check at the embedding pass. Derived from {@link EMBED_COST_MS} so the two
 * cannot drift into a case that proves nothing.
 */
const EXACT_FIT_ITEMS = Math.ceil((FLEET_WAKE_WINDOW_MS - ATTEMPT_BANK_RESERVE_MS) / EMBED_COST_MS);

let control: ControlFixture;
let controlSql: SQL;
let leaseSql: SQL;
let brain: SchemaFixture;
let brainSql: SQL;

/** The virtual clock. Advanced only by the embedding transport. */
let clockMs = BASE.getTime();
/**
 * How far the *handler's* clock sits from the *queue's*.
 *
 * Zero everywhere but one case. Production runs both on wall clock and they
 * agree; a fleet whose control plane and worker disagree about the hour does
 * not, and neither does any test driving the queue from an injected instant.
 */
let clockSkewMs = 0;
const clock = (): number => clockMs + clockSkewMs;
const nowDate = (): Date => new Date(clockMs);

/** Every text the fleet paid to embed, across every wake. */
let embedded: string[] = [];

function meteredTransport(): ModelTransport {
  const base = createEmbeddingTransport();
  return {
    id: base.id,
    invoke(request: TransportRequest) {
      if (request.input.kind === 'embedding') {
        clockMs += EMBED_COST_MS;
        embedded.push(...request.input.texts);
      }
      return base.invoke(request);
    },
  };
}

function tenantRuntime(): TenantRuntime {
  return {
    sql: brainSql,
    gateway: createModelGateway({
      profile: HOSTED_PROFILE,
      transport: meteredTransport(),
      meter: createInMemorySpendMeter(),
      keys: {
        store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
        hosted: createHostedKeyPool({
          openai: 'hosted-openai',
          google: 'hosted-google',
          cloudflare: 'hosted-cloudflare',
          'self-host': 'hosted-self-host',
        }),
      },
    }),
    tenantId: TENANT,
    caller: fleetIdentity(TENANT),
  };
}

beforeAll(async () => {
  control = await createControlPlane('longimport');
  controlSql = connectControl(control, 4);
  leaseSql = connectControl(control, 2);
  await ensureConnectorHealthSchema(controlSql);
  brain = await provisionFixture('longimport_brain');
  brainSql = connectTenant(brain);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await brainSql?.close();
  await controlSql?.close();
  await leaseSql?.close();
  if (brain !== undefined) await dropFixtureDatabase(brain);
  if (control !== undefined) await dropControlPlane(control);
});

async function resetBrain(): Promise<void> {
  await brainSql`DELETE FROM fact_source`;
  await brainSql`DELETE FROM entity_edge`;
  await brainSql`UPDATE fact SET superseded_by = NULL`;
  await brainSql`DELETE FROM fact`;
  await brainSql`DELETE FROM entity_alias`;
  await brainSql`DELETE FROM entity`;
  await brainSql`DELETE FROM chunk`;
  await brainSql`DELETE FROM attachment`;
  await brainSql`UPDATE page SET ingest_id = NULL`;
  await brainSql`DELETE FROM page`;
  await brainSql`DELETE FROM ingest_log`;
}

beforeEach(async () => {
  clockMs = BASE.getTime();
  clockSkewMs = 0;
  embedded = [];
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.connector_health`;
  await controlSql`DELETE FROM control.tenant`;
  await resetBrain();
  await seedTenant(controlSql, TENANT);
  await controlSql`
    UPDATE control.tenant SET spend_cap_micro_usd = 500000000, spend_micro_usd = 0
     WHERE tenant_id = ${TENANT}`;
});

// ---------------------------------------------------------------------------
// The mailbox the provider offers, paged, and answering the cursor it is handed.
// ---------------------------------------------------------------------------

/**
 * A scripted mailbox is not enough here.
 *
 * The property under test is that a **held** cursor is re-offered and a
 * **banked** one is not, so the fake has to answer the cursor it is given rather
 * than walk a positional script. A script would answer page two to a slice that
 * asked for page one again, and the test would report convergence the runner has
 * not got.
 */
const CAUGHT_UP = 'caught-up';

/**
 * Prose the deterministic extractor recognises, distinct per message.
 *
 * It has to state facts, because facts are what an item pays an embedding call
 * for and the embedding call is what spends this file's clock. Distinct subjects
 * per message so nothing supersedes anything and every item is genuinely new
 * work — and spelled out, because the extractor reads names: a digit in a
 * subject sinks the rule and the message is written for free, which would make
 * this suite green against a runner with no budget at all.
 */
const NAMES = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliett',
  'Kilo',
  'Lima',
] as const;

/**
 * Long enough that the gate's estimate is the binding number rather than
 * integer rounding.
 *
 * The spend budget has its own coverage (`budget_exhausted` is an older stop
 * reason with an older test). What this file must not do is let it fire first:
 * a two-sentence message prices at four micro-dollars, where a single
 * reservation rounds to one, and the run stops on money before it has spent a
 * second of clock — proving nothing about the wall.
 */
function messageBody(index: number): string {
  const name = NAMES[index % NAMES.length] as string;
  const filler: string[] = [];
  for (let part = 0; part < 6; part += 1) {
    filler.push(
      `Note ${name} ${part}: the review covered hiring, runway and the pricing ` +
        `change, the follow-up landed with the owner of record, and the runbook ` +
        `for that step stayed where the team filed it last quarter with the ` +
        `numbers attached and the open questions listed underneath.`,
    );
  }
  return (
    `Widget ${name} invested in Acme ${name}. ` +
    `Acme ${name} is based in Springfield ${name}.\n\n` +
    filler.join('\n\n')
  );
}

function messageAt(index: number): PulledItem {
  return {
    externalRef: `gmail:${ACCOUNT_KEY}:m${index}`,
    title: `the rollout, note ${index}`,
    body: messageBody(index),
    occurredAt: new Date(BASE.getTime() - index * 3_600_000),
  };
}

interface MailboxSource extends ProviderSource {
  readonly listedCursors: readonly (string | null)[];
}

function mailboxSource(shape: { pageItems: number; total: number }): MailboxSource {
  const listedCursors: (string | null)[] = [];
  return {
    source: 'gmail',
    sourceType: SOURCE_TYPE_FOR.gmail,
    get listedCursors() {
      return listedCursors;
    },
    list(request: ProviderListRequest): Promise<ProviderListOutcome> {
      listedCursors.push(request.cursor);
      if (request.cursor === CAUGHT_UP) {
        return Promise.resolve({
          ok: true,
          page: {
            items: [],
            tombstones: [],
            failures: [],
            nextCursor: { kind: 'delta', value: CAUGHT_UP },
            outsideWindow: null,
            accountKey: ACCOUNT_KEY,
          },
        });
      }
      const offset = request.cursor === null ? 0 : Number.parseInt(request.cursor, 10);
      const items: PulledItem[] = [];
      for (let index = offset; index < Math.min(offset + shape.pageItems, shape.total); index += 1) {
        items.push(messageAt(index));
      }
      const next = offset + items.length;
      return Promise.resolve({
        ok: true,
        page: {
          items,
          tombstones: [],
          failures: [],
          // A `backfill` kind is what a first import that stopped part-way
          // carries, and a `delta` kind is what "caught up" means. Both spellings
          // matter: the first re-gates the next slice, the second does not.
          nextCursor:
            next >= shape.total
              ? { kind: 'delta', value: CAUGHT_UP }
              : { kind: 'backfill', value: String(next) },
          outsideWindow: shape.total,
          accountKey: ACCOUNT_KEY,
        },
      });
    },
  };
}

function connected(): ConnectorState {
  return connectSource({
    source: 'gmail',
    externalUserId: `${TENANT}-gmail`,
    accountId: 'apn_fixture',
    accountKey: ACCOUNT_KEY,
    now: new Date(BASE.getTime() - 86_400_000),
  });
}

interface WakeResult {
  readonly claimed: number;
  readonly reclaimed: number;
  readonly pages: number;
}

/**
 * One cron wake: reclaim what died, enqueue what is due, drain the queue.
 *
 * The same order `src/worker/serve.ts` ticks in, and the reclaim is not
 * decoration — it is the assertion. A lane whose work is progressing must never
 * appear in what a sweep takes.
 */
async function wake(
  states: ConnectorStateStore,
  source: MailboxSource,
  runtime: TenantRuntime,
  /**
   * How long ago this process woke. Zero — a fresh container — unless a case is
   * deliberately building the claim that lands with the window already spent.
   */
  wokeMsAgo = 0,
): Promise<WakeResult> {
  const queue = createJobQueue({ sql: controlSql });
  const now = nowDate();
  const processStartedAtMs = clock() - wokeMsAgo;

  const reclaimed = await queue.reclaim({ now, stealGraceMs: DEFAULT_STEAL_GRACE_MS });

  const state = await states.read('gmail');
  if (state !== null) await enqueuePullIfDue(queue, { tenantId: TENANT, state, now });

  const runner = createJobRunner({
    queue,
    leases: createLeaseChannel({ sql: leaseSql }),
    handlers: {
      ingest_pull: createIngestPullHandler({
        control: controlSql,
        profile: HOSTED_PROFILE,
        health: createControlPlaneConnectorHealth(controlSql, (error) => {
          throw error;
        }),
        openTenant: () => Promise.resolve(runtime),
        openSource: () => Promise.resolve({ source, states }),
        clock,
        processStartedAtMs,
      }),
    },
    owner: 'long-import-test',
    concurrency: 1,
  });

  const pass = await runner.runOnce({ now });
  const rows = (await brainSql`
    SELECT count(*)::int AS pages FROM page WHERE deleted_at IS NULL`) as Array<{ pages: number }>;
  return { claimed: pass.claimed, reclaimed: reclaimed.length, pages: rows[0]?.pages ?? 0 };
}

/** Every job row's settled shape, so a failure code cannot hide behind a count. */
async function jobRows(): Promise<Array<{ state: string; attempts: number; failure: string | null }>> {
  return (await controlSql`
    SELECT state::text AS state, attempts, failure_code::text AS failure
      FROM control.job ORDER BY created_at`) as Array<{
    state: string;
    attempts: number;
    failure: string | null;
  }>;
}

describe('a first import longer than one attempt', () => {
  test(
    'banks what it did, is never reclaimed, and finishes across wakes',
    async () => {
      const states = createInMemoryConnectorStore([connected()]);
      const source = mailboxSource({ pageItems: PAGE_ITEMS, total: MAILBOX_ITEMS });
      const runtime = tenantRuntime();

      // --- Wake one. The slice runs out of budget inside the first page. ------
      const first = await wake(states, source, runtime);
      expect(first.claimed).toBe(1);
      expect(first.reclaimed).toBe(0);
      // The red line. Before the wall-clock budget this was `PAGE_ITEMS`: the
      // attempt drained the page, and the platform — not this assertion — was
      // what stopped the next one.
      expect(first.pages).toBeGreaterThan(0);
      expect(first.pages).toBeLessThan(PAGE_ITEMS);

      // It stopped, and it said so. `stopped` + `cancelled` is the pair whose
      // panel copy is "it picks up where it left off", which is now true.
      const stopped = (await controlSql`
        SELECT run_outcome::text AS outcome, ingest_failure_code::text AS code
          FROM control.connector_health WHERE tenant_id = ${TENANT}`) as Array<{
        outcome: string;
        code: string | null;
      }>;
      expect(stopped[0]).toEqual({ outcome: 'stopped', code: 'cancelled' });

      // And the job it stopped inside completed: no failure code, no ladder.
      expect(await jobRows()).toEqual([{ state: 'done', attempts: 1, failure: null }]);

      // --- The rest of the wakes, until the mailbox is drained. --------------
      let wakes = 1;
      let pages = first.pages;
      while (pages < MAILBOX_ITEMS && wakes < 12) {
        // One cron period. The connector's own cadence is shorter, so what
        // paces the import is the wake, exactly as it is in the deployment.
        clockMs += 30 * 60_000;
        const result = await wake(states, source, runtime);
        wakes += 1;
        pages = result.pages;
        // The assertion this whole change exists for: a lane that is making
        // progress is never taken from under it.
        expect(result.reclaimed).toBe(0);
        for (const row of await jobRows()) expect(row.failure).toBeNull();
      }

      expect(pages).toBe(MAILBOX_ITEMS);
      // More than one wake, or the import did not actually span attempts and
      // this file proves nothing.
      expect(wakes).toBeGreaterThan(1);

      // **Attempts never accumulate across slices**, which is what keeps a long
      // import off the connector ladder entirely. Each slice is a fresh row —
      // the partial unique index covers `due` and `running`, so a `done` job
      // does not hold the lane — claimed exactly once and completed.
      const settledJobs = await jobRows();
      expect(settledJobs.length).toBe(wakes);
      for (const row of settledJobs) expect(row).toMatchObject({ state: 'done', attempts: 1 });

      // Every message once. A cursor advanced over unfinished work loses items;
      // a cursor reset re-writes them.
      const refs = (await brainSql`
        SELECT external_ref FROM page WHERE deleted_at IS NULL ORDER BY external_ref`) as Array<{
        external_ref: string;
      }>;
      expect(new Set(refs.map((row) => row.external_ref)).size).toBe(MAILBOX_ITEMS);

      // Nothing re-paid. A replayed page is walked for free, so no text is ever
      // handed to the embedding transport twice across the whole import.
      expect(new Set(embedded).size).toBe(embedded.length);

      // The held cursor was re-offered rather than stepped over: the first page
      // — the one a slice ran out of clock inside — was listed twice, and the
      // second listing is where the items nobody had reached came from.
      expect(source.listedCursors.filter((cursor) => cursor === null).length).toBe(2);

      // And the import ended in delta mode. A banked slice that left the state
      // on a `backfill` cursor would re-gate and re-list a mailbox it has
      // finished, on every cadence, forever.
      const settled = await states.read('gmail');
      expect(settled?.cursor).toMatchObject({ kind: 'delta', value: CAUGHT_UP });
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The second boundary, and the one a page-sized budget check does not cover.
 *
 * `runChunkEmbedBacklog` is unbounded in wall clock: it drains every chunk with
 * no vector, which after a page of mail is most of them. A slice that spent its
 * window on the items and then walked into it would be killed inside it — and a
 * kill is what costs an attempt and pushes the lane up the connector ladder.
 *
 * The page here is sized so the item loop never takes its own break: it runs out
 * of items on the same call that runs out of clock. If the check before the
 * embedding pass is removed, this slice finishes, banks its cursor and leaves no
 * chunk unembedded — and every assertion below flips.
 */
describe('a slice that spends its window on the items', () => {
  async function pendingChunks(): Promise<number> {
    const rows = (await brainSql.unsafe(`
      SELECT count(*)::int AS pending FROM chunk
       WHERE ${seatColumnSql(ACTIVE_EMBEDDING_SEAT.column)} IS NULL`)) as Array<{
      pending: number;
    }>;
    return rows[0]?.pending ?? 0;
  }

  test(
    'defers the embedding pass rather than being killed inside it',
    async () => {
      const states = createInMemoryConnectorStore([connected()]);
      const source = mailboxSource({ pageItems: EXACT_FIT_ITEMS, total: EXACT_FIT_ITEMS });
      const runtime = tenantRuntime();

      const first = await wake(states, source, runtime);
      expect(first.pages).toBe(EXACT_FIT_ITEMS);
      // Every item is in, and none of them is searchable yet. That gap is the
      // point: the work left undone is a query over `embedding IS NULL`, not a
      // promise this process was holding when it died.
      expect(await pendingChunks()).toBeGreaterThan(0);

      const stopped = (await controlSql`
        SELECT run_outcome::text AS outcome, ingest_failure_code::text AS code
          FROM control.connector_health WHERE tenant_id = ${TENANT}`) as Array<{
        outcome: string;
        code: string | null;
      }>;
      expect(stopped[0]).toEqual({ outcome: 'stopped', code: 'cancelled' });
      expect(await jobRows()).toEqual([{ state: 'done', attempts: 1, failure: null }]);

      // The next wake walks the same page for free and drains what was left.
      clockMs += 30 * 60_000;
      const second = await wake(states, source, runtime);
      expect(second.reclaimed).toBe(0);
      expect(second.pages).toBe(EXACT_FIT_ITEMS);
      expect(await pendingChunks()).toBe(0);
      for (const row of await jobRows()) expect(row.failure).toBeNull();
      expect(new Set(embedded).size).toBe(embedded.length);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The claim that lands with nothing left of the window.
 *
 * The tick before a container sheds is an ordinary tick — `serve.ts` fires one
 * every sixty seconds and the platform's clock is not something the process can
 * read. So a slice will sometimes be claimed with its budget already spent, and
 * what it does then is the difference between a slow importer and a stopped one:
 * it must still take one item, because a slice that attempts nothing holds the
 * cursor and hands the identical page to the next slice, forever, while every
 * row in the control plane reads healthy.
 */
describe('a slice claimed with its window already spent', () => {
  test(
    'still takes one item, then banks',
    async () => {
      const states = createInMemoryConnectorStore([connected()]);
      const source = mailboxSource({ pageItems: PAGE_ITEMS, total: MAILBOX_ITEMS });
      const runtime = tenantRuntime();

      const spent = await wake(states, source, runtime, FLEET_WAKE_WINDOW_MS);
      expect(spent.claimed).toBe(1);
      // Exactly one: forward progress, and not a page more than the window paid
      // for.
      expect(spent.pages).toBe(1);

      const health = (await controlSql`
        SELECT run_outcome::text AS outcome, ingest_failure_code::text AS code
          FROM control.connector_health WHERE tenant_id = ${TENANT}`) as Array<{
        outcome: string;
        code: string | null;
      }>;
      expect(health[0]).toEqual({ outcome: 'stopped', code: 'cancelled' });
      expect(await jobRows()).toEqual([{ state: 'done', attempts: 1, failure: null }]);

      // The cursor held, so the page comes back whole rather than short by one.
      const settled = await states.read('gmail');
      expect(settled?.cursor ?? null).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The clock-domain rule, driven rather than asserted.
 *
 * `attempt_deadline_at` is stamped from the instant the *queue* was handed;
 * `outOfTime` reads the instant the *handler* holds. Production runs both on
 * wall clock and they agree, so a yield point built by subtracting one from the
 * other looks correct until something drives the queue from an injected clock —
 * which is every job test in this repo, and also a fleet whose control plane and
 * worker disagree about the hour. Then the yield point sits permanently in the
 * past, every slice banks after a single item, and the connector has stopped
 * importing while every row in the control plane reads healthy.
 *
 * A decade of skew here changes nothing, because what crosses between the two is
 * a duration.
 */
describe('a handler whose clock is nowhere near the queue’s', () => {
  test(
    'slices exactly as it would with the two agreeing',
    async () => {
      const states = createInMemoryConnectorStore([connected()]);
      const source = mailboxSource({ pageItems: PAGE_ITEMS, total: MAILBOX_ITEMS });
      const runtime = tenantRuntime();
      clockSkewMs = 10 * 365 * 24 * 60 * 60_000;

      const skewed = await wake(states, source, runtime);
      // The same slice the agreeing clocks take: short of the page, and more
      // than the one item a collapsed budget would allow.
      expect(skewed.pages).toBeGreaterThan(1);
      expect(skewed.pages).toBeLessThan(PAGE_ITEMS);
      expect(await jobRows()).toEqual([{ state: 'done', attempts: 1, failure: null }]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the yield point', () => {
  test('is the earlier of the process’s own life and the wrapper’s ceiling', () => {
    const startedAt = BASE.getTime();
    // The process dies first: five minutes of container, fifteen of deadline.
    expect(
      attemptYieldAtMs({
        nowMs: startedAt,
        processStartedAtMs: startedAt,
        attemptRemainingMs: 15 * 60_000,
      }),
    ).toBe(startedAt + FLEET_WAKE_WINDOW_MS - ATTEMPT_BANK_RESERVE_MS);

    // A wrapper tighter than the window binds instead.
    expect(
      attemptYieldAtMs({
        nowMs: startedAt,
        processStartedAtMs: startedAt,
        attemptRemainingMs: 4 * 60_000 + 30_000,
      }),
    ).toBe(startedAt + 4 * 60_000 + 30_000 - ATTEMPT_BANK_RESERVE_MS);

    // A claim taken late in the window inherits what is left of it, not a fresh
    // five minutes — the container's clock started at the wake, not at the claim.
    expect(
      attemptYieldAtMs({
        nowMs: startedAt + 4 * 60_000,
        processStartedAtMs: startedAt,
        attemptRemainingMs: 15 * 60_000,
      }),
    ).toBe(startedAt + FLEET_WAKE_WINDOW_MS - ATTEMPT_BANK_RESERVE_MS);
  });

  test('refuses a reserve that leaves no room to bank', () => {
    expect(() =>
      attemptYieldAtMs({
        nowMs: BASE.getTime(),
        processStartedAtMs: BASE.getTime(),
        attemptRemainingMs: 15 * 60_000,
        reserveMs: FLEET_WAKE_WINDOW_MS,
      }),
    ).toThrow(/reserve/);
  });
});

// ---------------------------------------------------------------------------
// The number the platform owns.
// ---------------------------------------------------------------------------

/**
 * `FLEET_WAKE_WINDOW_MS` is not a policy this repo chose. It is
 * `WorkerFleet.sleepAfter`, restated in the one place the batch lane can read
 * it, and the whole defect was that the two disagreed by 3x with nothing to say
 * so.
 *
 * Read as text rather than imported, for the reason `test/fleet/image.test.ts`
 * gives: `src/mcp/router.ts` imports `@cloudflare/containers`, which imports the
 * workerd-only `cloudflare:workers`, so nothing importing it loads in a blocking
 * test.
 */
describe('the wake window', () => {
  const ROUTER = `${import.meta.dir}/../../src/mcp/router.ts`;

  function sleepAfterOf(router: string, className: string): string {
    const body = new RegExp(`class\\s+${className}\\s+extends[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(
      router,
    );
    if (body?.[1] === undefined) throw new Error(`src/mcp/router.ts declares no class ${className}`);
    const value = /sleepAfter\s*=\s*['"]([^'"]+)['"]/.exec(body[1]);
    if (value?.[1] === undefined) throw new Error(`${className} sets no sleepAfter`);
    return value[1];
  }

  /** `'5m'`, `'90s'`, `'2h'` — the spellings `parseTimeExpression` accepts. */
  function millisOf(expression: string): number {
    const match = /^(\d+)(ms|s|m|h)$/.exec(expression.trim());
    if (match === null) throw new Error(`unreadable sleepAfter: ${expression}`);
    const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
    return Number.parseInt(match[1] as string, 10) * unit;
  }

  test('is the worker fleet’s own sleepAfter, not a number this module chose', async () => {
    const router = await Bun.file(ROUTER).text();
    expect(millisOf(sleepAfterOf(router, 'WorkerFleet'))).toBe(FLEET_WAKE_WINDOW_MS);
  });

  test('leaves room for the first tick, a slice, and the writes that bank it', () => {
    // The container's clock starts at the wake; this process's first claim
    // cannot happen before its own tick interval, because `serve.ts` arms a
    // `setInterval` and does not tick immediately.
    const firstTickMs = 60_000;
    expect(firstTickMs + ATTEMPT_BANK_RESERVE_MS).toBeLessThan(FLEET_WAKE_WINDOW_MS);
  });
});
