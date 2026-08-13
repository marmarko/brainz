/**
 * A paused connector, and the one place that decides what "paused" means.
 *
 * **Absence is the state, not a column.** `source_pause` (rung 7) holds a row
 * only while a source is paused. That is what makes the previous fleet release
 * — which has never heard of the table — behave identically: it reads no rows,
 * and no rows is exactly what "nothing is paused" looks like. A boolean column
 * would have needed a backfill, and rung 7's own comment explains why this
 * schema does not fabricate those.
 *
 * **It lives under `src/ingest/` rather than under `src/mcp/`** because the
 * reader is the pull path and the writer is a settings surface. Putting it with
 * the writer would make the poller import the MCP surface to answer a question
 * about its own cadence, which is the dependency direction that turns two
 * modules into one.
 */

import type { SQL } from 'bun';

import { isConnectorSource, type ConnectorSource } from './cursor.ts';

/**
 * Which surface authorised a pause. Mirrors rung 7's CHECK.
 *
 * Deliberately disjoint from `review_queue.closed_by`: nothing here is
 * `user_out_of_band`, because none of these channels is. A panel click and a
 * confirmation the connected agent prompted for are different events, and R12a
 * is the reason the difference is recorded rather than flattened.
 */
export const PAUSE_AUTHORITIES = ['panel', 'agent_confirmed', 'app'] as const;
export type PauseAuthority = (typeof PAUSE_AUTHORITIES)[number];

export function isPauseAuthority(value: string): value is PauseAuthority {
  return (PAUSE_AUTHORITIES as readonly string[]).includes(value);
}

/**
 * Every paused source, as the database has it.
 *
 * A row naming something that is no longer a connector is dropped rather than
 * returned: the caller's next move is to compare against a live source, and a
 * value that cannot match one is noise it would have to filter anyway. The
 * database's own CHECK makes this unreachable today; it is here so that
 * retiring a connector later does not make this function's contract a lie.
 */
export async function readPausedSources(sql: SQL): Promise<ConnectorSource[]> {
  const rows = (await sql`SELECT source FROM source_pause ORDER BY source`) as Array<{
    source: string;
  }>;
  return rows.map((row) => row.source).filter(isConnectorSource);
}

/**
 * Pause one source.
 *
 * Idempotent by the primary key: pausing an already-paused source refreshes
 * neither the timestamp nor the authority. That is the deliberate reading — the
 * pause is the event, and a second request to be in a state you are already in
 * is not a new event. Overwriting `paused_by` would let a weaker authority
 * silently relabel a stronger one's record.
 */
export async function pauseSource(
  sql: SQL,
  source: ConnectorSource,
  by: PauseAuthority,
): Promise<void> {
  await sql`
    INSERT INTO source_pause (source, paused_by)
    VALUES (${source}, ${by})
    ON CONFLICT (source) DO NOTHING
  `;
}

/** Resume one source. Removing the row is the whole of it; absence is running. */
export async function resumeSource(sql: SQL, source: ConnectorSource): Promise<void> {
  await sql`DELETE FROM source_pause WHERE source = ${source}`;
}
