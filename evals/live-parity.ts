/**
 * `bun run eval:live-parity` — the scheduled, secret-gated job that watches the
 * two read-path model stages the blocking tier structurally cannot see
 * (U7 approach step 7; Gap #16 in the plan's audit).
 *
 * **The gap, stated exactly.** The blocking tier is deterministic *because* the
 * embeddings and cross-encoder scores are committed. So it grades the consumers
 * of those numbers and never the invocations that produce them. Four concrete
 * changes ship green through it while real recall degrades:
 *
 *   - a swapped asymmetric prefix (a query encoded with the document input type);
 *   - a changed `dimensions` parameter;
 *   - a client-side truncation that skips re-normalisation — the vector is the
 *     right width and no longer unit length, which changes distance semantics
 *     under an inner-product operator with no error anywhere (KTD8 pins the
 *     mechanism to the API parameter for precisely this reason);
 *   - a broken rerank input template.
 *
 * This job re-embeds a sample and re-scores a sample **through the production
 * `src/ai/` path** and fails on divergence from the committed values beyond a
 * stated tolerance.
 *
 * **It refuses rather than reporting a comparison it did not make.** Today the
 * committed manifest carries zero provider-sourced vectors (no embedding
 * provider is reachable from this environment) and no cross-encoder scores exist
 * at all — they arrive with U12. A job that returned success having compared
 * nothing would be a stronger version of the exact defect it exists to catch, so
 * an empty sample is a violation and the command exits non-zero. The *workflow*
 * decides whether to invoke it; the command never lies about what it compared.
 *
 * **The tolerance is committed data with a rationale**, in
 * `evals/live-parity-tolerance.json`, the way `evals/gates.ts` carries R6a's
 * margins as data. A threshold living as a constant in the file that reads it is
 * a knob, and a knob loosens.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CORPUS, corpusTexts } from './corpus.ts';
import { cosine, loadEmbeddings, type EmbeddingIndex, type Encoding } from './embeddings.ts';
import { MANIFEST_PATH } from './regenerate-embeddings.ts';

export const TOLERANCE_PATH = 'evals/live-parity-tolerance.json';

export interface ParityTolerance {
  /** `1 - cos(committed, fresh)`. Above it, the encoders are not the same encoder. */
  readonly maxCosineDistance: number;
  /** Largest per-component absolute difference. Catches a shape change a cosine can absorb. */
  readonly maxComponentDelta: number;
  /** How far `‖v‖` may sit from 1 before the vector is not a normalised embedding. */
  readonly unitNormEpsilon: number;
  /** Largest absolute cross-encoder score difference. */
  readonly maxScoreDelta: number;
  readonly rationale: string;
}

export type ParityViolationKind =
  | 'no_committed_provider_vectors'
  | 'no_committed_rerank_scores'
  | 'missing_response'
  | 'dimension_mismatch'
  | 'non_finite'
  | 'not_unit_norm'
  | 'divergence'
  | 'model_mismatch';

export interface ParityViolation {
  readonly kind: ParityViolationKind;
  readonly detail: string;
}

export interface ParityResult {
  readonly passed: boolean;
  readonly violations: readonly ParityViolation[];
  /** How many committed values were actually compared against a fresh one. */
  readonly compared: number;
}

export interface ParitySample {
  readonly id: string;
  readonly encoding: Encoding;
  /** The model that produced the committed vector. */
  readonly model: string;
  readonly dimensions: number;
  readonly vector: Float32Array;
}

export interface ParityResponse {
  readonly id: string;
  readonly encoding: Encoding;
  readonly model?: string;
  readonly vector: readonly number[];
}

export interface RerankSample {
  readonly queryId: string;
  readonly candidateId: string;
  readonly model: string;
  readonly score: number;
}

/**
 * The ceiling on `maxCosineDistance`, in the parser rather than in prose.
 *
 * A swapped asymmetric encoding — the perturbation this job exists to catch —
 * moves a fixture vector by roughly 0.04 cosine distance under U7's own encoder
 * (`ENCODING_WEIGHT` is 0.15 of a unit-length rotation). A tolerance at or above
 * that would let the failure through, and a gate that admits its own motivating
 * case is not a looser gate, it is no gate. Anything wanting a wider window has
 * to argue for it here, where the reason is visible, rather than by editing a
 * number in a data file.
 */
const MAX_ALLOWED_COSINE_DISTANCE = 0.02;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${TOLERANCE_PATH} ${name} must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseTolerance(text: string): ParityTolerance {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error(`${TOLERANCE_PATH} is not a JSON object`);

  const maxCosineDistance = positiveFinite(raw['maxCosineDistance'], 'maxCosineDistance');
  if (maxCosineDistance > MAX_ALLOWED_COSINE_DISTANCE) {
    throw new Error(
      `${TOLERANCE_PATH} maxCosineDistance is ${maxCosineDistance}, above the ${MAX_ALLOWED_COSINE_DISTANCE} ceiling; ` +
        'a swapped asymmetric encoding moves a vector by less than that, so this value would admit the failure the job exists to catch',
    );
  }
  const rationale = raw['rationale'];
  if (typeof rationale !== 'string' || rationale.trim().length < 80) {
    throw new Error(`${TOLERANCE_PATH} rationale is missing or too short — an unexplained threshold is a knob`);
  }

  return {
    maxCosineDistance,
    maxComponentDelta: positiveFinite(raw['maxComponentDelta'], 'maxComponentDelta'),
    unitNormEpsilon: positiveFinite(raw['unitNormEpsilon'], 'unitNormEpsilon'),
    maxScoreDelta: positiveFinite(raw['maxScoreDelta'], 'maxScoreDelta'),
    rationale,
  };
}

export function loadTolerance(): ParityTolerance {
  return parseTolerance(readFileSync(fileURLToPath(new URL(`../${TOLERANCE_PATH}`, import.meta.url)), 'utf8'));
}

/**
 * The committed vectors this job can compare against: provider-sourced rows only.
 *
 * A synthetic row is a deterministic lexical projection of committed text
 * (`evals/embeddings.ts`), not a model output — re-embedding it through the
 * production path would compare a hash function against an encoder and fail
 * every time, which is not a parity signal. So they are excluded, and the empty
 * result becomes a refusal upstream rather than a smaller comparison.
 */
export function committedProviderSamples(manifest: string, index: EmbeddingIndex): ParitySample[] {
  const samples: ParitySample[] = [];
  for (const line of manifest.split('\n')) {
    if (line.trim().length === 0) continue;
    const row: unknown = JSON.parse(line);
    if (!isObject(row) || row['source'] !== 'provider') continue;
    const id = row['id'];
    const encoding = row['encoding'];
    const model = row['model'];
    const dimensions = row['dimensions'];
    if (typeof id !== 'string' || typeof model !== 'string' || typeof dimensions !== 'number') {
      throw new Error(`the manifest carries a provider row that is not readable: ${line.slice(0, 120)}`);
    }
    if (encoding !== 'query' && encoding !== 'document') {
      throw new Error(`the manifest carries a provider row with encoding ${JSON.stringify(encoding)}`);
    }
    samples.push({ id, encoding, model, dimensions, vector: index.get(id, encoding) });
  }
  return samples;
}

function norm(vector: readonly number[]): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}

/**
 * Compare committed vectors against a fresh round-trip through the production path.
 *
 * Order matters and is deliberate: identity (`model_mismatch`), then presence
 * (`missing_response`), then shape (`dimension_mismatch`), then finiteness, then
 * length, and only then distance. Every earlier check is a state in which the
 * distance number would be meaningless, and computing it anyway is how a NaN
 * becomes a pass — `NaN > tolerance` is false.
 */
export function checkEmbeddingParity(input: {
  readonly samples: readonly ParitySample[];
  readonly fresh: readonly ParityResponse[];
  readonly tolerance: ParityTolerance;
  /** The id `src/ai/routing.ts` routes the `embedding` op to right now. */
  readonly routedModelId: string;
}): ParityResult {
  const { samples, fresh, tolerance, routedModelId } = input;

  if (samples.length === 0) {
    return {
      passed: false,
      violations: [
        {
          kind: 'no_committed_provider_vectors',
          detail:
            'no provider-sourced vector is committed, so this run compared nothing; ' +
            'regenerate the manifest against the routed embedding model before treating live parity as covered',
        },
      ],
      compared: 0,
    };
  }

  const byKey = new Map<string, ParityResponse>();
  for (const response of fresh) byKey.set(`${response.id}|${response.encoding}`, response);

  const violations: ParityViolation[] = [];
  let compared = 0;

  for (const sample of samples) {
    const where = `${sample.id} (${sample.encoding})`;

    if (sample.model !== routedModelId) {
      violations.push({
        kind: 'model_mismatch',
        detail:
          `${where} was committed under ${sample.model} but the table now routes the embedding op to ${routedModelId}; ` +
          're-embed the corpus or revert the routing change',
      });
      continue;
    }

    const response = byKey.get(`${sample.id}|${sample.encoding}`);
    if (response === undefined) {
      violations.push({
        kind: 'missing_response',
        detail: `${where} was never returned by the live round-trip; a sample with no answer is not a sample that agreed`,
      });
      continue;
    }
    if (response.model !== undefined && response.model !== routedModelId) {
      violations.push({
        kind: 'model_mismatch',
        detail: `${where} came back attributed to ${response.model}, not the routed ${routedModelId}`,
      });
      continue;
    }
    if (response.vector.length !== sample.dimensions) {
      violations.push({
        kind: 'dimension_mismatch',
        detail:
          `${where} came back with ${response.vector.length} dimensions, not ${sample.dimensions}; ` +
          "a changed `dimensions` parameter is invisible to the blocking tier",
      });
      continue;
    }
    if (!response.vector.every((value) => Number.isFinite(value))) {
      violations.push({
        kind: 'non_finite',
        detail: `${where} came back carrying a non-finite component; nothing downstream of this comparison is meaningful`,
      });
      continue;
    }

    const length = norm(response.vector);
    if (Math.abs(length - 1) > tolerance.unitNormEpsilon) {
      violations.push({
        kind: 'not_unit_norm',
        detail:
          `${where} came back with ‖v‖ = ${length.toFixed(6)}; a vector that is not unit length has been truncated ` +
          'client-side without re-normalisation, which changes distance semantics with no error',
      });
      continue;
    }

    const freshVector = Float32Array.from(response.vector);
    const distance = 1 - cosine(sample.vector, freshVector);
    let maxDelta = 0;
    for (let i = 0; i < freshVector.length; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs((sample.vector[i] ?? 0) - (freshVector[i] ?? 0)));
    }

    if (!(distance <= tolerance.maxCosineDistance) || !(maxDelta <= tolerance.maxComponentDelta)) {
      violations.push({
        kind: 'divergence',
        detail:
          `${where} diverged: cosine distance ${distance.toFixed(6)} (max ${tolerance.maxCosineDistance}), ` +
          `largest component delta ${maxDelta.toFixed(6)} (max ${tolerance.maxComponentDelta})`,
      });
      continue;
    }

    compared += 1;
  }

  if (compared + violations.length !== samples.length) {
    throw new Error(
      `compared ${compared} and flagged ${violations.length} of ${samples.length} samples; a parity run that lost one is not a parity run`,
    );
  }

  return { passed: violations.length === 0, violations, compared };
}

/** The same discipline for U12's cross-encoder scores. */
export function checkRerankParity(input: {
  readonly samples: readonly RerankSample[];
  readonly fresh: readonly RerankSample[];
  readonly tolerance: ParityTolerance;
}): ParityResult {
  const { samples, fresh, tolerance } = input;

  if (samples.length === 0) {
    return {
      passed: false,
      violations: [
        {
          kind: 'no_committed_rerank_scores',
          detail:
            'no committed (query, candidate) cross-encoder score exists, so this run compared nothing; ' +
            'U12 commits them when rerank is enabled, and until then the rerank stage has no live coverage',
        },
      ],
      compared: 0,
    };
  }

  const byKey = new Map<string, RerankSample>();
  for (const row of fresh) byKey.set(`${row.queryId}|${row.candidateId}`, row);

  const violations: ParityViolation[] = [];
  let compared = 0;

  for (const sample of samples) {
    const where = `${sample.queryId} × ${sample.candidateId}`;
    const row = byKey.get(`${sample.queryId}|${sample.candidateId}`);
    if (row === undefined) {
      violations.push({
        kind: 'missing_response',
        detail: `${where} was never scored by the live round-trip`,
      });
      continue;
    }
    if (row.model !== sample.model) {
      violations.push({
        kind: 'model_mismatch',
        detail: `${where} was committed under ${sample.model} and came back from ${row.model}`,
      });
      continue;
    }
    if (!Number.isFinite(row.score)) {
      violations.push({ kind: 'non_finite', detail: `${where} came back with a non-finite score` });
      continue;
    }
    const delta = Math.abs(row.score - sample.score);
    if (!(delta <= tolerance.maxScoreDelta)) {
      violations.push({
        kind: 'divergence',
        detail: `${where} moved by ${delta.toFixed(6)} (max ${tolerance.maxScoreDelta}): ${sample.score} → ${row.score}`,
      });
      continue;
    }
    compared += 1;
  }

  if (compared + violations.length !== samples.length) {
    throw new Error(
      `compared ${compared} and flagged ${violations.length} of ${samples.length} pairs; a parity run that lost one is not a parity run`,
    );
  }

  return { passed: violations.length === 0, violations, compared };
}

export function renderParity(label: string, result: ParityResult): string {
  const lines = [`${label}: ${result.compared} compared, ${result.violations.length} violation(s)`];
  for (const violation of result.violations) lines.push(`  [${violation.kind}] ${violation.detail}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

/**
 * Re-embed a sample through the production `src/ai/` path.
 *
 * Everything below the transport is the shipped gateway: the shipped routing
 * table decides the model, the shipped `embeddingDimensions` carries KTD8's
 * `dimensions` parameter, and the shipped metering runs. That is the whole
 * point — a parity job that built its own HTTP call would compare the committed
 * vectors against a second client and prove nothing about the one production
 * uses.
 *
 * The budget is uncapped and the meter is in-memory *because this is not a
 * tenant*: nobody is billed for a parity run, and a cap that refused mid-sample
 * would produce a partial comparison, which this file treats as a violation
 * rather than as a smaller run.
 */
async function reEmbedThroughProductionPath(
  samples: readonly ParitySample[],
  apiKey: string,
): Promise<ParityResponse[]> {
  const { createBudget, createDirectTransport, createInMemorySpendMeter, createModelGateway } = await import(
    '../src/ai/gateway.ts'
  );
  const { createHostedKeyPool, createInMemoryProviderKeyBackend, createTenantProviderKeyStore } = await import(
    '../src/ai/keys.ts'
  );
  const { fleetIdentity } = await import('../src/control/secrets.ts');
  const { PROFILES } = await import('../src/ai/routing.ts');

  const gateway = createModelGateway({
    profile: PROFILES.hosted,
    transport: createDirectTransport({}),
    meter: createInMemorySpendMeter(),
    keys: {
      store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
      hosted: createHostedKeyPool({ openai: apiKey }),
    },
  });

  const tenantId = 'eval-live-parity';
  const budget = createBudget({ label: 'eval:live-parity', capMicroUsd: null });
  const out: ParityResponse[] = [];

  for (const sample of samples) {
    const text = textFor(sample);
    const result = await gateway.call({
      op: 'embedding',
      tenantId,
      caller: fleetIdentity(tenantId),
      budget,
      input: { kind: 'embedding', texts: [text] },
    });
    if (!result.ok) {
      // Not a violation of parity — a failure to measure it. Reported as a
      // missing response so the sample is counted as uncompared rather than as
      // agreeing, which is the direction that matters.
      continue;
    }
    if (result.output.kind !== 'embedding') continue;
    const vector = result.output.vectors[0];
    if (vector === undefined) continue;
    // **No `model`, deliberately.** `ParityResponse.model` exists for the
    // provider's own attribution of the vector it just returned — a provider
    // quietly serving a different snapshot behind the same alias is a
    // parity-class failure and `checkEmbeddingParity` has the check for it. But
    // that attribution is not observable from here: `ModelOutput` carries only
    // vectors, `TransportResponse` carries only output and usage, and the one
    // model id a `GatewayResult` exposes is `metering.modelId`, which is the id
    // this call *asked* for. Filling the field from `sample.model` — which the
    // check above has already compared against `routedModelId` — would satisfy
    // the guard with a value copied out of its own input, so a green run would
    // read as "the provider served what we routed to" while nothing had been
    // observed at all. Left absent so the check honestly skips, and the gap is
    // recorded: provider attribution needs U20's transport to carry the
    // response body's `model` field.
    out.push({ id: sample.id, encoding: sample.encoding, vector });
  }
  return out;
}

/** The text a committed vector was produced from, straight out of the corpus. */
function textFor(sample: ParitySample): string {
  const source = corpusTexts(CORPUS).get(sample.id);
  if (source === undefined) {
    throw new Error(`${sample.id} has a committed vector but no corpus text; the manifest and the corpus disagree`);
  }
  return source.text;
}

export async function main(argv: readonly string[]): Promise<number> {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  // `--preflight` answers the one question a scheduled workflow needs before it
  // decides whether to invoke the tier: is there anything committed to compare
  // against? It exits 0 either way, because it is a question rather than a
  // gate — the same split the credential check in `real-substrate.yml` uses.
  // Without it, a nightly job would fail by design every night while the
  // manifest is synthetic, which is how a scheduled failure stops being read.
  if (argv.includes('--preflight')) {
    const manifestText = readFileSync(fileURLToPath(new URL(`../${MANIFEST_PATH}`, import.meta.url)), 'utf8');
    const loaded = loadEmbeddings(manifestText, corpusTexts(CORPUS));
    out(`samples=${committedProviderSamples(manifestText, loaded).length}`);
    out(`rerank_pairs=0`);
    return 0;
  }

  // Secret-gated, and gated the way `.github/workflows/real-substrate.yml`
  // greps for. A parity run without a live provider is not a cheaper parity
  // run; it is no parity run.
  if (!process.env['BRAINZ_REAL_SUBSTRATE']) {
    out('eval:live-parity: NOT RUN — BRAINZ_REAL_SUBSTRATE is not set.');
    out('  This tier re-invokes real models through the production path. It is scheduled and');
    out('  secret-gated; the blocking tier is what runs on a pull request.');
    return 1;
  }

  const tolerance = loadTolerance();
  const manifest = readFileSync(fileURLToPath(new URL(`../${MANIFEST_PATH}`, import.meta.url)), 'utf8');
  const index = loadEmbeddings(manifest, corpusTexts(CORPUS));
  const samples = committedProviderSamples(manifest, index);

  const { PROFILES } = await import('../src/ai/routing.ts');
  const routedModelId = PROFILES.hosted.routes.embedding.id;

  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  const fresh =
    samples.length === 0 || apiKey.length === 0 ? [] : await reEmbedThroughProductionPath(samples, apiKey);

  const embedding = checkEmbeddingParity({ samples, fresh, tolerance, routedModelId });
  out(renderParity('embedding', embedding));

  // U12 commits the cross-encoder scores; until then this leg refuses rather
  // than reporting a comparison it did not make.
  const rerank = checkRerankParity({ samples: [], fresh: [], tolerance });
  out(renderParity('rerank', rerank));

  if (argv.includes('--json')) {
    out(JSON.stringify({ embedding, rerank, routedModelId, tolerance }, null, 2));
  }

  return embedding.passed && rerank.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
