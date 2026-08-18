/**
 * A subject erasure that the next poll undoes is not an erasure.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * `src/core/lifecycle/subject-erasure.ts` owes four properties to U15's §6.3
 * determination, and the fourth is "**tombstoned against re-ingestion**". Its
 * own header states the mechanism and states that half of it was missing:
 * `eraseSubject` writes an `erased_subject` row and `isErasedSubject` is what a
 * pull path consults before writing a page — and no pull path consulted it.
 *
 * That gap is not a slow leak. A connector polls on a cadence measured in
 * minutes (`DEFAULT_CADENCE_SECONDS` is 300 for mail), the erasure soft-deletes
 * the pages, and U4's replacement lookup only ever finds a **live** page — so
 * the next poll re-offers the same message, finds nothing live at that ref, and
 * writes a brand-new page carrying the correspondent whose receipt said the
 * brain holds nothing about them. Within the hour, and with a receipt already in
 * a third party's hands.
 *
 * So the property under test is the whole one, end to end, through the two real
 * modules:
 *
 *   1. a poll writes a page from a correspondent,
 *   2. the **real** `eraseSubject` runs against the real identifier,
 *   3. the same item is offered again by the same source,
 *   4. and nothing about that correspondent comes back.
 *
 * **Step 2 is deliberately the real erasure and not a planted `erased_subject`
 * row.** The property is that the digest the pull hashes is the digest the
 * erasure wrote — same normalizer, same hash, same table. A fixture that
 * inserted the row itself would prove the pull can read a digest it was handed,
 * which is not the question anybody is asking.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT CLAIM
 * ============================================================================
 *
 * The tombstone stores a **digest**, never an identifier, so a pull can only ask
 * about identifiers it can *name*: the addresses and display names in an item's
 * headers, and the addresses in its text. A message that mentions an erased
 * person by name only, with no address anywhere, is not suppressed — nothing in
 * the brain can enumerate the erased names to compare against, and storing them
 * in plaintext to make that possible would be the failure wearing the fix's
 * clothes. The last test pins that bound as an observed fact rather than leaving
 * it to be discovered as a surprise.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import { eraseSubject, isErasedSubject } from '../../../src/core/lifecycle/subject-erasure.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorState,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { originContextFor, runPull } from '../../../src/ingest/pipedream/pull.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import {
  TENANT,
  countRows,
  createIngestFixture,
  setSpend,
  type IngestFixture,
} from '../fixture.ts';
import { createFakeSource, page } from './fixture.ts';

const NOW = new Date('2026-08-16T09:00:00.000Z');
const GMAIL_ORIGIN = originContextFor('gmail', null);

/** The correspondent who asks to be erased. */
const SUBJECT = 'alice@example.test';
const SUBJECT_NAME = 'Alice Example';
/** Somebody else's mail, which must survive every one of these sweeps. */
const BYSTANDER = 'bob@example.test';

let fixture: IngestFixture;

beforeAll(async () => {
  fixture = await createIngestFixture('u9erased');
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 500_000_000 });
});

afterAll(async () => {
  await fixture?.close();
});

function stateFor(overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    ...connectSource({ source: 'gmail', externalUserId: TENANT, accountId: 'apn_1', now: NOW }),
    ...overrides,
  };
}

async function storeWith(state: ConnectorState): Promise<ConnectorStateStore> {
  const store = createInMemoryConnectorStore();
  await store.write(state);
  return store;
}

/**
 * A mail body long enough to chunk, naming whoever wrote it — so the erasure's
 * own text arm can find the page it is meant to take. The suppression under test
 * is a different arm and must not be able to borrow this one's evidence.
 */
function mailFrom(who: string, seed: string): string {
  return [
    `${seed}: ${who} wrote about the migration schedule and the hiring plan.`,
    `${seed}: the follow-up from ${who} covered runway, pricing and the rollout owner.`,
  ].join('\n\n');
}

function mail(
  id: string,
  options: { readonly from: string; readonly fromName: string; readonly body: string },
) {
  return {
    externalRef: externalRefFor('gmail', id),
    title: `subject ${id}`,
    body: options.body,
    occurredAt: NOW,
    junk: {
      headers: {
        from: `${options.fromName} <${options.from}>`,
        to: 'owner@example.test',
      },
      from: `${options.fromName} <${options.from}>`,
      subject: `subject ${id}`,
    },
  };
}

async function pull(source: ReturnType<typeof createFakeSource>, states: ConnectorStateStore) {
  return runPull({
    tenant: fixture.runtime,
    control: fixture.controlSql,
    profile: HOSTED_PROFILE,
    source,
    states,
    now: NOW,
  });
}

async function livePages(externalRef: string): Promise<number> {
  return countRows(
    fixture.tenantSql,
    'page',
    `external_ref = '${externalRef}' AND origin_context = '${GMAIL_ORIGIN}' AND deleted_at IS NULL`,
  );
}

describe('a poll after an erasure does not re-ingest the erased correspondent', () => {
  const HER_REF = externalRefFor('gmail', 'm-erased');
  const HIS_REF = externalRefFor('gmail', 'm-bystander');

  test('the poll writes both correspondents first, so there is something to erase', async () => {
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          mail('m-erased', { from: SUBJECT, fromName: SUBJECT_NAME, body: mailFrom(SUBJECT, 'first') }),
          mail('m-bystander', { from: BYSTANDER, fromName: 'Bob Bystander', body: mailFrom(BYSTANDER, 'first') }),
        ],
        nextCursor: { kind: 'delta', value: 'h-1' },
      }),
    ]);

    const result = await pull(source, await storeWith(stateFor()));
    expect(result.outcome).toBe('completed');
    expect(result.counts.written).toBe(2);
    expect(await livePages(HER_REF)).toBe(1);
    expect(await livePages(HIS_REF)).toBe(1);
  });

  test('the real erasure takes her page and writes the re-ingestion tombstone', async () => {
    const receipt = await eraseSubject({ sql: fixture.tenantSql }, { identifier: SUBJECT, erasedBy: 'app' });

    expect(receipt.removed.pages).toBeGreaterThanOrEqual(1);
    expect(receipt.reingestionTombstoned).toBe(true);
    expect(await isErasedSubject(fixture.tenantSql, SUBJECT)).toBe(true);

    expect(await livePages(HER_REF)).toBe(0);
    // The bystander is untouched: an erasure keyed on one correspondent that
    // took the mailbox would be a worse failure than the one it fixes.
    expect(await livePages(HIS_REF)).toBe(1);
  });

  test('the next poll offers the same message and it does not come back', async () => {
    // The provider has no idea an erasure happened; it offers what it always
    // offers. This is the ordinary cadence tick, not a contrived replay.
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          mail('m-erased', { from: SUBJECT, fromName: SUBJECT_NAME, body: mailFrom(SUBJECT, 'second') }),
          mail('m-bystander', { from: BYSTANDER, fromName: 'Bob Bystander', body: mailFrom(BYSTANDER, 'second') }),
        ],
        nextCursor: { kind: 'delta', value: 'h-2' },
      }),
    ]);

    const result = await pull(source, await storeWith(stateFor({ cursor: { kind: 'delta', value: 'h-1', issuedAt: NOW.toISOString() } })));

    // The load-bearing assertion, stated as the property rather than as a count:
    // nothing about the erased correspondent is live in the brain again.
    expect(await livePages(HER_REF)).toBe(0);

    // And the suppression is *named* rather than silent — a poll that quietly
    // dropped items would be indistinguishable from a provider that stopped
    // offering them, which is the shape of every unnoticed ingest bug.
    expect(result.counts.suppressed).toBe(1);

    // The bystander's mail still flows. A suppression that stopped the mailbox
    // is a mute button, not a fence.
    expect(result.counts.written).toBe(1);
    expect(await livePages(HIS_REF)).toBe(1);

    // A stable fact about the item, so the cursor moves: holding it would wedge
    // the source forever on a message that is never going to become ingestable.
    expect(result.cursorAdvanced).toBe(true);
    expect(result.stopReason).toBeUndefined();
  });

  test('the suppressed item is on the ingest log, seen and not written', async () => {
    const rows = (await fixture.tenantSql`
      SELECT outcome, items_seen, items_written, items_quarantined
        FROM ingest_log
       WHERE external_ref = ${HER_REF}
       ORDER BY ingest_id DESC
       LIMIT 1
    `) as Array<{ outcome: string; items_seen: number; items_written: number; items_quarantined: number }>;

    expect(rows[0]?.outcome).toBe('ok');
    expect(rows[0]?.items_seen).toBe(1);
    expect(rows[0]?.items_written).toBe(0);
    expect(rows[0]?.items_quarantined).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The two arms, separated — because the three adapters disagree about where a
// participant lives and a test that let one arm cover for the other would pass
// with either one deleted.
// ---------------------------------------------------------------------------

describe('each extraction arm carries its own weight', () => {
  test('the header arm alone: her mail whose text never spells an address', async () => {
    const REF = externalRefFor('gmail', 'm-header-only');
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          {
            externalRef: REF,
            title: 'the rollout',
            // Deliberately no address anywhere in the title or the body. The
            // only place this message names her is the envelope, which is the
            // ordinary shape of mail: people sign off with a first name.
            body: [
              'Confirming the migration slips a week and the rollout owner is unchanged.',
              'The pricing question stays open until the next review. Thanks, A.',
            ].join('\n\n'),
            occurredAt: NOW,
            junk: {
              headers: { from: `${SUBJECT_NAME} <${SUBJECT}>`, to: 'owner@example.test' },
              from: `${SUBJECT_NAME} <${SUBJECT}>`,
              subject: 'the rollout',
            },
          },
        ],
        nextCursor: { kind: 'delta', value: 'h-4' },
      }),
    ]);

    const result = await pull(source, await storeWith(stateFor()));
    expect(result.counts.suppressed).toBe(1);
    expect(await livePages(REF)).toBe(0);
  });

  test('the body arm alone: a calendar event with no headers at all', async () => {
    const REF = externalRefFor('calendar', 'evt-attendees');
    // Calendar's adapter composes the attendee and organizer addresses into the
    // body and fills no `junk` at all — so an implementation that only read
    // headers would re-ingest every meeting she is on, forever.
    const source = createFakeSource('calendar', 'calendar', [
      page({
        items: [
          {
            externalRef: REF,
            title: 'Migration review',
            body: [
              'Migration review — 30 minutes, weekly.',
              `Attendees: owner@example.test, ${SUBJECT}`,
              'Organizer: owner@example.test',
              'The agenda covers runway, pricing and the rollout owner.',
            ].join('\n'),
            occurredAt: NOW,
          },
        ],
        nextCursor: { kind: 'delta', value: 'c-1' },
      }),
    ]);

    const states = createInMemoryConnectorStore();
    await states.write({
      ...connectSource({ source: 'calendar', externalUserId: TENANT, accountId: 'apn_2', now: NOW }),
    });

    const result = await pull(source, states);
    expect(result.counts.suppressed).toBe(1);
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${REF}' AND deleted_at IS NULL`,
      ),
    ).toBe(0);
  });
});

describe('what the digest-only tombstone cannot reach', () => {
  test('a message that names her in prose with no address anywhere is still ingested', async () => {
    const REF = externalRefFor('gmail', 'm-prose');
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          {
            externalRef: REF,
            title: 'lunch',
            body: [
              `${SUBJECT_NAME} said the migration would slip a week and nobody disagreed.`,
              `The follow-up from ${SUBJECT_NAME} covered runway and the rollout owner.`,
            ].join('\n\n'),
            occurredAt: NOW,
            junk: { headers: { from: 'Carol <carol@example.test>' }, from: 'Carol <carol@example.test>' },
          },
        ],
        nextCursor: { kind: 'delta', value: 'h-3' },
      }),
    ]);

    const result = await pull(source, await storeWith(stateFor()));

    // Not a defect of this wiring — a bound of the tombstone. `erased_subject`
    // holds a sha256 and nothing else, deliberately, so there is no set of erased
    // names to scan a body against. Naming it here is what stops it being
    // rediscovered as a surprise, and what a future prose-side arm would have to
    // change on purpose.
    expect(result.counts.suppressed).toBe(0);
    expect(await livePages(REF)).toBe(1);
  });
});
