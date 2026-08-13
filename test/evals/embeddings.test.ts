/**
 * The embedding manifest, its digests, and the four ways a vector set can be
 * silently wrong.
 *
 * The blocking tier's whole promise is that it makes zero model calls and
 * produces identical scores on every run. That promise rests on this file's
 * subject: a set of committed vectors that can be checked against something.
 * Each check below corresponds to a way the check could be satisfied by
 * *absence* — a missing row, a missing float array, an unrecognised source, a
 * digest nobody compared — which is the shape this unit's guards are written
 * against.
 *
 * The freshness test is the one that matters most in daily use: it regenerates
 * the manifest in memory and compares it to what is on disk, so a corpus edit
 * that was not followed by `bun run evals/regenerate-embeddings.ts` turns the
 * suite red instead of scoring the new text against the old vectors.
 */

import { test, expect, describe } from 'bun:test';

import { CORPUS, corpusTexts } from '../../evals/corpus.ts';
import {
  cosine,
  decodeVector,
  digestOf,
  encodeVector,
  loadEmbeddings,
  serializeRow,
  syntheticRow,
  syntheticVector,
  tokenize,
  SYNTHETIC_GENERATOR,
} from '../../evals/embeddings.ts';
import {
  buildManifest,
  buildProviderSample,
  MANIFEST_PATH,
  PROVIDER_SAMPLE_PATH,
} from '../../evals/regenerate-embeddings.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';

const texts = corpusTexts(CORPUS);
const manifestOnDisk = await Bun.file(MANIFEST_PATH).text();

describe('the synthetic generator', () => {
  test('is deterministic across calls', () => {
    const first = syntheticVector('the same words in the same order', 'document');
    const second = syntheticVector('the same words in the same order', 'document');
    expect(digestOf(first)).toBe(digestOf(second));
  });

  test('produces unit-length vectors at the tenant column width', () => {
    const vector = syntheticVector('soil moisture sensors for small vineyards', 'document');
    expect(vector.length).toBe(EMBEDDING_DIMENSIONS);
    let norm = 0;
    for (const value of vector) norm += value * value;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  test('the two asymmetric encodings of one text differ, but stay near each other', () => {
    const asQuery = syntheticVector('halcyon grid renewal terms', 'query');
    const asDocument = syntheticVector('halcyon grid renewal terms', 'document');
    expect(digestOf(asQuery)).not.toBe(digestOf(asDocument));
    // Near, because they encode the same text; not identical, because the
    // encoding is asymmetric. A swap of the two is exactly what U7 step 7's
    // live-parity job exists to catch, and it is invisible from here.
    expect(cosine(asQuery, asDocument)).toBeGreaterThan(0.9);
    expect(cosine(asQuery, asDocument)).toBeLessThan(1);
  });

  test('carries lexical signal and not semantic signal — the stand-in\'s stated limit', () => {
    const query = syntheticVector('halcyon grid renewal terms', 'query');
    const overlapping = syntheticVector('the halcyon grid renewal terms for this year', 'document');
    const paraphrase = syntheticVector('what the compute reseller charges annually', 'document');
    expect(cosine(query, overlapping)).toBeGreaterThan(cosine(query, paraphrase));
  });

  test('refuses text with no tokens rather than returning a zero vector', () => {
    expect(() => syntheticVector('   ', 'document')).toThrow(/no tokens/);
  });
});

describe('the committed manifest', () => {
  test('is fresh: regenerating it produces the bytes on disk', () => {
    expect(buildManifest()).toBe(manifestOnDisk);
  });

  test('loads, verifies, and covers every chunk and every query', () => {
    const index = loadEmbeddings(manifestOnDisk, texts);
    // Chunks carry one encoding; queries carry both.
    expect(index.size).toBe(CORPUS.chunks.size + CORPUS.facts.size + CORPUS.queries.length * 2);
    for (const id of CORPUS.chunkIds) expect(index.has(id, 'document')).toBe(true);
    for (const query of CORPUS.queries) {
      expect(index.has(query.id, 'query')).toBe(true);
      expect(index.has(query.id, 'document')).toBe(true);
    }
  });

  test('asking for a vector that was never verified throws', () => {
    const index = loadEmbeddings(manifestOnDisk, texts);
    expect(() => index.get('p-does-not-exist#0', 'document')).toThrow(/no verified/);
  });
});

describe('the loader fails closed on', () => {
  const rowFor = (id: string): string => {
    const line = manifestOnDisk.split('\n').find((candidate) => candidate.includes(`"${id}"`));
    if (line === undefined) throw new Error(`no manifest row for ${id}`);
    return line;
  };

  test('a corrupted digest', () => {
    const target = rowFor('p-verdant-overview#0');
    const corrupted = manifestOnDisk.replace(
      target,
      target.replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${'0'.repeat(64)}"`),
    );
    expect(() => loadEmbeddings(corrupted, texts)).toThrow(/but its vector digests to/);
  });

  test('a manifest row whose text is not in the corpus', () => {
    const extra = serializeRow(syntheticRow('p-ghost#0', 'chunk', 'document', 'a page that does not exist'));
    expect(() => loadEmbeddings(`${manifestOnDisk}${extra}\n`, texts)).toThrow(/no corresponding text/);
  });

  test('a corpus text with no manifest row — the orphan direction', () => {
    const trimmed = manifestOnDisk
      .split('\n')
      .filter((line) => !line.includes('"p-verdant-overview#0"'))
      .join('\n');
    expect(() => loadEmbeddings(trimmed, texts)).toThrow(/has no manifest row/);
  });

  test('a source value that is neither synthetic nor provider', () => {
    const target = rowFor('p-verdant-overview#0');
    const broken = manifestOnDisk.replace(target, target.replace('"source":"synthetic"', '"source":"trust-me"'));
    expect(() => loadEmbeddings(broken, texts)).toThrow(/neither synthetic nor provider/);
  });

  test('a provider row that carries a digest but no floats', () => {
    const target = rowFor('p-verdant-overview#0');
    const broken = manifestOnDisk.replace(target, target.replace('"source":"synthetic"', '"source":"provider"'));
    expect(() => loadEmbeddings(broken, texts)).toThrow(/carries no vector/);
  });

  test('a synthetic row written by a generator this build does not have', () => {
    const target = rowFor('p-verdant-overview#0');
    const broken = manifestOnDisk.replace(
      target,
      target.replace(`"generator":"${SYNTHETIC_GENERATOR}"`, '"generator":"lexical-hash-v0"'),
    );
    expect(() => loadEmbeddings(broken, texts)).toThrow(/was written by generator/);
  });

  test('a dimension that does not match the tenant column', () => {
    const target = rowFor('p-verdant-overview#0');
    const broken = manifestOnDisk.replace(target, target.replace('"dimensions":1536', '"dimensions":1024'));
    expect(() => loadEmbeddings(broken, texts)).toThrow(/the tenant column is/);
  });

  test('a duplicated row', () => {
    const target = rowFor('p-verdant-overview#0');
    expect(() => loadEmbeddings(`${manifestOnDisk}${target}\n`, texts)).toThrow(/twice/);
  });

  test('an empty manifest', () => {
    expect(() => loadEmbeddings('', texts)).toThrow(/empty/);
  });
});

const providerSample = await Bun.file(PROVIDER_SAMPLE_PATH).text();

describe('the provider branch', () => {
  test('the committed sample is fresh', () => {
    expect(buildProviderSample()).toBe(providerSample);
  });

  test('loads through the same verification path as the synthetic branch', () => {
    // Scoped to just the two ids the sample covers, so the orphan check is
    // satisfied by the sample rather than by the whole corpus.
    const scoped = new Map<string, { kind: 'chunk' | 'query' | 'fact'; text: string }>();
    for (const line of providerSample.split('\n').filter((candidate) => candidate.trim().length > 0)) {
      const id = (JSON.parse(line) as { id: string }).id;
      const text = texts.get(id);
      if (text === undefined) throw new Error(`sample references ${id}, which is not in the corpus`);
      scoped.set(id, text);
    }
    const index = loadEmbeddings(providerSample, scoped);
    expect(index.size).toBe(2);
  });

  test('base64 round-trips exactly', () => {
    const vector = syntheticVector('round trip me', 'document');
    const decoded = decodeVector(encodeVector(vector), EMBEDDING_DIMENSIONS);
    expect(digestOf(decoded)).toBe(digestOf(vector));
  });

  test('a truncated float array is rejected on length, before its digest is even computed', () => {
    const vector = syntheticVector('round trip me', 'document');
    const short = encodeVector(vector.slice(0, 100));
    expect(() => decodeVector(short, EMBEDDING_DIMENSIONS)).toThrow(/bytes, not the/);
  });
});

describe('tokenize', () => {
  test('keeps the shapes the alias probes depend on', () => {
    expect(tokenize('Contact sokonkwo@example.com today')).toContain('sokonkwo@example.com');
    expect(tokenize('Firmware 3.4.1 hotfix')).toContain('3.4.1');
    expect(tokenize('K&Q suppliers')).toEqual(['k', 'q', 'suppliers']);
  });

  test('is the same on both sides of the write/read boundary', () => {
    // Trivially true here because there is one function. Asserted anyway: the
    // failure R5's shared normalizer exists to prevent presents as misses, never
    // as errors, and the first step away from it is a second tokenizer.
    expect(tokenize('Halcyon Grid')).toEqual(tokenize('halcyon  grid'));
  });
});
