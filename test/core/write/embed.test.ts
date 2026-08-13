/**
 * The embed seam — U4 approach steps 3 and 5, and KTD8.
 *
 * **KTD8's failure mode is invisible to every test built on committed
 * embeddings**, which is exactly why it gets behavioural assertions here rather
 * than a comment. `text-embedding-3-large` is natively 3072-dimensional and
 * pgvector HNSW-indexes to 2,000, so the vector must arrive at 1536 — and the
 * decision that matters is *how*. Truncation through the API's `dimensions`
 * parameter re-normalizes; a client-side `.slice(0, 1536)` returns a vector
 * that is no longer unit length, which silently changes distance semantics
 * under inner-product operators and degrades recall with no error anywhere. A
 * fixture-based eval cannot see the difference, because it scores whatever
 * vectors were committed. So two things are pinned: a wrong-width answer is a
 * typed failure rather than something to trim, and no module on the write path
 * contains slicing or re-normalization of a vector at all.
 *
 * The other half is the ledger row `stack.contextual-retrieval`: the title-tier
 * wrap is applied to the text sent for encoding and **not** to the text stored,
 * so a chunk still reads back as the user wrote it.
 */

import { describe, expect, test } from 'bun:test';

import { EMBEDDING_PIN } from '../../../src/ai/routing.ts';
import {
  EMBED_OP,
  EmbeddingWidthError,
  documentEncoding,
  embedTexts,
  embeddingModelFor,
  queryEncoding,
  vectorLiteral,
} from '../../../src/core/write/embed.ts';
import { CALLER, TENANT, createGateway, uncappedBudget } from './fixture.ts';

describe('every embed call is the gateway s embedding op', () => {
  test('it routes by op name, never by model', async () => {
    const { gateway, transport } = createGateway();
    const result = await embedTexts({
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      texts: ['a statement worth remembering'],
    });

    expect(result.ok).toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.op).toBe(EMBED_OP);
    expect(EMBED_OP).toBe('embedding');
  });

  test("the dimensions parameter is set on the request, not applied to the answer", () => {
    // KTD8: the parameter re-normalizes; slicing does not. The gateway is what
    // puts it on the wire, and this asserts the write path reaches the branch
    // that does — a call made with a null dimension would come back 3072-wide.
    const { gateway, transport } = createGateway();
    return embedTexts({
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      texts: ['one'],
    }).then(() => {
      expect(transport.calls[0]?.embeddingDimensions).toBe(EMBEDDING_PIN.dimensions);
      expect(EMBEDDING_PIN.dimensions).toBe(1536);
    });
  });

  test('a provider answering at the native width fails typed — it is not trimmed', async () => {
    const { gateway } = createGateway({ width: 3072 });
    const result = await embedTexts({
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      texts: ['one'],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : '').toBe('embedding_dimension_mismatch');
  });

  test('a transport failure surfaces as a typed failure, not an exception', async () => {
    const { gateway } = createGateway({ failFromCall: 1 });
    const result = await embedTexts({
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      texts: ['one'],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.reason : '').toBe('transport_failed');
  });

  test('one vector comes back per text, in order', async () => {
    const { gateway } = createGateway();
    const result = await embedTexts({
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      texts: ['alpha', 'beta', 'gamma'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vectors).toHaveLength(3);
    for (const vector of result.vectors) expect(vector).toHaveLength(1536);
  });

  test('an empty batch makes no call at all', async () => {
    const { gateway, transport } = createGateway();
    const result = await embedTexts({
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      texts: [],
    });

    expect(result.ok).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('a vector reaches SQL at the pinned width or not at all', () => {
  test('a correct vector renders as a pgvector literal', () => {
    const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
    const literal = vectorLiteral(vector);
    expect(literal.startsWith('[1,')).toBe(true);
    expect(literal.endsWith(']')).toBe(true);
  });

  test('a 3072-wide vector throws rather than being trimmed to fit the column', () => {
    // The mutation this exists to kill is one line long and looks like a fix:
    // `vector.slice(0, EMBEDDING_DIMENSIONS)`. It makes every test pass and
    // every distance wrong.
    expect(() => vectorLiteral(new Array<number>(3072).fill(0.1))).toThrow(EmbeddingWidthError);
  });

  test('a short vector throws too', () => {
    expect(() => vectorLiteral([1, 0, 0])).toThrow(EmbeddingWidthError);
  });

  test('a non-finite component throws — NaN in a vector poisons every distance', () => {
    const vector = new Array<number>(1536).fill(0);
    vector[7] = Number.NaN;
    expect(() => vectorLiteral(vector)).toThrow(EmbeddingWidthError);
  });
});

describe('contextual wrap: title tier on the write path', () => {
  test('the encoded text carries the title; the stored text does not', () => {
    const content = 'The migration is scheduled for the first week of the quarter.';
    const encoded = documentEncoding({ title: 'Verdant Systems — migration plan', content });
    expect(encoded).toContain('Verdant Systems');
    expect(encoded).toContain(content);
    expect(encoded).not.toBe(content);
  });

  test('a page with no title encodes the content alone, with no empty preamble', () => {
    const content = 'A note with no title at all.';
    expect(documentEncoding({ title: null, content })).toBe(content);
    expect(documentEncoding({ title: '   ', content })).toBe(content);
  });

  test('the wrap is stable — a change here re-encodes the whole corpus', () => {
    // Pinned as a literal because `evals/regenerate-embeddings.ts` encodes the
    // fixture corpus and must apply the same wrap the day real vectors land.
    expect(documentEncoding({ title: 'T', content: 'C' })).toBe('T\n\nC');
  });

  test('query and document encodings are distinguishable (KTD8 asymmetry)', () => {
    expect(queryEncoding('who is samantha')).not.toBe(documentEncoding({
      title: null,
      content: 'who is samantha',
    }));
  });
});

describe('the model recorded on a page is the model the op routes to', () => {
  test('it comes from the routing table, not from a literal', () => {
    const { gateway } = createGateway();
    expect(embeddingModelFor(gateway.profileName)).toBe('text-embedding-3-large');
  });

  test('an unknown profile name is a throw, not a default', () => {
    expect(() => embeddingModelFor('made-up')).toThrow();
  });
});

describe('the write path contains no client-side vector surgery', () => {
  test('no slicing, no re-normalization, in any module that touches a vector', async () => {
    // KTD8's no-go branch is a fleet re-embed keyed on the provenance
    // signature. What triggers it must be a deliberate model change — not a
    // helpful one-liner that made a width error go away.
    const { Glob } = await import('bun');
    const root = `${import.meta.dir}/../../../src/core/write`;
    const offenders: string[] = [];

    for await (const relative of new Glob('*.ts').scan({ cwd: root })) {
      const text = await Bun.file(`${root}/${relative}`).text();
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      for (const [pattern, why] of [
        [/\bvector[A-Za-z]*\s*\.\s*(?:slice|subarray|splice)\s*\(/, 'slices a vector'],
        [/\bembedding[A-Za-z]*\s*\.\s*(?:slice|subarray|splice)\s*\(/, 'slices an embedding'],
        [/Math\.sqrt\s*\(/, 're-normalizes a vector'],
      ] as ReadonlyArray<readonly [RegExp, string]>) {
        if (pattern.test(code)) offenders.push(`${relative}: ${why}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
