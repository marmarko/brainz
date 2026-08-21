/**
 * The first surface that shows a user what is actually in their brain.
 *
 * ============================================================================
 * WHAT WAS MISSING, AND WHY A COUNT IS THE FIX
 * ============================================================================
 *
 * The dashboard rendered the plumbing — plan, connect link, connected accounts,
 * a key form — and nothing about the content. A user who connected three
 * accounts and waited a week had exactly one way to find out whether it had
 * worked: ask the assistant a question and judge the answer. That is why a
 * ten-hour ingest outage and a multi-day consolidation freeze were both found by
 * somebody reading SQL rather than by the person they were happening to.
 *
 * The panel could not have caught either. `connector-panel.ts` reads the control
 * plane's record of *attempts*, and during the outage every attempt completed —
 * so the panel said `connected` and was right to. Arrivals live in the tenant
 * database and nowhere else, which is why this page opens one.
 *
 * ============================================================================
 * TWO HALVES, AND WHY BOTH
 * ============================================================================
 *
 * The routing half drives the real handler with a fake port, the way
 * `restore-route.test.ts` does: 501/302/303 and the render-on-throw are
 * properties of the router, and a test that called a database underneath would
 * assert none of them.
 *
 * The composition half drives the **real** `coveragePort` against a real schema,
 * with a `TenantWork` that hands back the fixture connection — because every
 * number here is a predicate, and a fake would be a test of the test's own
 * arithmetic. Two of them are load-bearing and neither is obvious:
 *
 *   * `page` holds model-written summaries as well as ingested documents
 *     (`src/worker/consolidate/materialize.ts` writes them with an
 *     `origin_context` of their own), so an unfiltered per-origin count reports
 *     the brain's own summaries back as mail that arrived from a mailbox;
 *   * "facts" means live, unquarantined **and not superseded** — three
 *     predicates that no single index carries, and a page that dropped one
 *     would print a number whose label it no longer matches.
 *
 * ============================================================================
 * THE PRIVACY ASSERTION IS A TEST, NOT A COMMENT
 * ============================================================================
 *
 * This is the first surface in the product that shows content-derived
 * information back to its owner, so the rule that it shows counts, codes and
 * instants — never a title, a name or a statement — is asserted against a
 * fixture whose rows carry deliberately recognisable text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { attachBrain } from '../../src/control/accounts.ts';
import {
  SESSION_COOKIE,
  createWebApp,
  readCookie,
  type CoveragePort,
} from '../../src/web/app.ts';
import { coveragePort } from '../../src/web/serve.ts';
import {
  CYCLE_PHASE_NAMES,
  CYCLE_PHASE_STOPS,
  CYCLE_STOP_REASONS,
  ENTITY_KINDS,
  type CoverageView,
  EDGE_KINDS,} from '../../src/web/coverage.ts';
import { cycleFreshnessOf } from '../../src/control/cycle-staleness.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import {
  connect as connectIdentity,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from '../control/identity-fixture.ts';

const ORIGIN = 'https://app.brainz.example';
const AT = new Date('2026-08-16T09:00:00.000Z');
const TENANT = 'coverage-route-alice';
const WORK = 'work:mail';
const PERSONAL = 'personal:mail';
const COVERAGE = '/dashboard?view=coverage';

/**
 * Strings a fixture row carries so the privacy assertion can be a `not.toContain`
 * rather than a promise. A subject line and a person's name are the two things
 * this page must never render, and they are the two things a brain is full of.
 */
const SECRET_TITLE = 'Term sheet for acme-example, signed';
const SECRET_STATEMENT = 'alice-example is the sole director of widget-co';
const SECRET_NAME = 'alice-example';

let identity: IdentityFixture;
let control: ControlFixture;
let schema: SchemaFixture;
let sql: SQL;
let controlSql: SQL;
let brainSql: SQL;

/** What the fake port was asked. The tenant id must come from the session. */
let asked: { reads: unknown[] };

const VIEW: CoverageView = {
  sources: [
    { origin: WORK, documents: 4102, lastArrivedAt: '2026-08-16T07:00:00.000Z', thisWeek: 210 },
    { origin: PERSONAL, documents: 0, lastArrivedAt: null, thisWeek: 0 },
  ],
  documents: 4102,
  documentsThisWeek: 210,
  latestCycle: null,
  lastCompletedAt: null,
  cycleFreshness: 'uncycled',
  documentsSinceLastCycle: 4102,
  everDreamt: false,
  facts: 167,
  entities: 44,
  edges: 12,
  entityTypes: [
    { type: 'person', count: 31 },
    { type: 'organization', count: 13 },
  ],
  openContradictions: null,
  openReview: null,
  windowDays: 7,
  edgeKinds: [{ kind: 'works_at', count: 27 }],
  entitiesWithCard: 48,
};

/** One row of `consolidation_run`, in the order the writer wrote them. */
type RunRow = NonNullable<CoverageView['latestCycle']>;

/**
 * A view the real reader could have returned, built from the rows it reads.
 *
 * **Why a builder and not a literal.** Three of `CoverageView`'s fields —
 * `latestCycle`, `lastCompletedAt` and `cycleFreshness` — are not independent
 * inputs. `readCoverage` derives all three from the same `consolidation_run`
 * rows, so most combinations of them describe no database. A spread over a base
 * literal produces those combinations silently and abundantly: every fixture
 * below used to override `latestCycle` and inherit `cycleFreshness: 'uncycled'`
 * from the base, which says *no cycle has ever run* over a row saying one just
 * did; one asserted `stale` with no completion to be stale since; one gave a
 * `phase_failed` run a `lastCompletedAt` equal to its own `finished_at`, which
 * is exactly the reading rung 23 made wrong and `6b8ad62` fixed. Each of those
 * tests passed. None of them was about a page any user could ever see.
 *
 * That is the same sin the comment below diagnoses in the test IT replaced —
 * "its fixture invented a row shape the writer never produced" — recommitted one
 * layer up, in the fixture written to be correct across the rung. A literal
 * cannot be defended against it, because the compiler is happy with every
 * incoherent combination and the reviewer has to hold the derivation in their
 * head. So the fixture takes the ROWS and runs the derivations, which is the one
 * shape that cannot drift from the reader: if `readCoverage` changes how a view
 * is derived, this either changes with it or these tests stop compiling.
 */
function viewFrom(
  runs: readonly RunRow[],
  counts: Partial<Omit<CoverageView, 'latestCycle' | 'lastCompletedAt' | 'cycleFreshness' | 'everDreamt'>> = {},
): CoverageView {
  // `ORDER BY run_id DESC LIMIT 1` — the newest row, open or closed.
  const latestCycle = runs.length === 0 ? null : (runs[runs.length - 1] ?? null);

  // The anchor's predicate, restated: closed AND (a completing reason OR the
  // legacy `dreamt` arm). Never `finishedAt !== null` alone — since rung 23 that
  // is a return clock, which is the bug this fixture exists to stop faking.
  const completions = runs
    .filter(
      (run) =>
        run.finishedAt !== null &&
        (run.stopReason === 'complete' || run.stopReason === 'free_tier' || run.dreamt),
    )
    .map((run) => run.finishedAt as string)
    .sort();
  const lastCompletedAt = completions.at(-1) ?? null;

  const everDreamt = runs.some((run) => run.finishedAt !== null && run.dreamt);
  const cyclingSince = runs.map((run) => run.startedAt).sort()[0] ?? null;

  const cycleFreshness = cycleFreshnessOf({
    completion:
      latestCycle === null
        ? undefined
        : {
            lastCompleteCycleAt: lastCompletedAt === null ? null : new Date(lastCompletedAt),
            latestStopReason: latestCycle.stopReason,
          },
    cyclingSince: cyclingSince === null ? null : new Date(cyclingSince),
    now: AT,
  }).state;

  const view: CoverageView = {
    ...VIEW,
    ...counts,
    latestCycle,
    lastCompletedAt,
    cycleFreshness,
    everDreamt,
  };

  // Two invariants the reader guarantees and a hand-written `counts` can still
  // break, checked here so a fixture cannot quietly describe no database.
  //
  //  * the backlog is counted from the anchor, and a null anchor is `-infinity`,
  //    so a brain with no completion is behind by every document it holds;
  //  * the two open counts are asked for only when the model tier has completed,
  //    so on a brain where it has not they are absent rather than zero.
  if (lastCompletedAt === null && view.documentsSinceLastCycle !== view.documents) {
    throw new Error('unproducible: no completion, so every document is behind');
  }
  if (!everDreamt && (view.openContradictions !== null || view.openReview !== null)) {
    throw new Error('unproducible: the open counts are asked only after the model tier completes');
  }
  return view;
}

/** A cycle that ran the whole pipeline and closed. The anchor-bearing shape. */
function completed(startedAt: string, finishedAt: string): RunRow {
  return {
    tier: 'paid',
    dreamt: true,
    stopReason: 'complete',
    stoppedPhase: null,
    stoppedPhaseCode: null,
    startedAt,
    finishedAt,
  };
}

/**
 * A cycle that stopped short.
 *
 * `finishedAt` is a parameter rather than a constant because BOTH shapes are
 * real and the page has to be right on both: a pre-rung-23 fleet left a stopped
 * run open, and every fleet since closes it. Rows written by the older writer
 * are still in production databases until the next cycle closes them.
 */
function stopped(
  reason: NonNullable<RunRow['stopReason']>,
  startedAt: string,
  finishedAt: string | null,
  phase: RunRow['stoppedPhase'] = null,
  code: RunRow['stoppedPhaseCode'] = null,
): RunRow {
  return {
    tier: 'paid',
    dreamt: false,
    stopReason: reason,
    stoppedPhase: phase,
    stoppedPhaseCode: code,
    startedAt,
    finishedAt,
  };
}

function fakePort(options: { readonly throws?: boolean; readonly view?: CoverageView } = {}): CoveragePort {
  return {
    read(request) {
      asked.reads.push({ ...request });
      if (options.throws === true) {
        return Promise.reject(new Error('no resolvable connection secret for this tenant'));
      }
      return Promise.resolve(options.view ?? VIEW);
    },
    // The sibling read, which this suite does not exercise. It is here because
    // `CoveragePort` declares it: a method cannot be left unsupplied, which is
    // the whole reason the processing view is a second method rather than a
    // second port. `test/web/processing-route.test.ts` is what drives it.
    readProcessing() {
      return Promise.reject(new Error('this suite does not exercise the processing view'));
    },
  };
}

function app(
  options: {
    readonly wired?: boolean;
    readonly throws?: boolean;
    readonly view?: CoverageView;
    readonly port?: CoveragePort;
  } = {},
) {
  const supplied =
    options.port ??
    fakePort({
      ...(options.throws === undefined ? {} : { throws: options.throws }),
      ...(options.view === undefined ? {} : { view: options.view }),
    });
  return createWebApp({
    sql,
    controlSql,
    origin: ORIGIN,
    mcpUrl: 'https://mcp.brainz.example/mcp',
    stripeWebhookSecret: 'whsec_invented_here',
    now: () => AT,
    hash: TEST_HASH_COST,
    provisioner: {
      provision: () => Promise.resolve({ ok: true as const, tenantId: TENANT, via: 'synchronous' as const }),
    },
    byok: { put: () => Promise.resolve({ ok: true }), revoke: () => Promise.resolve({ ok: true }) },
    // Absent when `wired: false`, so the "no port" branch is a state a test can
    // reach rather than a comment.
    ...(options.wired === false ? {} : { coverage: supplied }),
  });
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(path: string, fields: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(fields),
  });
}

/**
 * `tier: 'paid'` writes the subscription row a real upgrade writes, rather than
 * granting the tenant `internal`. The distinction matters for the state this
 * page kept getting wrong: a user who upgraded ten minutes ago has a paid
 * subscription and a run record whose newest row still says `free_tier`, and
 * that is the pair the sentence has to read correctly.
 */
async function signedIn(
  options: { readonly withBrain?: boolean; readonly tier?: 'free' | 'paid' } = {},
): Promise<string> {
  const handle = app();
  const created = await handle(
    post('/api/signup', {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  );
  const header = created.headers.get('set-cookie') ?? '';
  const token = readCookie(header.split(';')[0] ?? '', SESSION_COOKIE) ?? '';
  const body = (await created.json()) as { account_id: string };

  if (options.withBrain === false) {
    await sql`DELETE FROM account.brain WHERE account_id = ${body.account_id}::account.account_id`;
  } else {
    await seedTenant(controlSql, TENANT);
    await attachBrain(sql, { accountId: body.account_id, tenantId: TENANT, ftsLanguage: 'simple', now: AT });
  }
  if (options.tier === 'paid') {
    // The vendor ids are not decoration: `paid_subscriptions_name_a_vendor_object`
    // refuses a paid row with nothing behind it, precisely so a comp cannot be
    // mistaken for a subscription. A fixture that worked around the CHECK would
    // be testing a row the product cannot hold.
    await sql`UPDATE account.subscription
                 SET tier = 'paid',
                     status = 'active',
                     stripe_customer_id = 'cus_fixture',
                     stripe_subscription_id = 'sub_fixture'
               WHERE account_id = ${body.account_id}::account.account_id`;
  }
  return `${SESSION_COOKIE}=${token}`;
}

beforeAll(async () => {
  identity = await createIdentityStore('coverageroute');
  control = await createControlPlane('coverageroute');
  schema = await provisionFixture('coverageroute');
  sql = connectIdentity(identity);
  controlSql = connectControl(control);
  brainSql = connectTenant(schema);
}, 180_000);

afterAll(async () => {
  await sql?.close();
  await controlSql?.close();
  await brainSql?.close();
  if (identity !== undefined) await dropIdentityStore(identity);
  if (control !== undefined) await dropControlPlane(control);
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

beforeEach(async () => {
  await sql`DELETE FROM account.account`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  asked = { reads: [] };
  await brainSql.unsafe(`
    DELETE FROM contradiction_report;
    DELETE FROM review_queue;
    DELETE FROM entity_edge;
    DELETE FROM entity_alias;
    DELETE FROM entity_slug;
    DELETE FROM entity;
    UPDATE fact SET superseded_by = NULL;
    DELETE FROM fact;
    DELETE FROM chunk;
    DELETE FROM page;
    DELETE FROM consolidation_run;
  `);
});

// ---------------------------------------------------------------------------
// 1. Reachable, which is the whole point of the change.
// ---------------------------------------------------------------------------

describe('the coverage view is reachable and gated by the session', () => {
  test('the dashboard is the way in', async () => {
    // A page nobody can find is the same defect as a port nobody supplies. The
    // retractions surface shipped with its only link on the page you reach
    // AFTER using it, and that had to be fixed separately.
    const cookie = await signedIn();
    const page = await (await app()(get('/dashboard', cookie))).text();
    expect(page).toContain(`href="${COVERAGE}"`);
  });

  test('a signed-in user with a brain sees what arrived, per source', async () => {
    const cookie = await signedIn();
    const response = await app()(get(COVERAGE, cookie));

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain(WORK);
    expect(page).toContain('4102');
    expect(page).toContain('2026-08-16T07:00:00.000Z');
    // The tenant id is never request input: it comes from the session's account.
    expect(asked.reads).toEqual([{ tenantId: TENANT }]);
  });

  test('the plain dashboard opens no brain at all', async () => {
    // The cost argument for a separate view rather than a panel: tens of
    // thousands of tenant databases are suspended most of the time, and a login
    // must not wake one.
    const cookie = await signedIn();
    await app()(get('/dashboard', cookie));
    expect(asked.reads).toEqual([]);
  });

  test('no session is sent to sign in rather than shown a brain', async () => {
    const response = await app()(get(COVERAGE));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
    expect(asked.reads).toEqual([]);
  });

  test('no brain is sent to the page that can build one', async () => {
    const cookie = await signedIn({ withBrain: false });
    const response = await app()(get(COVERAGE, cookie));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/brain');
    expect(asked.reads).toEqual([]);
  });

  test('a deployment with no port says so rather than rendering zeroes', async () => {
    // Zeroes would be indistinguishable from an empty brain, on the one page
    // whose entire job is telling those two states apart.
    const cookie = await signedIn();
    const response = await app({ wired: false })(get(COVERAGE, cookie));
    expect(response.status).toBe(501);
    expect(await response.text()).toContain('cannot read your brain');
  });

  test('a brain that will not open is explained rather than blanked', async () => {
    // `withTenant` throws when the connection secret will not resolve, and the
    // entrypoint turns a throw into a generic 500. That is right for severance
    // and wrong here: a suspended compute or a cold start would blank the page
    // at the exact moment somebody is trying to find out what is wrong.
    const cookie = await signedIn();
    const response = await app({ throws: true })(get(COVERAGE, cookie));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('could not be reached');
    // And the way back is still on it.
    expect(page).toContain('href="/dashboard"');
  });
});

// ---------------------------------------------------------------------------
// 2. Honest when the brain is thin. This is the requirement, not a nicety.
// ---------------------------------------------------------------------------

describe('a thin brain reads as thin rather than as a small truth', () => {
  test('an empty brain says nothing has arrived, and does not read as broken', async () => {
    const cookie = await signedIn();
    const empty = viewFrom([], {
      sources: [],
      documents: 0,
      documentsThisWeek: 0,
      documentsSinceLastCycle: 0,
      facts: 0,
      entities: 0,
      edges: 0,
      entityTypes: [],
    });
    const page = await (await app({ view: empty })(get(COVERAGE, cookie))).text();
    expect(page).toContain('Nothing has reached this brain yet');
    // And no derived section at all. Three zeroes under "what it made of them"
    // is a small number presented as a truth about a pipeline that has had
    // nothing to do — the dashboard failure this page exists to stop repeating.
    expect(page).not.toContain('What it made of them');
  });

  test('a brain that has never consolidated says so, above the derived numbers', async () => {
    const cookie = await signedIn();
    const page = await (await app()(get(COVERAGE, cookie))).text();
    expect(page).toContain('has not consolidated yet');
    // The freeze is the story, so it is told before the numbers it explains.
    expect(page.indexOf('has not consolidated yet')).toBeLessThan(page.indexOf('167'));
  });

  // -------------------------------------------------------------------------
  // The four states of the consolidation line, one test each, and each asserts
  // it renders as ITSELF and not as one of the other three.
  //
  // **The bug these were written against.** `cycleSentence` branched on
  // `finished_at` alone and returned "A cycle is running now" for every open
  // run. `finished_at IS NULL` was never a synonym for running: the writer
  // banks a stop reason on a run it leaves open, so a brain frozen in `extract`
  // — 5,608 pages at 167 facts, the incident rung 20 exists for — reported
  // itself as busy for as long as it stayed broken. The page whose job is to
  // make a freeze visible said the opposite in exactly that case, and the old
  // test passed because its fixture invented a row shape (`phase_failed` with
  // `finished_at` set) that the writer of the day never produced.
  //
  // **Both row shapes are pinned, on purpose.** A run that stopped short is
  // written open by the writer this was found against, and closed by the one
  // rung 22 is landing. The sentence must be right on rows from both sides of
  // that change, which is why the code reads the (finished_at, stop_reason)
  // PAIR and why the same stop appears twice below.
  // -------------------------------------------------------------------------

  test('a cycle with nothing recorded against it is not called running', async () => {
    // The one row shape that genuinely cannot be resolved: an open run with no
    // reason banked is a cycle in flight OR one killed before it could write,
    // and nothing on this row separates them. The old copy picked the flattering
    // one and stated it as fact.
    const cookie = await signedIn();
    // One run, open, nothing banked. No completion anywhere, so the brain is
    // behind by every document it holds — which `viewFrom` enforces.
    const open = viewFrom([
      {
        tier: 'paid',
        dreamt: false,
        stopReason: null,
        stoppedPhase: null,
        stoppedPhaseCode: null,
        startedAt: '2026-08-16T08:55:00.000Z',
        finishedAt: null,
      },
    ]);
    const page = await (await app({ view: open })(get(COVERAGE, cookie))).text();
    expect(page).toContain('2026-08-16T08:55:00.000Z');
    expect(page).toContain('nothing has been recorded against it');
    // Says which two states it cannot tell apart rather than choosing one.
    expect(page).toContain('look the same from here');
    expect(page).not.toContain('running now');
    // And it is not any of the other three states.
    expect(page).not.toContain('has not closed');
    expect(page).not.toContain('has not consolidated yet');
  });

  test('a cycle frozen in a phase says it stopped, not that it is running', async () => {
    // THE case. An open run carrying `phase_failed at extract` is the frozen
    // brain, and it rendered as "A cycle is running now."
    const cookie = await signedIn();
    const frozen = viewFrom(
      [
        completed('2026-08-10T00:00:00.000Z', '2026-08-10T00:05:00.000Z'),
        stopped('phase_failed', '2026-08-15T02:00:00.000Z', null, 'extract', 'model_unavailable'),
      ],
      { documentsSinceLastCycle: 1800 },
    );
    const page = await (await app({ view: frozen })(get(COVERAGE, cookie))).text();
    expect(page).toContain('has not closed');
    expect(page).toContain('extract');
    expect(page).toContain('model_unavailable');
    // The number that turns "it stopped" into "and this much has piled up".
    expect(page).toContain('1800');
    // Not the state it used to be reported as, and not the other two.
    expect(page).not.toContain('running now');
    expect(page).not.toContain('nothing has been recorded against it');
    expect(page).not.toContain('has not consolidated yet');
  });

  test('a cycle that stopped in a phase and closed still names the phase and the code', async () => {
    // The same stop, written the way rung 22's writer writes it: closed, with
    // the reason on the row. `phase_failed at extract with model_unavailable` is
    // a different sentence from `free_tier`, and the schema refuses to let the
    // two vocabularies blur.
    const cookie = await signedIn();
    // `lastCompletedAt` is the EARLIER run's, never this one's. A `phase_failed`
    // cycle writes `finished_at` from rung 23 on, and reading that as the
    // completion is the bug `6b8ad62` fixed — a fixture that sets the two equal
    // is asserting against the reading the fix removed.
    const closed = viewFrom(
      [
        completed('2026-08-15T01:00:00.000Z', '2026-08-15T01:20:00.000Z'),
        stopped(
          'phase_failed',
          '2026-08-15T02:00:00.000Z',
          '2026-08-15T02:04:00.000Z',
          'extract',
          'model_unavailable',
        ),
      ],
      { documentsSinceLastCycle: 1800 },
    );
    const page = await (await app({ view: closed })(get(COVERAGE, cookie))).text();
    expect(page).toContain('Your last cycle finished');
    expect(page).toContain('extract');
    expect(page).toContain('model_unavailable');
    expect(page).toContain('1800');
    expect(page).not.toContain('running now');
    expect(page).not.toContain('has not closed');
  });

  test('a backlog behind a completed cycle reads as a backlog, not as a stopped cycle', async () => {
    // "Consolidation is behind" is its own state: the cycle finished cleanly and
    // documents have piled up since. It must not borrow the vocabulary of a
    // cycle that stopped, or the two become one undifferentiated alarm.
    const cookie = await signedIn();
    const behind = viewFrom(
      [completed('2026-08-15T02:00:00.000Z', '2026-08-15T02:40:00.000Z')],
      { documentsSinceLastCycle: 900, openContradictions: 3, openReview: 1 },
    );
    const page = await (await app({ view: behind })(get(COVERAGE, cookie))).text();
    expect(page).toContain('ran the whole pipeline');
    expect(page).toContain('900');
    expect(page).toContain('not in the numbers below');
    expect(page).not.toContain('running now');
    expect(page).not.toContain('has not closed');
    expect(page).not.toContain('has not consolidated yet');
  });

  // -------------------------------------------------------------------------
  // The freeze as a DURATION, which is the half the stop-reason sentence cannot
  // carry.
  //
  // Naming the newest cycle's stop is right and it is not enough: "it stopped in
  // the extract phase" is equally true of one bad Tuesday, which resolves
  // itself, and of the multi-day freeze this page exists for, which does not.
  // The brain that sat at 5,608 documents and 167 facts said exactly that
  // sentence every day for days while every clock the fleet holds — the job's
  // state, its failure code, `last_cycle_at`, `next_due_at` — stayed clean,
  // because a cycle that stops short still returns and a job that returns is
  // done. So the assertions below are about the extra row, and about it staying
  // silent on the ordinary day.
  // -------------------------------------------------------------------------

  test('cycles that keep stopping with no completion for days say so as a duration', async () => {
    const cookie = await signedIn();
    const frozen = viewFrom(
      [
        completed('2026-08-09T00:00:00.000Z', '2026-08-09T00:05:00.000Z'),
        stopped('phase_failed', '2026-08-15T02:00:00.000Z', null, 'extract', 'model_unavailable'),
      ],
      { documentsSinceLastCycle: 1800 },
    );
    expect(frozen.cycleFreshness).toBe('stale');
    const page = await (await app({ view: frozen })(get(COVERAGE, cookie))).text();
    // The newest cycle's own reason still renders — this row is in addition to
    // it, not instead of it.
    expect(page).toContain('has not closed');
    expect(page).toContain('extract');
    // And the sentence that separates a hiccup from a freeze.
    expect(page).toContain('stopping before the end for longer');
    expect(page).toContain('2026-08-09T00:05:00.000Z');
    // **The claim this row used to make and could not keep.** A cycle stops
    // BETWEEN phases, so everything that ran before the stop committed; saying
    // the counts are frozen at the anchor is false on three of the reasons that
    // reach here, printed directly above the counts that disprove it.
    expect(page).not.toContain('have not moved since then');
    // Cycles ARE running. Borrowing the vocabulary of a brain nothing has
    // scheduled would send the reader to the wrong place.
    expect(page).not.toContain('No cycle has finished on this brain');
  });

  test('one stopped cycle over a healthy completion says nothing extra', async () => {
    // The failure mode on the other side: a page that prints a warning on an
    // ordinary day is a page whose warnings stop being read, which is how a week
    // of silence happens in the first place.
    const cookie = await signedIn();
    const slipping = viewFrom(
      [
        completed('2026-08-15T21:30:00.000Z', '2026-08-15T22:00:00.000Z'),
        stopped('out_of_time', '2026-08-16T02:00:00.000Z', null),
      ],
      { documentsSinceLastCycle: 40 },
    );
    expect(slipping.cycleFreshness).toBe('slipping');
    const page = await (await app({ view: slipping })(get(COVERAGE, cookie))).text();
    expect(page).toContain('ran out of the time one attempt is given');
    expect(page).not.toContain('stopping before the end for longer');
    expect(page).not.toContain('No cycle has ever run all the way through');
    expect(page).not.toContain('No cycle has finished on this brain');
  });

  test('a brain nothing has consolidated is a different sentence from one that keeps stopping', async () => {
    // `unattended` and `stale` are different emergencies with different
    // remedies: one is the scheduler, one is the brain. A single "consolidation
    // is behind" for both would send every reader to the same wrong place half
    // the time.
    const cookie = await signedIn();
    const unattended = viewFrom([completed('2026-08-09T02:00:00.000Z', '2026-08-09T02:40:00.000Z')], {
      openContradictions: 0,
      openReview: 0,
    });
    expect(unattended.cycleFreshness).toBe('unattended');
    const page = await (await app({ view: unattended })(get(COVERAGE, cookie))).text();
    expect(page).toContain('No cycle has finished on this brain since');
    expect(page).toContain('nothing here to point at');
    expect(page).not.toContain('stopping before the end for longer');
  });

  test('a crash loop that never banks a reason does not contradict itself', async () => {
    // The shape that caught the first draft of this row. An open run with a NULL
    // stop reason and an ancient completion reaches `unattended` — and
    // `cycleSentence` renders "a cycle opened X and nothing has been recorded
    // against it" directly above. The first copy answered that with "no cycle
    // has run at all", so the page asserted two opposite things on one screen,
    // on the surface whose own rule is to state what it observes and never
    // assert what it cannot verify.
    const cookie = await signedIn();
    const crashing = viewFrom(
      [
        completed('2026-08-07T00:00:00.000Z', '2026-08-07T00:05:00.000Z'),
        {
          tier: 'paid',
          dreamt: false,
          stopReason: null,
          stoppedPhase: null,
          stoppedPhaseCode: null,
          startedAt: '2026-08-16T08:55:00.000Z',
          finishedAt: null,
        },
      ],
      { openContradictions: 0, openReview: 0 },
    );
    expect(crashing.cycleFreshness).toBe('unattended');
    const page = await (await app({ view: crashing })(get(COVERAGE, cookie))).text();
    // Both sentences render, and both are true of this row.
    expect(page).toContain('nothing has been recorded against it');
    expect(page).toContain('No cycle has finished on this brain since');
    expect(page).toContain('2026-08-07T00:05:00.000Z');
    // The claim that was false here.
    expect(page).not.toContain('no cycle has run at all');
  });

  test('a brain that has never once finished a cycle is told that, not that it stopped', async () => {
    const cookie = await signedIn();
    // Two runs, because `never_completed` is a DURATION and the clock is the
    // first run's `started_at`. One run started this morning is `starting`, not
    // `never_completed` — the old literal asserted a state its own row could not
    // reach.
    const never = viewFrom([
      stopped('budget_exhausted', '2026-08-10T02:00:00.000Z', '2026-08-10T02:30:00.000Z'),
      stopped('budget_exhausted', '2026-08-16T02:00:00.000Z', null),
    ]);
    expect(never.cycleFreshness).toBe('never_completed');
    const page = await (await app({ view: never })(get(COVERAGE, cookie))).text();
    expect(page).toContain('No cycle has ever run all the way through');
    expect(page).not.toContain('stopping before the end for longer');
  });

  test('the freeze row never names anything a user wrote', async () => {
    // This page's whole rule. The row added here is a sentence plus one instant,
    // and it is rendered on the page most likely to be screenshotted.
    const cookie = await signedIn();
    const frozen = viewFrom([
      completed('2026-08-09T00:00:00.000Z', '2026-08-09T00:05:00.000Z'),
      stopped('phase_failed', '2026-08-15T02:00:00.000Z', null, 'extract', 'model_unavailable'),
    ]);
    expect(frozen.cycleFreshness).toBe('stale');
    const page = await (await app({ view: frozen })(get(COVERAGE, cookie))).text();
    expect(page).not.toContain(SECRET_TITLE);
    expect(page).not.toContain(SECRET_STATEMENT);
    expect(page).not.toContain(SECRET_NAME);
  });

  test('a brain with no cycle at all says so, and says nothing about a cycle', async () => {
    // The fourth state, and the one with no run record to read at all.
    const cookie = await signedIn();
    const page = await (await app()(get(COVERAGE, cookie))).text();
    expect(page).toContain('has not consolidated yet');
    expect(page).not.toContain('running now');
    expect(page).not.toContain('has not closed');
    expect(page).not.toContain('nothing has been recorded against it');
  });

  test('the free tier is told its cold layer is the plan rather than a fault', async () => {
    const cookie = await signedIn();
    const free: CoverageView = {
      ...VIEW,
      latestCycle: {
        tier: 'free',
        dreamt: false,
        stopReason: 'free_tier',
        stoppedPhase: null,
        stoppedPhaseCode: null,
        startedAt: '2026-08-15T02:00:00.000Z',
        finishedAt: '2026-08-15T02:01:00.000Z',
      },
      lastCompletedAt: '2026-08-15T02:01:00.000Z',
      documentsSinceLastCycle: 4,
    };
    const page = await (await app({ view: free })(get(COVERAGE, cookie))).text();
    expect(page).toContain('is on the paid plan');
    expect(page).not.toContain('failed');
    // The other half of the pair below: a free user is not told they have
    // already bought the thing they are being told about.
    expect(page).not.toContain('on your plan now');
  });

  test('a cycle that ran before an upgrade does not tell a paid user they are on the free plan', async () => {
    // `stop_reason` is what the run did when it ran, and the tier on the run
    // record is the tier at that moment. A user who upgraded ten minutes ago has
    // a paid subscription sitting over a newest run that says `free_tier`, and
    // the sentence was reading the run's tier as the reader's — pitching the
    // paid plan to somebody who had just bought it, on the page they opened to
    // find out whether buying it had worked.
    const cookie = await signedIn({ tier: 'paid' });
    const beforeUpgrade: CoverageView = {
      ...VIEW,
      latestCycle: {
        tier: 'free',
        dreamt: false,
        stopReason: 'free_tier',
        stoppedPhase: null,
        stoppedPhaseCode: null,
        startedAt: '2026-08-15T02:00:00.000Z',
        finishedAt: '2026-08-15T02:01:00.000Z',
      },
      lastCompletedAt: '2026-08-15T02:01:00.000Z',
    };
    const page = await (await app({ view: beforeUpgrade })(get(COVERAGE, cookie))).text();
    expect(page).not.toContain('is on the paid plan');
    expect(page).toContain('when that cycle ran');
    expect(page).toContain('on your plan now');
  });

  test('counts that are structurally zero for the tier are absent, not zero', async () => {
    // A panel reading "0 open contradictions" on a tier that cannot produce one
    // is a dead panel that teaches the user the feature is broken.
    const cookie = await signedIn();
    const page = await (await app()(get(COVERAGE, cookie))).text();
    expect(page).not.toContain('contradiction');
  });
});

// ---------------------------------------------------------------------------
// 3. The privacy line, asserted.
// ---------------------------------------------------------------------------

describe('the page shows counts, codes and instants — and nothing else', () => {
  test('every field of the view is a number, an instant, or a schema code', () => {
    // The type is the control; this walks the value so a later field that
    // carried prose could not pass by being typed `string`.
    const scalars = [
      VIEW.documents,
      VIEW.documentsThisWeek,
      VIEW.documentsSinceLastCycle,
      VIEW.facts,
      VIEW.entities,
      VIEW.edges,
      VIEW.windowDays,
    ];
    for (const value of scalars) expect(typeof value).toBe('number');
    for (const source of VIEW.sources) {
      // `<class>:<source>` — structural grammar, not content. No address, no
      // display name, no account key is in that string by construction.
      expect(source.origin).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    }
    for (const bucket of VIEW.entityTypes) {
      expect([
        'person',
        'organization',
        'place',
        'project',
        'product',
        'event',
        'topic',
        'other',
      ]).toContain(bucket.type);
    }
  });

  test('the page says what it does not show, where the reader is', async () => {
    const cookie = await signedIn();
    const page = await (await app()(get(COVERAGE, cookie))).text();
    expect(page).toContain('counts, codes and times');
  });
});

// ---------------------------------------------------------------------------
// 4. The composition. The real port, against a real brain.
// ---------------------------------------------------------------------------

describe('the edge vocabulary this page restates is the one the schema seeds', () => {
  test('EDGE_KINDS equals the seeded registry, in both directions', async () => {
    const rows = (await brainSql.unsafe(
      `SELECT edge_type FROM edge_type ORDER BY edge_type`,
    )) as Array<{ edge_type: string }>;
    // Both directions: a value seeded and not restated renders as a raw code on
    // the page, and a value restated and not seeded is one a foreign key makes
    // unreachable. The entity-type histogram is pinned the same way.
    expect(rows.map((row) => row.edge_type).sort()).toEqual([...EDGE_KINDS].sort());
  });
});

describe('the port that is actually wired', () => {
  /** One tenant, one connection — the shape `tenantDatabases` produces. */
  const withTenant = <T,>(_tenantId: string, work: (db: SQL) => Promise<T>): Promise<T> =>
    work(brainSql);

  async function insertPage(options: {
    readonly origin?: string;
    readonly title?: string;
    readonly derivation?: string;
    readonly createdAt?: string;
    readonly deleted?: boolean;
    readonly quarantined?: boolean;
  } = {}): Promise<string> {
    const rows = (await brainSql.unsafe(
      `INSERT INTO page (origin_context, source_type, title, derivation, embedding_model,
                         embedding_dimensions, chunker_version, normalizer_version, content_sha256,
                         created_at, deleted_at, quarantined_at)
       VALUES ($1, 'email', $2, $3, 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1,
               repeat('a', 64), $4::timestamptz, $5::timestamptz, $6::timestamptz)
       RETURNING page_id::text AS id`,
      [
        options.origin ?? WORK,
        options.title ?? 'A document',
        options.derivation ?? 'ingested',
        options.createdAt ?? AT.toISOString(),
        options.deleted === true ? AT.toISOString() : null,
        options.quarantined === true ? AT.toISOString() : null,
      ],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  }

  async function insertFact(options: {
    readonly statement?: string;
    readonly quarantined?: boolean;
  } = {}): Promise<string> {
    // The active seat's column, which is the one a live brain fills: `embedding`
    // is the 1536d seat this fleet no longer writes, and v14 dropped its NOT
    // NULL precisely so a fact can be written under one seat and NULL in the
    // other. A count must not care which seat a fact sits in, and this fixture
    // is what proves it does not.
    const rows = (await brainSql.unsafe(
      `INSERT INTO fact (statement, ${ACTIVE_EMBEDDING_SEAT.column}, origin_contexts, quarantined_at)
       VALUES ($1, $2::vector, ARRAY['${WORK}']::text[], $3::timestamptz)
       RETURNING fact_id::text AS id`,
      [
        options.statement ?? 'a statement',
        `[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(',')}]`,
        options.quarantined === true ? AT.toISOString() : null,
      ],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  }

  async function insertEntity(name: string, type: string, deleted = false): Promise<string> {
    const rows = (await brainSql.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, origin_contexts, deleted_at)
       VALUES ($1, $2, ARRAY['${WORK}']::text[], $3::timestamptz)
       RETURNING entity_id::text AS id`,
      [name, type, deleted ? AT.toISOString() : null],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  }

  async function insertRun(options: {
    readonly dreamt?: boolean;
    readonly stopReason?: string | null;
    readonly stoppedPhase?: string | null;
    readonly stoppedPhaseCode?: string | null;
    readonly finishedAt?: string | null;
    readonly tier?: string;
  }): Promise<void> {
    await brainSql.unsafe(
      `INSERT INTO consolidation_run (trigger_reason, tier, dreamt, stop_reason,
                                      stopped_phase, stopped_phase_code, started_at, finished_at)
       VALUES ('debt_debounce', $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
      [
        options.tier ?? 'paid',
        options.dreamt ?? false,
        options.stopReason ?? null,
        options.stoppedPhase ?? null,
        options.stoppedPhaseCode ?? null,
        '2026-08-10T00:00:00.000Z',
        options.finishedAt === undefined ? '2026-08-10T00:05:00.000Z' : options.finishedAt,
      ],
    );
  }

  test(
    'documents are counted per origin, and the brain’s own summaries are not documents',
    async () => {
      await insertPage({ origin: WORK, createdAt: '2026-08-15T00:00:00.000Z' });
      await insertPage({ origin: WORK, createdAt: '2026-08-16T07:00:00.000Z' });
      await insertPage({ origin: PERSONAL, createdAt: '2026-07-01T00:00:00.000Z' });
      // A synopsis the model wrote, carrying an origin of its own. Counting it
      // would report the brain's own writing back as mail that arrived.
      await insertPage({ origin: WORK, derivation: 'model_derived', createdAt: '2026-08-16T08:00:00.000Z' });
      // Retracted and quarantined rows are not held documents.
      await insertPage({ origin: WORK, deleted: true });
      await insertPage({ origin: WORK, quarantined: true });

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      const work = view.sources.find((source) => source.origin === WORK);
      const personal = view.sources.find((source) => source.origin === PERSONAL);

      expect(work?.documents).toBe(2);
      expect(work?.lastArrivedAt).toBe('2026-08-16T07:00:00.000Z');
      expect(personal?.documents).toBe(1);
      expect(view.documents).toBe(3);
    },
    120_000,
  );

  test(
    'facts means live, unquarantined and not superseded — the label the page prints',
    async () => {
      const older = await insertFact({ statement: 'the old reading' });
      const newer = await insertFact({ statement: SECRET_STATEMENT });
      await insertFact({ statement: 'junk', quarantined: true });
      await brainSql.unsafe(`UPDATE fact SET superseded_by = $1::bigint WHERE fact_id = $2::bigint`, [
        newer,
        older,
      ]);

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.facts).toBe(1);
    },
    120_000,
  );

  test(
    'entities are counted by type, and a deleted one is gone',
    async () => {
      await insertEntity(SECRET_NAME, 'person');
      await insertEntity('charlie-example', 'person');
      await insertEntity('widget-co', 'organization');
      await insertEntity('gone', 'person', true);
      const subject = await insertEntity('acme-example', 'organization');
      const object = await insertEntity('fund-a', 'organization');
      await brainSql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
         VALUES ($1::bigint, 'invested_in', $2::bigint, ARRAY['${WORK}']::text[])`,
        [object, subject],
      );

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.entities).toBe(5);
      expect(view.entityTypes).toEqual([
        { type: 'organization', count: 3 },
        { type: 'person', count: 2 },
      ]);
      expect(view.edges).toBe(1);
    },
    120_000,
  );

  test(
    'a stopped cycle closes its run and must not become the backlog’s anchor',
    async () => {
      // **The receipt for the whole fixture rewrite, taken from the real
      // reader.** Rung 23 closes the run on every exit, so a `phase_failed`
      // cycle writes `finished_at` exactly like a completed one. Anchoring the
      // backlog on that column alone resets "how much has piled up" to zero on
      // every cycle of a permanently frozen brain — which is the state this page
      // exists to make visible, rendering as caught up.
      //
      // **This is the primary arm; the older case below it is the legacy one.**
      // The gate has two: `stop_reason IN ('complete','free_tier')` and `OR
      // dreamt`, which covers completed rows written before the reason was
      // always set. `a cycle that stopped short does not move the backlog
      // anchor` drives a NULL-reason `dreamt` row, so deleting the reason arm
      // leaves it green. This one drives `complete`, so deleting the reason arm
      // turns it red. Neither is redundant with the other; a single case would
      // pin half the predicate.
      //
      // Two runs and four documents say it in numbers a fixture cannot fake:
      // the completion is old, three documents arrived after it, and the newest
      // run is a stop that closed AFTER all of them. With the reason gate the
      // anchor stays on the completion and the backlog is 3; without it the
      // anchor jumps to the failed run and the backlog is 0 and the paragraph
      // disappears.
      await insertRun({ finishedAt: '2026-08-10T00:05:00.000Z', dreamt: true, stopReason: 'complete' });
      await insertPage({ createdAt: '2026-08-11T00:00:00.000Z' });
      await insertPage({ createdAt: '2026-08-12T00:00:00.000Z' });
      await insertPage({ createdAt: '2026-08-13T00:00:00.000Z' });
      await insertRun({
        finishedAt: '2026-08-14T02:04:00.000Z',
        dreamt: false,
        stopReason: 'phase_failed',
        stoppedPhase: 'extract',
        stoppedPhaseCode: 'model_unavailable',
      });

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });

      expect(view.lastCompletedAt).toBe('2026-08-10T00:05:00.000Z');
      expect(view.documentsSinceLastCycle).toBe(3);
      // The newest run is still the one whose sentence renders — the anchor and
      // the latest cycle are two different reads of the same table, and only one
      // of them is gated on the reason.
      expect(view.latestCycle?.stopReason).toBe('phase_failed');
      expect(view.latestCycle?.finishedAt).toBe('2026-08-14T02:04:00.000Z');
    },
    120_000,
  );

  test(
    'the cycle is read from the run record, and the backlog is measured from its own clock',
    async () => {
      await insertRun({ finishedAt: '2026-08-10T00:05:00.000Z', dreamt: true, stopReason: null });
      // Three arrived after the cycle finished; one before.
      await insertPage({ createdAt: '2026-08-09T00:00:00.000Z' });
      await insertPage({ createdAt: '2026-08-11T00:00:00.000Z' });
      await insertPage({ createdAt: '2026-08-12T00:00:00.000Z' });
      await insertPage({ createdAt: '2026-08-13T00:00:00.000Z' });

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.lastCompletedAt).toBe('2026-08-10T00:05:00.000Z');
      expect(view.documentsSinceLastCycle).toBe(3);
      expect(view.everDreamt).toBe(true);
      expect(view.latestCycle?.dreamt).toBe(true);
    },
    120_000,
  );

  test(
    'a brain that never consolidated has every document behind, and says the layer is cold',
    async () => {
      await insertPage({});
      await insertPage({});

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.latestCycle).toBeNull();
      expect(view.lastCompletedAt).toBeNull();
      expect(view.everDreamt).toBe(false);
      // Everything is behind a cycle that has never run, which is the truth.
      expect(view.documentsSinceLastCycle).toBe(2);
      // Structurally zero for a brain with no model layer: absent, not zero.
      expect(view.openContradictions).toBeNull();
      expect(view.openReview).toBeNull();
    },
    120_000,
  );

  test(
    'a cycle that stopped short does not move the backlog anchor, however it was written',
    async () => {
      // **The clock that changed meaning underneath this page.** Until rung 23,
      // a cycle that stopped short left its run open, so `finished_at IS NOT
      // NULL` and "a cycle completed" were the same question. Rung 23 closes the
      // run on every exit — a returning cycle has finished its pass whatever
      // stopped it — and from then on `finished_at` says a cycle came *back*.
      //
      // Anchored on it, this page would have told the owner of a permanently
      // frozen brain that nothing was piling up, every day, because the anchor
      // moved forward with each failure. That is the `last_cycle_at` mistake one
      // table over, and this is the case that refuses it.
      await insertRun({ finishedAt: '2026-08-10T00:05:00.000Z', dreamt: true });
      await insertPage({ createdAt: '2026-08-11T00:00:00.000Z' });
      await insertPage({ createdAt: '2026-08-12T00:00:00.000Z' });
      // The stopped cycle, closed the way rung 23's writer closes it.
      await insertRun({
        finishedAt: '2026-08-13T00:05:00.000Z',
        dreamt: false,
        stopReason: 'phase_failed',
      });

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.lastCompletedAt).toBe('2026-08-10T00:05:00.000Z');
      expect(view.documentsSinceLastCycle).toBe(2);
      // And the reading built on that clock sees the stop for what it is.
      expect(view.latestCycle?.stopReason).toBe('phase_failed');
    },
    120_000,
  );

  test(
    'a free-tier cycle is a completion, not a brain that finished nothing',
    async () => {
      // `finishRun` closes a `free_tier` run exactly as it closes `complete`:
      // the cycle did everything the plan asks of it. Excluding it would put
      // every free brain permanently behind its own backlog and permanently
      // `stale` on the reading beside it.
      await insertRun({ finishedAt: '2026-08-10T00:05:00.000Z', stopReason: 'free_tier', tier: 'free' });
      await insertPage({ createdAt: '2026-08-11T00:00:00.000Z' });

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.lastCompletedAt).toBe('2026-08-10T00:05:00.000Z');
      expect(view.documentsSinceLastCycle).toBe(1);
    },
    120_000,
  );

  test(
    'a run that is still open reads as open rather than as the last completed one',
    async () => {
      await insertRun({ finishedAt: '2026-08-10T00:05:00.000Z', dreamt: true });
      await insertRun({ finishedAt: null });

      const view = await coveragePort(withTenant).read({ tenantId: TENANT });
      expect(view.latestCycle?.finishedAt).toBeNull();
      // The anchor is the last *completed* run, so the backlog is not reset by a
      // cycle that has not finished doing anything yet.
      expect(view.lastCompletedAt).toBe('2026-08-10T00:05:00.000Z');
    },
    120_000,
  );

  test(
    'the page renders a real brain without printing one word of it',
    async () => {
      const pageId = await insertPage({ title: SECRET_TITLE });
      await insertFact({ statement: SECRET_STATEMENT });
      await insertEntity(SECRET_NAME, 'person');
      expect(pageId).not.toBe('');

      const cookie = await signedIn();
      const rendered = await (
        await app({ port: coveragePort(withTenant) })(get(COVERAGE, cookie))
      ).text();

      // The counts are there.
      expect(rendered).toContain(WORK);
      // The content is not, and this is the assertion the whole design turns on:
      // this page is screenshotted, cast to a meeting room and left open on a
      // desk. A count survives all three; a subject line does not.
      expect(rendered).not.toContain(SECRET_TITLE);
      expect(rendered).not.toContain(SECRET_STATEMENT);
      expect(rendered).not.toContain(SECRET_NAME);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // 5. The restated vocabularies, checked against the database's own alphabet.
  //
  // `coverage.ts` restates four CHECKs rather than importing them, which is the
  // right call — importing `phases.ts` would pull the cycle's module graph into
  // a page render — but a restatement drifts silently, because it type-checks
  // while it is wrong. Two of the four HAD drifted: `stop_reason` was missing
  // `out_of_time` (rung 19) and `stopped_phase_code` was missing
  // `input_rejected` (rung 21), so a run record carrying either reached a page
  // whose types said it could not exist.
  //
  // The assertion is both directions against `pg_get_constraintdef`, which is
  // the database's own answer rather than the migration file the restatement was
  // copied from. Missing a member is the drift that already happened; inventing
  // one is a page rendering a state nothing can write.
  // -------------------------------------------------------------------------

  /** The quoted literals of a `col IN ('a', 'b')` CHECK, as the database holds it. */
  async function checkAlphabet(constraint: string): Promise<string[]> {
    const rows = (await brainSql.unsafe(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    )) as Array<{ def: string }>;
    const def = rows[0]?.def;
    if (def === undefined) throw new Error(`no such constraint: ${constraint}`);
    return [...def.matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
  }

  test(
    'every vocabulary this page restates is the one the database accepts',
    async () => {
      expect(await checkAlphabet('entity_type_is_known')).toEqual([...ENTITY_KINDS].sort());
      expect(await checkAlphabet('consolidation_run_stop_reason_is_known')).toEqual(
        [...CYCLE_STOP_REASONS].sort(),
      );
      expect(await checkAlphabet('consolidation_run_stopped_phase_is_known')).toEqual(
        [...CYCLE_PHASE_NAMES].sort(),
      );
      expect(await checkAlphabet('consolidation_run_stopped_phase_code_is_known')).toEqual(
        [...CYCLE_PHASE_STOPS].sort(),
      );
    },
    120_000,
  );
});
