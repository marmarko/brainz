/**
 * The listing and the executor answer the same question, at the same edge.
 *
 * `restoreForgotten` refuses while `now − deletedAt > ttl`. `listRestorable`
 * admits while `retracted_at >= restorableSince(now, ttl)`. Those are the same
 * inequality written twice, which is precisely the situation this repository
 * already learned to distrust: `purge-preview-agreement.test.ts` exists because
 * a preview and a run that compute their own predicates describe different
 * events on the day one of them is edited.
 *
 * **The two failures are both silent, and they are opposite.** A listing wider
 * than the executor offers a button that answers `410 Gone` on a retraction the
 * page said was recoverable. A listing narrower than the executor hides an undo
 * that would have worked, on the last day it would have worked. Neither raises,
 * neither logs, and a user meets the first one exactly once — at the end of the
 * window, which is when they are most likely to be trying.
 *
 * So the boundary is walked rather than described: one millisecond either side
 * of the edge, and on the edge itself, with the listing and the executor asked
 * about the same instant in the same breath.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  FORGET_TTL_HOURS,
  forgetRecord,
  listRestorable,
  restorableSince,
  restoreForgotten,
} from '../../../src/mcp/tombstone.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const HOUR = 3600_000;
const AT = new Date('2026-06-10T00:00:00.000Z');

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('restorable_agree');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

beforeEach(async () => {
  await sql.unsafe(`
    DELETE FROM retraction;
    DELETE FROM severance;
    DELETE FROM chunk;
    DELETE FROM page;
  `);
});

async function forgetOnePageAt(ref: string, at: Date): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                       embedding_dimensions, chunker_version, normalizer_version, content_sha256)
     VALUES ($1, 'email', 'a document', $2, 'text-embedding-3-small',
             ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64))
     RETURNING page_id::text AS id`,
    [WORK, ref],
  )) as Array<{ id: string }>;
  const outcome = await forgetRecord(sql, {
    id: { kind: 'doc', key: rows[0]?.id ?? '' },
    grant: [WORK],
    now: at,
  });
  if (!outcome.ok) throw new Error('the fixture could not retract its own page');
  return outcome.deletedAt;
}

/** Both answers about one instant, asked of the two implementations. */
async function bothAnswers(
  deletedAt: string,
  now: Date,
  ttlHours?: number,
): Promise<{ listed: boolean; admitted: boolean }> {
  const listing = await listRestorable(sql, {
    now,
    ...(ttlHours === undefined ? {} : { ttlHours }),
  });
  const outcome = await restoreForgotten(sql, {
    deletedAt,
    now,
    ...(ttlHours === undefined ? {} : { ttlHours }),
  });
  return {
    listed: listing.retractions.some((entry) => Date.parse(entry.at) === Date.parse(deletedAt)),
    admitted: outcome.ok,
  };
}

describe('nothing is listed that would refuse, and nothing refuses that is listed', () => {
  test(
    'one millisecond inside the window, exactly on it, and one millisecond past',
    async () => {
      const deletedAt = await forgetOnePageAt('gmail:edge', AT);
      const edge = AT.getTime() + FORGET_TTL_HOURS * HOUR;

      // Inside: both say yes. This first call really does restore the rows —
      // the ledger row stays, because nothing has told it the restore happened,
      // and that is what keeps the remaining probes about arithmetic rather
      // than about state.
      const inside = await bothAnswers(deletedAt, new Date(edge - 1));
      expect(inside).toEqual({ listed: true, admitted: true });

      // On the edge: `restoreForgotten` refuses at `> ttl`, so equality is
      // still admitted — and the listing's `>=` has to agree with that choice
      // rather than with a rounder one.
      const on = await bothAnswers(deletedAt, new Date(edge));
      expect(on).toEqual({ listed: true, admitted: true });

      // Past: both say no. A listing that still offered it here is the 410 the
      // user meets at the worst possible moment.
      const past = await bothAnswers(deletedAt, new Date(edge + 1));
      expect(past).toEqual({ listed: false, admitted: false });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a caller-supplied window moves both edges together',
    async () => {
      // The parameter exists, so a test that only ever exercised the default
      // would leave the two free to disagree everywhere except at 72 hours.
      const deletedAt = await forgetOnePageAt('gmail:short', AT);
      const ttlHours = 6;
      const edge = AT.getTime() + ttlHours * HOUR;

      expect(await bothAnswers(deletedAt, new Date(edge), ttlHours)).toEqual({
        listed: true,
        admitted: true,
      });
      expect(await bothAnswers(deletedAt, new Date(edge + 1), ttlHours)).toEqual({
        listed: false,
        admitted: false,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the boundary function is the one the listing binds, and it is the executor\'s',
    () => {
      // The arithmetic itself, stated once so a future edit to either side has
      // something to fail against without a database.
      const now = new Date('2026-06-13T00:00:00.000Z');
      expect(restorableSince(now).toISOString()).toBe(
        new Date(now.getTime() - FORGET_TTL_HOURS * HOUR).toISOString(),
      );
      expect(restorableSince(now, 6).toISOString()).toBe(
        new Date(now.getTime() - 6 * HOUR).toISOString(),
      );
      // And it refuses the same nonsense the executor refuses, rather than
      // quietly collapsing the window to zero.
      expect(() => restorableSince(now, 0)).toThrow();
      expect(() => restorableSince(now, Number.NaN)).toThrow();
    },
  );
});
