/**
 * The generated half of the hazard ledger, kept honest.
 *
 * `docs/porting-hazards.md` is now part hand-written and part generated, and a
 * committed generated artifact that nobody re-derives is a hazard in its own
 * right — it is upstream's own `check-eval-glossary-fresh.sh` mechanism, which is
 * why `src/upstream/hazard-map.ts` cites *this file* as its brainz counterpart.
 * So: regenerate, compare, fail on drift.
 *
 * Three further things are checked here, each closing a way a card could keep
 * saying something that stopped being true:
 *
 *   - **The quotes still exist upstream.** Every `unported` disposition carries a
 *     verbatim fragment of the guard's own header. Upstream rewrites headers; a
 *     card still quoting a rationale that is gone is a card asserting something
 *     nobody checked. Read at the pinned commit, so the check is deterministic.
 *   - **The inventory receipt matches a fresh sweep.** `upstream/gbrain-guards.json`
 *     is the committed evidence for the counts this unit reports. It is worth
 *     exactly as much as the guarantee that it was not hand-edited.
 *   - **The `not-applicable` preconditions still hold.** "brainz has no CLI" is a
 *     claim about this repo, not an eternal truth. Where it is cheaply checkable
 *     it is checked, so the disposition expires when the property does rather
 *     than when somebody remembers.
 *
 * The upstream-reading halves skip with a reason when no gbrain checkout is
 * present, which is the discipline `test/hazards/` already uses. The
 * regeneration halves need no checkout and always run.
 */

import { describe, expect, test } from 'bun:test';

import { parsePin } from '../../evals/conformance/pin.ts';
import { GUARD_DISPOSITIONS } from '../../src/upstream/hazard-map.ts';
import {
  guardFilesIn,
  renderCards,
  renderStubs,
  spliceCards,
  sweep,
  sweptCards,
} from '../../src/upstream/hazard-sweep.ts';
import { defaultCheckoutPath, openCheckout } from '../../src/upstream/gbrain-repo.ts';
import { GUARD_INVENTORY_PATH, HAZARDS_DOC_PATH, SWEPT_STUBS_PATH } from '../../src/upstream/watch.ts';

const PIN = parsePin(await Bun.file('upstream/gbrain.pin').text());
const CHECKOUT = defaultCheckoutPath();

const checkout = (() => {
  try {
    return openCheckout({ path: CHECKOUT, commit: PIN.commit });
  } catch {
    return undefined;
  }
})();

describe('the committed generated artifacts are what the generator produces', () => {
  test('the swept-card region of docs/porting-hazards.md is fresh', async () => {
    const committed = await Bun.file(HAZARDS_DOC_PATH).text();
    expect(spliceCards(committed, renderCards(sweptCards()))).toBe(committed);
  });

  test('the skipped stubs are fresh', async () => {
    expect(await Bun.file(SWEPT_STUBS_PATH).text()).toBe(renderStubs(sweptCards()));
  });

  test('there is something to be fresh about — the generator is not producing nothing', () => {
    expect(sweptCards().length).toBeGreaterThan(5);
    expect(renderStubs(sweptCards())).toContain('test.skip(');
  });
});

/**
 * Preconditions a `not-applicable` disposition may name. Each is a claim about
 * *this* repo that stops being true if somebody changes it.
 */
const PRECONDITIONS: Readonly<Record<string, () => Promise<boolean>>> = {
  'no-package-bin': async () => {
    const pkg = JSON.parse(await Bun.file('package.json').text()) as Record<string, unknown>;
    return pkg['bin'] === undefined;
  },
  'no-package-exports': async () => {
    const pkg = JSON.parse(await Bun.file('package.json').text()) as Record<string, unknown>;
    return pkg['exports'] === undefined;
  },
};

describe('a not-applicable disposition expires with its reason', () => {
  const withPrecondition = Object.entries(GUARD_DISPOSITIONS).filter(
    (entry): entry is [string, { kind: 'not-applicable'; note: string; precondition: string }] =>
      entry[1].kind === 'not-applicable' && entry[1].precondition !== undefined,
  );

  test('at least one disposition names a checkable precondition', () => {
    // Without this the loop below is a statement about an empty list.
    expect(withPrecondition.length).toBeGreaterThan(0);
  });

  test('every named precondition is one this file knows how to check', () => {
    for (const [, disposition] of withPrecondition) {
      expect(Object.keys(PRECONDITIONS)).toContain(disposition.precondition);
    }
  });

  test('every named precondition still holds', async () => {
    for (const [guard, disposition] of withPrecondition) {
      const holds = await PRECONDITIONS[disposition.precondition]?.();
      expect({ guard, holds }).toEqual({ guard, holds: true });
    }
  });
});

describe.if(checkout !== undefined)('against the pinned gbrain build', () => {
  const pinned = checkout;
  if (pinned === undefined) throw new Error('unreachable');

  test('every quoted rationale is still in the guard it was quoted from', () => {
    // `ported` carries a quote too, and it is the same claim: upstream's own
    // words at the pin. A card that was closed here still quotes them, so it is
    // held to the same freshness rule.
    const unported = Object.entries(GUARD_DISPOSITIONS).filter(
      ([, entry]) => entry.kind === 'unported' || entry.kind === 'ported',
    );
    expect(unported.length).toBeGreaterThan(0);

    for (const [guard, disposition] of unported) {
      if (disposition.kind !== 'unported' && disposition.kind !== 'ported') continue;
      const source = pinned.readFile(guard);
      expect({ guard, quoted: source.includes(disposition.quote) }).toEqual({ guard, quoted: true });
    }
  });

  test('the committed guard inventory matches a fresh sweep at the pin', async () => {
    const guards = guardFilesIn(pinned.listTree('scripts'));
    const fresh = sweep(guards);
    const committed = JSON.parse(await Bun.file(GUARD_INVENTORY_PATH).text()) as {
      counts: Record<string, number>;
      guards: string[];
    };

    expect(committed.guards).toEqual(guards);
    expect(committed.counts).toEqual(fresh.counts as unknown as Record<string, number>);
    expect(fresh.ok).toBe(true);
  });

  test('the sweep found real guards, so the agreement above is not between two empties', () => {
    expect(guardFilesIn(pinned.listTree('scripts')).length).toBeGreaterThan(30);
  });
});

describe.if(checkout === undefined)('no gbrain checkout on this machine', () => {
  test.skip(
    `quote and inventory freshness skipped — no gbrain checkout at ${CHECKOUT} containing ${PIN.commit}.`,
    () => {},
  );
});
