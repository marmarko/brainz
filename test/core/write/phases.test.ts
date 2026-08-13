/**
 * The sync/async split's *guard*, tested directly.
 *
 * `phases.ts` says the split "is enforced" and hands back a recorder that
 * refuses a run which skipped a synchronous phase or performed a deferred one
 * inline. Every other test in this suite reads the recorder's **output** — the
 * `phases` array on the receipt — which proves the happy path recorded the right
 * sequence and proves nothing at all about the refusal. Delete the body of
 * `assertComplete` and the whole suite stays green: the guard that enforces this
 * unit's central contract was itself the one thing nothing checked.
 *
 * That is the failure mode this file exists for, and it generalises. A guard is
 * only a guard if something has watched it fire; otherwise it is a comment with
 * a function signature. So each assertion below drives the recorder into the
 * state it is supposed to refuse, and requires the refusal.
 */

import { describe, expect, test } from 'bun:test';

import {
  ASYNC_PHASES,
  PhaseOrderError,
  SYNC_PHASES,
  createPhaseRecorder,
  type SyncPhase,
} from '../../../src/core/write/phases.ts';

describe('the recorder refuses a run that did not do the synchronous half', () => {
  test('a complete run in the declared order is accepted', () => {
    const recorder = createPhaseRecorder();
    for (const phase of SYNC_PHASES) recorder.enter(phase);
    expect(() => recorder.assertComplete()).not.toThrow();
    expect(recorder.ran).toEqual([...SYNC_PHASES]);
  });

  test('a run that skipped reconciliation cannot report success', () => {
    // The one that matters: link extraction is sub-second and the graph arm is
    // asked about what the user just said. Dropping it changes no error and no
    // result shape — "who did I just say Alice works with" simply answers wrong
    // for a while, which is a bug report nobody can reproduce.
    const recorder = createPhaseRecorder();
    for (const phase of SYNC_PHASES) {
      if (phase === 'reconcile_edges') continue;
      recorder.enter(phase);
    }
    expect(() => recorder.assertComplete()).toThrow(PhaseOrderError);
  });

  test('every synchronous phase is individually required', () => {
    for (const skipped of SYNC_PHASES) {
      const recorder = createPhaseRecorder();
      for (const phase of SYNC_PHASES) {
        if (phase === skipped) continue;
        recorder.enter(phase);
      }
      expect(() => recorder.assertComplete(), skipped).toThrow(PhaseOrderError);
    }
  });

  test('the declared order is part of the contract, not just the set', () => {
    // `reconcile_edges` before the facts are written asks "is this edge still
    // implied" of a fact set that does not exist yet — the ordering comment in
    // `commitWrite` is load-bearing, so the recorder has to hold it.
    const recorder = createPhaseRecorder();
    const reordered: SyncPhase[] = [...SYNC_PHASES].reverse();
    for (const phase of reordered) recorder.enter(phase);
    expect(() => recorder.assertComplete()).toThrow(PhaseOrderError);
  });

  test('an empty run is refused rather than trivially complete', () => {
    expect(() => createPhaseRecorder().assertComplete()).toThrow(PhaseOrderError);
  });
});

describe('the recorder refuses deferred work done inline', () => {
  test('every declared async phase is rejected at the door', () => {
    for (const phase of ASYNC_PHASES) {
      const recorder = createPhaseRecorder();
      expect(() => recorder.enter(phase as unknown as SyncPhase), phase).toThrow(PhaseOrderError);
      // ...and it left no trace, so a caught throw cannot fake a complete run.
      expect(recorder.ran).toEqual([]);
    }
  });

  test('a phase nobody declared is rejected too', () => {
    const recorder = createPhaseRecorder();
    expect(() => recorder.enter('rerank' as unknown as SyncPhase)).toThrow(PhaseOrderError);
  });

  test('the two sides are disjoint, so "which side is this on" has one answer', () => {
    for (const phase of ASYNC_PHASES) {
      expect((SYNC_PHASES as readonly string[]).includes(phase)).toBe(false);
    }
  });
});
