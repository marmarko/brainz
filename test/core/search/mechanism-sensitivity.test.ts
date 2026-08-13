/**
 * Every probe must be sensitive to at least one mechanism it names.
 *
 * **A probe's `mechanisms` list is a claim, and until now nothing checked it.**
 * `test/evals/answerability.test.ts` checks that each id exists in the concepts
 * ledger and that its owning unit lands by U5 — which proves the *name* is real
 * and proves nothing about the probe. A query can name `stack.read-time-dedup`,
 * be graded on a metric dedup cannot move, and sit in the corpus forever looking
 * like evidence that dedup works.
 *
 * So this file turns each named mechanism off and re-grades the probe on **the
 * metric its floor actually reads** — Hit@1 for the title-substring and alias
 * families, the dilution metric for the dilution family, nDCG@10 for the rest.
 * A probe whose graded value does not move for any mechanism it names is not
 * grading those mechanisms, whatever its evidence sentence says.
 *
 * **The insensitive probes are listed, not hidden**, and the assertion is a
 * whole-set equality. Three ways that stays honest:
 *
 *   - A probe that becomes insensitive — because a stage stopped mattering, or
 *     because its mechanism list grew a claim it cannot support — is red.
 *   - A probe that becomes sensitive and is still listed is red, so a fix has to
 *     shorten the list rather than leave it.
 *   - A mechanism with no off-switch here is a mechanism this file cannot grade,
 *     and the mapping is asserted to cover every id the corpus uses. Silently
 *     skipping one would let a probe be "sensitive" because nothing was turned
 *     off at all.
 *
 * **Turning a stage off means turning it off, not down.** Each switch below
 * removes the stage's input or zeroes its weight through the shipped option —
 * the same knobs `dedup.test.ts` and `boosts.test.ts` use for their mutations —
 * so a "sensitive" verdict is a measurement of the shipped stage rather than of
 * a test-only branch.
 */

import { describe, expect, test } from 'bun:test';

import { CORPUS } from '../../../evals/corpus.ts';
import { loadEmbeddings } from '../../../evals/embeddings.ts';
import { corpusTexts } from '../../../evals/corpus.ts';
import type { FixtureQuery } from '../../../evals/corpus.ts';
import { dilutionHitAt, hitAt, ndcgAt } from '../../../evals/metrics.ts';
import { MANIFEST_PATH } from '../../../evals/regenerate-embeddings.ts';
import { NDCG_CUTOFF, RESULT_LIMIT, type RankerContext } from '../../../evals/run.ts';
import { composeRanking } from '../../../src/core/search/pipeline.ts';
import type { RankingPlan } from '../../../src/core/search/intent.ts';
import type { RecallOutcome } from '../../../src/core/search/types.ts';
import { RANK_LIMIT, recallOverCorpus } from './corpus-ranker.ts';

const manifest = await Bun.file(`${import.meta.dir}/../../../${MANIFEST_PATH}`).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));
const context: RankerContext = { corpus: CORPUS, embeddings };

/** How one mechanism is removed from the composed run. */
interface Switch {
  /** Rewrite the recall outcome — for the stages that live before fusion. */
  readonly outcome?: (outcome: RecallOutcome & { plan: RankingPlan }) => RecallOutcome & {
    plan: RankingPlan;
  };
  /** Extra `composeRanking` request fields — for the stages that take options. */
  readonly request?: Record<string, unknown>;
}

const withoutArm = (arm: string): Switch => ({
  outcome: (outcome) => ({
    ...outcome,
    arms: outcome.arms.filter((entry) => entry.arm !== arm),
  }),
});

const withPlan = (patch: Partial<RankingPlan>): Switch => ({
  outcome: (outcome) => ({ ...outcome, plan: { ...outcome.plan, ...patch } }),
});

/**
 * One off-switch per mechanism the corpus names.
 *
 * `stack.shared-normalizer` is the one mechanism with no switch and it is
 * declared rather than omitted: the normalizer is not a stage with a weight, it
 * is what every stage tokenises through, so "off" would mean a second
 * tokenisation rather than an absent one. A probe naming it must earn its
 * sensitivity from another mechanism, which is a stricter requirement than any
 * switch would have been.
 */
const SWITCHES: Readonly<Record<string, Switch | null>> = {
  'stack.keyword-arm': withoutArm('fts'),
  'stack.graph-arm': withoutArm('graph'),
  'stack.title-phrase-boost': withPlan({ exactMatchBoost: 0 }),
  'stack.recency-decay': withPlan({ recencyTilt: 0 }),
  // Both alias ids remove the ladder's injection: the ladder is the mechanism
  // and the resolution ladder is how it picks rungs, and neither can be shown to
  // matter by an assertion about the other.
  'stack.alias-hop': { outcome: (outcome) => ({ ...outcome, aliasLadder: [] }) },
  'imp.entity-resolution-ladder': { outcome: (outcome) => ({ ...outcome, aliasLadder: [] }) },
  'stack.read-time-dedup': {
    request: {
      dedup: {
        chunksPerPage: Number.MAX_SAFE_INTEGER,
        // Above 1, so no pair of chunks can ever reach it.
        jaccardThreshold: 2,
        pageTypeCap: 1,
        finalChunksPerPage: Number.MAX_SAFE_INTEGER,
      },
    },
  },
  // Flattening RRF's k to a very large value makes every arm's contribution
  // near-identical regardless of rank, which is fusion doing nothing.
  'stack.rrf-fusion': withPlan({ rrfK: 1_000_000 }),
  'stack.source-type-priors': withPlan({ calendarLift: 0 }),
  'stack.corroboration-boost': { request: { boosts: { corroborationBoost: 0 } } },
  'stack.shared-normalizer': null,
};

function rankWith(query: FixtureQuery, off: Switch | undefined): readonly string[] {
  const { outcome, now } = recallOverCorpus(query, context, { limit: RANK_LIMIT });
  const patched = off?.outcome === undefined ? outcome : off.outcome(outcome);
  const response = composeRanking(
    {
      query: query.text,
      limit: Math.min(RANK_LIMIT, RESULT_LIMIT),
      now,
      plan: patched.plan,
      ...(off?.request ?? {}),
    },
    patched,
  );
  return response.results.map((result) => result.candidate.id);
}

/** The number this probe's own family floor reads. All-or-nothing outside `general`. */
function floorValue(query: FixtureQuery, ranked: readonly string[]): number {
  switch (query.family) {
    case 'title_substring':
    case 'alias':
      return hitAt(ranked, query.answers, 1);
    case 'dilution':
      return dilutionHitAt(ranked, query.requiredGroups ?? [], (id) => CORPUS.groupOf(id), 3);
    case 'general':
      return ndcgAt(ranked, CORPUS.relevanceFor(query.id), NDCG_CUTOFF);
  }
}

/**
 * The probe's outcome, as the pair of numbers it actually moves.
 *
 * **Both, and the nDCG half is what makes the guard mean something.** The three
 * family floors are all-or-nothing: a probe that ranks its answer first with a
 * comfortable margin keeps Hit@1 at 1 when any single stage is removed, so a
 * guard reading only the floor metric flags *every* passing probe in those
 * families — 44 of 77 — and says nothing about any of them. Every probe also
 * feeds a per-question-type nDCG@10 floor, and that one is continuous: it moves
 * whenever the mechanism changed the ranking at all. So "insensitive" here means
 * the strong thing — removing the mechanism changed nothing about this probe's
 * ranking, at any position, not merely nothing about a threshold.
 *
 * The weaker per-floor finding is not discarded; it is pinned by name at the
 * foot of this file, where it is three assertions rather than a churning list.
 */
function outcomeOf(query: FixtureQuery, ranked: readonly string[]): string {
  const ndcg = ndcgAt(ranked, CORPUS.relevanceFor(query.id), NDCG_CUTOFF);
  return `${floorValue(query, ranked).toFixed(6)}|${ndcg.toFixed(6)}`;
}

interface Insensitive {
  readonly queryId: string;
  readonly mechanisms: readonly string[];
}

/**
 * Compose several switches into one.
 *
 * **The union is why this guard measures probes rather than robustness.** A
 * probe answered redundantly by two of the mechanisms it names flips for
 * neither one alone, and calling that "does not grade them" would flag half the
 * corpus for being well answered. Turning *everything it claims* off is the
 * question with a meaning: if the graded value is unchanged with none of its
 * named mechanisms running, the claim is empty.
 */
function combine(switches: readonly Switch[]): Switch {
  return {
    outcome: (outcome) =>
      switches.reduce((current, one) => (one.outcome === undefined ? current : one.outcome(current)), outcome),
    request: Object.assign({}, ...switches.map((one) => one.request ?? {})) as Record<string, unknown>,
  };
}

const insensitive: Insensitive[] = [];
const gradable = new Set<string>();

for (const query of CORPUS.queries) {
  const baseline = outcomeOf(query, rankWith(query, undefined));
  const switches: Switch[] = [];

  for (const mechanism of query.mechanisms) {
    const off = SWITCHES[mechanism];
    if (off === null || off === undefined) continue;
    gradable.add(mechanism);
    switches.push(off);
  }
  if (switches.length === 0) continue;

  const moved =
    switches.some((off) => outcomeOf(query, rankWith(query, off)) !== baseline) ||
    outcomeOf(query, rankWith(query, combine(switches))) !== baseline;

  if (!moved) insensitive.push({ queryId: query.id, mechanisms: query.mechanisms });
}

/**
 * Probes whose entire top-10 ordering is unchanged with every mechanism they
 * name turned off.
 *
 * Each entry is a **finding**, not an exemption, and the list reads as one
 * sentence: *these probes are answered by a stage they do not name.*
 *
 *   - **Ten of the twenty title-substring probes name `stack.title-phrase-boost`
 *     and do not grade it.** They are answered by the alias ladder's
 *     `exact_title` rung, which injects the page whose title *is* the query
 *     before any boost runs — and which none of them names. The boost still
 *     earns its place on the ten probes where a body-text decoy outranks the
 *     titled page; on these ten the rung got there first. The honest reading is
 *     that the family measures "the user named a document and got it", and that
 *     two different stages can deliver that.
 *   - **`q-al-01` and `q-al-06` name the alias hop and are answered without
 *     it.** "Sam's current title" and the mail address both reach their answer
 *     through the lexical arms once resolution has happened; what the ladder's
 *     *injection* adds is nothing they need. Resolution is upstream of the
 *     ladder and is not switchable here, which the switch table says out loud.
 *   - **`q-al-08` is the probe the gate also defers**, for the same underlying
 *     reason: with synthetic vectors nothing lifts its answer to rank 1, so
 *     nothing that lifts it a little can be measured either.
 *   - **The seven `general` probes** are relational and context-fenced questions
 *     whose answer is pinned by the fence and the entity resolution rather than
 *     by the arms and boosts they name.
 *
 * The set is asserted whole. A probe that becomes insensitive is a stage that
 * stopped mattering; a probe that becomes sensitive and is still listed is a
 * finding somebody fixed and did not delete. Both are the same edit, and both
 * are red until it happens.
 */
const KNOWN_INSENSITIVE: Record<string, string[]> = {
  'q-ts-05-verdant-overview': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-06-tessellate-memo': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-08-firmware-hotfix': [
    'stack.title-phrase-boost',
    'stack.keyword-arm',
    'stack.read-time-dedup',
  ],
  'q-ts-09-leadership-change': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-10-brackish-followon': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-11-dana-who-she-is': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-12-membership-renewal': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-13-quarterly-attendees': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-ts-19-pilot-outcome': [
    'stack.title-phrase-boost',
    'stack.recency-decay',
    'stack.keyword-arm',
  ],
  'q-ts-20-design-review-notes': ['stack.title-phrase-boost', 'stack.keyword-arm'],
  'q-al-01-sam-current-title': [
    'stack.alias-hop',
    'stack.recency-decay',
    'imp.entity-resolution-ladder',
  ],
  'q-al-06-sam-email': [
    'stack.alias-hop',
    'stack.shared-normalizer',
    'imp.entity-resolution-ladder',
  ],
  'q-al-08-tosh-wants-changed': ['stack.alias-hop', 'imp.entity-resolution-ladder'],
  'q-ge-06-saltmarsh-part-of': ['stack.graph-arm', 'stack.title-phrase-boost'],
  'q-ge-07-sam-collaborator': ['stack.graph-arm', 'imp.entity-resolution-ladder'],
  'q-ge-10-series-a-sponsor': [
    'stack.keyword-arm',
    'stack.graph-arm',
    'stack.corroboration-boost',
  ],
  'q-tm-04-sam-still-head-of-eng': ['stack.recency-decay', 'stack.keyword-arm'],
  'q-cf-02a-supplier-list-personal': ['stack.keyword-arm', 'stack.title-phrase-boost'],
  'q-cf-03a-third-september-personal': ['stack.keyword-arm', 'stack.source-type-priors'],
  'q-cf-03b-third-september-work': ['stack.keyword-arm', 'stack.source-type-priors'],
};

/**
 * Mechanisms whose off-switch changes **no ranking anywhere in the corpus**.
 *
 * A switch that moves nothing is usually a broken switch, so the default
 * expectation is that this map is empty. The one entry is not a broken switch —
 * it is the fixture unable to exercise a stage:
 *
 *   - **`stack.corroboration-boost` cannot fire on this corpus at all.** R12a's
 *     boost is gated on an attestation the *external sender cannot also write* —
 *     `user_out_of_band` or `internal`, and `arms.ts:CHANNEL_BY_SOURCE_TYPE` is
 *     deliberately incapable of producing either, because a source type that
 *     implied corroboration would be a way to promote a claim by choosing where
 *     it arrived from. The fixture derives every attestation from `source_type`,
 *     so no row in it is corroborated and the term is identically zero. Four
 *     probes name the mechanism; none of them grades it, and none of them can
 *     until the corpus carries an attestation kind U12/U14/U15 create.
 *     `test/core/search/corroboration.test.ts` is where the rule is measured.
 */
const INERT_IN_THIS_FIXTURE: Record<string, string> = {
  'stack.corroboration-boost':
    'no fixture row carries a user_out_of_band or internal attestation, and no source_type can imply one (R12a)',
};

describe('every probe grades at least one mechanism it names', () => {
  test('the insensitive probes are exactly the ones recorded here', () => {
    const actual = Object.fromEntries(
      insensitive.map((entry) => [entry.queryId, [...entry.mechanisms]]),
    );
    expect(actual).toEqual(KNOWN_INSENSITIVE);
  });

  test('the guard has something to say: most probes ARE sensitive', () => {
    // A guard that found every probe insensitive would be measuring its own
    // switches rather than the stack, and one that found none would be reading
    // a metric too coarse to move. Both directions are asserted.
    expect(insensitive.length).toBeGreaterThan(0);
    expect(insensitive.length).toBeLessThan(CORPUS.queries.length / 3);
  });

  test('every mechanism the corpus names has an off-switch or an explicit refusal', () => {
    const named = new Set(CORPUS.queries.flatMap((query) => [...query.mechanisms]));
    for (const mechanism of named) {
      // `in`, not a truthiness test: `null` is the declared refusal and must not
      // read the same as a missing entry.
      expect(Object.hasOwn(SWITCHES, mechanism)).toBe(true);
    }
    // And no switch exists for a mechanism nothing names, which would be a
    // switch nobody could have measured.
    for (const mechanism of Object.keys(SWITCHES)) expect(named.has(mechanism)).toBe(true);
  });

  test('the switches that move nothing at all are exactly the ones recorded', () => {
    // The mutation this kills is a switch that does nothing — a typo'd option
    // key, a plan field the stage does not read — which would make every probe
    // naming it look insensitive, or worse, make an insensitive probe look fine
    // because a *different* switch carried it. And the one genuine finding it
    // surfaced is worth more than the mutation: see INERT_IN_THIS_FIXTURE.
    const inert = [...gradable]
      .filter((mechanism) => {
        const off = SWITCHES[mechanism];
        return !CORPUS.queries.some((query) => {
          if (!query.mechanisms.includes(mechanism)) return false;
          const before = rankWith(query, undefined).join(',');
          return rankWith(query, off ?? undefined).join(',') !== before;
        });
      })
      .sort();
    expect(inert).toEqual(Object.keys(INERT_IN_THIS_FIXTURE).sort());
  });
});

/**
 * The weaker finding, pinned by name instead of by list.
 *
 * A probe can move the ranking without moving the number its *family floor*
 * reads, and the three cases below are the ones an earlier pass found by hand.
 * They are asserted rather than described, so that a stack change which makes
 * one of them grade its mechanism has to come here and say so — and so that
 * nobody reads the corpus's `mechanisms` field as evidence these three floors
 * measure these three stages.
 */
describe('three probes name a mechanism their own floor cannot see', () => {
  const probe = (id: string): FixtureQuery => {
    const query = CORPUS.queriesById.get(id);
    if (query === undefined) throw new Error(`no such query: ${id}`);
    return query;
  };

  test('neither dilution probe grades the dedup it names', () => {
    // R6 defines the dilution metric on the **raw** ranking on purpose: scoring
    // a de-duplicated list would measure the harness's dedup instead of the
    // stack's. So dedup is exactly the stage this metric is built not to see,
    // and both probes name it anyway. `test/core/search/dedup.test.ts` is where
    // the four layers are actually measured.
    const off = SWITCHES['stack.read-time-dedup'];
    for (const id of ['q-di-09-pilot-brief', 'q-di-10-pilot-went']) {
      const query = probe(id);
      expect(query.mechanisms).toContain('stack.read-time-dedup');
      expect(floorValue(query, rankWith(query, off ?? undefined))).toBe(
        floorValue(query, rankWith(query, undefined)),
      );
    }
  });

  test('q-al-08 names the alias hop and its Hit@1 does not move when the ladder goes', () => {
    // The ladder nominates the answer — it is on the mention rung — and the
    // answer loses anyway, so removing the nomination changes a rank nobody was
    // reading. Same probe, same underlying cause as the gate's deferral.
    const query = probe('q-al-08-tosh-wants-changed');
    expect(query.mechanisms).toContain('stack.alias-hop');
    const off = SWITCHES['stack.alias-hop'];
    expect(floorValue(query, rankWith(query, off ?? undefined))).toBe(
      floorValue(query, rankWith(query, undefined)),
    );
  });
});
