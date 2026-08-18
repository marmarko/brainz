/**
 * The connector health recorder, in memory. Not a `*.test.ts` file.
 *
 * `PullHandlerDeps.health` is **required** rather than optional — its own
 * comment carries the argument, which is that the durable record of why a poll
 * failed is not a thing a deployment should be able to forget to wire. The cost
 * of that decision is that every construction of the handler has to say where
 * the attempt goes, and most of this suite does not care. This is what those
 * pass.
 *
 * **A collector rather than a no-op**, so a case that wants to assert on the
 * classification can, without a database: the mapping from "what the pull said"
 * to "what the record claims" is a pure function of the result, and the only
 * thing a real Postgres adds to that assertion is time.
 *
 * The end-to-end proof that the record reaches a database two other surfaces can
 * read is `test/worker/ingest-lanes.test.ts`, which wires the real
 * control-plane recorder. Neither test would catch the other's failure, which is
 * why both exist.
 *
 * Its own file rather than a section of `fixture.ts`: that file is the vendor
 * harness — a scripted HTTP transport and a scripted provider — and this is not
 * vendor-shaped at all.
 */

import type {
  ConnectorAttempt,
  ConnectorHealthRecorder,
} from '../../../src/ingest/pipedream/pull.ts';

export interface RecordingHealth extends ConnectorHealthRecorder {
  /** Every attempt the handler banked, in order. */
  readonly attempts: readonly ConnectorAttempt[];
}

export function createRecordingHealth(): RecordingHealth {
  const attempts: ConnectorAttempt[] = [];
  return {
    get attempts() {
      return attempts;
    },
    record(attempt) {
      attempts.push(attempt);
      return Promise.resolve();
    },
  };
}
