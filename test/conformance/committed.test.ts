/**
 * The two committed artifacts the conformance gate reads, checked by `bun test`.
 *
 * Both are hand-edited JSON that only `bun run conformance` would otherwise
 * parse — and that command needs a Postgres, a network fetch of a different
 * project, and several minutes. A typo in either would therefore be found by
 * whoever next ran the slow job, which in a repository where the gate is
 * currently self-skipping could be a long time. So the parsers run here, on
 * every PR, over the real files.
 *
 * The pair also has to agree: the delta binds itself to the gbrain commit it was
 * observed against, and a pin advanced without re-observing the delta is the
 * exact drift `assertDelta` reports as `pin_mismatch`. Catching it in the unit
 * suite means the two files cannot be edited apart.
 */

import { describe, expect, test } from 'bun:test';

import { PARTIAL_PROFILE } from '../../evals/conformance/delta.ts';
import { loadPin } from '../../evals/conformance/gbrain.ts';
import { DELTA_PATH, loadDelta } from '../../evals/conformance/run.ts';
import { PIN_PATH } from '../../evals/conformance/pin.ts';

describe(`${PIN_PATH} and ${DELTA_PATH}`, () => {
  const pin = loadPin();
  const delta = loadDelta();

  test('the pin parses and names a full commit sha', () => {
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.tag.length).toBeGreaterThan(0);
    expect(pin.repo.startsWith('https://')).toBe(true);
  });

  test('the pin says who may advance it and under what authority', () => {
    expect(pin.advanced_by).toContain('U19');
  });

  test('the delta parses and declares the partial profile', () => {
    expect(delta.profile).toBe(PARTIAL_PROFILE);
    expect(delta.protocol_version).toBe(1);
  });

  test('the delta was observed against the pinned build — the two files move together', () => {
    expect(delta.gbrain_commit).toBe(pin.commit);
  });

  test('a blocked delta carries its blocker and publishes no deviation it never saw', () => {
    if (delta.status === 'blocked') {
      expect(delta.blocker?.kind.length ?? 0).toBeGreaterThan(0);
      expect(delta.blocker?.detail.length ?? 0).toBeGreaterThan(0);
      expect(delta.deviations).toEqual([]);
    } else {
      expect(delta.blocker).toBeUndefined();
    }
  });

  test('every published deviation carries a reason', () => {
    for (const deviation of delta.deviations) {
      expect(deviation.reason.trim().length).toBeGreaterThan(0);
    }
  });
});
