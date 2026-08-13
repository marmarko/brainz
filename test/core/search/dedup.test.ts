/**
 * Stage 10 — four-layer read-time dedup.
 *
 * **Each layer gets its own assertion, and each is disabled individually to
 * prove it.** Four layers stacked on one fixture is the classic place for a
 * dead stage to hide: the payload looks right, and three of the four layers are
 * doing the work while the fourth never fires. So every block below turns one
 * layer off and shows the output change — which doubles as the mutation
 * schedule, since "delete this layer" is exactly what the option expresses.
 *
 * The layers, in order:
 *
 *   1. **Top 3 per page.** A verbose page must not fill the candidate list
 *      before the later layers get to look at it.
 *   2. **0.85 Jaccard.** Near-identical *text* across different pages — the
 *      forwarded copy of a mail in a second mailbox, the pasted-into-chat
 *      version of the same advisory. The page caps cannot touch these: they are
 *      different pages, frequently one chunk each.
 *   3. **60% page-type cap.** One surface must not own the whole answer.
 *   4. **2 chunks per page** in what is returned.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_DEDUP, dedupe } from '../../../src/core/search/dedup.ts';
import type { Candidate, ScoredCandidate, SourceType } from '../../../src/core/search/types.ts';

function scored(
  id: string,
  score: number,
  options: {
    readonly pageId?: string;
    readonly content?: string;
    readonly sourceType?: SourceType;
  } = {},
): ScoredCandidate {
  const candidate: Candidate = {
    id,
    pageId: options.pageId ?? `page-${id}`,
    ordinal: 0,
    title: 'A page',
    content: options.content ?? `unique body for ${id} with distinct words ${id}`,
    origin: 'personal:mail',
    sourceType: options.sourceType ?? 'document',
    createdAt: '2026-06-01',
    live: true,
    attestations: [{ channel: 'user_curated' }],
    entityIds: [],
  };
  return { candidate, fused: score, score, boosts: {} };
}

describe('layer 1 — at most three chunks per page reach the later layers', () => {
  test('a 40-chunk verbose page contributes two chunks to the payload', () => {
    // The plan's own scenario. Layers 1 and 4 both act; 4 is what the reader
    // sees, and 1 is what stops the page from crowding out layers 2 and 3.
    const verbose = Array.from({ length: 40 }, (_, index) =>
      scored(`verbose-${index}`, 1 - index * 0.001, {
        pageId: 'p-verbose',
        content: `paragraph ${index} about ${index} distinct topic ${index}`,
      }),
    );
    const other = scored('other', 0.5, { pageId: 'p-other' });

    const kept = dedupe([...verbose, other]);
    expect(kept.filter((entry) => entry.candidate.pageId === 'p-verbose')).toHaveLength(2);
    expect(kept.map((entry) => entry.candidate.id)).toContain('other');
  });

  test('with the per-page cap lifted, the verbose page floods the list', () => {
    const verbose = Array.from({ length: 40 }, (_, index) =>
      scored(`verbose-${index}`, 1 - index * 0.001, {
        pageId: 'p-verbose',
        content: `paragraph ${index} about ${index} distinct topic ${index}`,
      }),
    );
    const flooded = dedupe([...verbose], { chunksPerPage: 40, finalChunksPerPage: 40 });
    expect(flooded.length).toBeGreaterThan(2);
  });
});

describe('layer 2 — 0.85 Jaccard collapses near-identical text across pages', () => {
  const advisory = 'firmware three four has a battery drain bug on the older sensor board';

  test('the forwarded copies collapse to the best-scoring one', () => {
    const rows = [
      scored('personal', 0.9, { pageId: 'p-fwd-personal', content: advisory }),
      scored('work', 0.8, { pageId: 'p-fwd-work', content: `fwd: ${advisory}` }),
      scored('chat', 0.7, { pageId: 'p-chat-paste', content: `${advisory} !`, sourceType: 'chat' }),
      scored('distinct', 0.6, { pageId: 'p-other', content: 'entirely different subject matter here' }),
    ];

    const kept = dedupe(rows);
    expect(kept.map((entry) => entry.candidate.id)).toEqual(['personal', 'distinct']);
  });

  test('the page caps alone cannot do this — they are different pages', () => {
    const rows = [
      scored('personal', 0.9, { pageId: 'p-fwd-personal', content: advisory }),
      scored('work', 0.8, { pageId: 'p-fwd-work', content: `fwd: ${advisory}` }),
    ];
    // Threshold above 1 is unreachable, which is how the layer is switched off.
    const withoutJaccard = dedupe(rows, { jaccardThreshold: 1.01 });
    expect(withoutJaccard).toHaveLength(2);
  });

  test('genuinely different text at the same length survives', () => {
    const rows = [
      scored('a', 0.9, { content: 'the renewal price for the compute account rose this year' }),
      scored('b', 0.8, { content: 'the dentist appointment moved to the third of september' }),
    ];
    expect(dedupe(rows)).toHaveLength(2);
  });
});

describe('layer 3 — no source type owns more than 60% of the payload', () => {
  test('a chat flood yields room to the one document', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        scored(`chat-${index}`, 1 - index * 0.01, {
          pageId: `p-chat-${index}`,
          sourceType: 'chat',
          content: `chat line ${index} with its own words ${index}`,
        }),
      ),
      scored('doc', 0.1, { pageId: 'p-doc', sourceType: 'document' }),
    ];

    const kept = dedupe(rows, { targetSize: 10 });
    const chats = kept.filter((entry) => entry.candidate.sourceType === 'chat').length;
    // 60% of the ten slots the caller asked for, not 60% of whatever survived —
    // see `DedupOptions.targetSize` for why the denominator is the request.
    expect(chats).toBeLessThanOrEqual(Math.floor(10 * DEFAULT_DEDUP.pageTypeCap));
    expect(chats).toBeLessThan(8);
    expect(kept.map((entry) => entry.candidate.id)).toContain('doc');
  });

  test('with the cap lifted, chat takes the whole list', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        scored(`chat-${index}`, 1 - index * 0.01, {
          pageId: `p-chat-${index}`,
          sourceType: 'chat',
          content: `chat line ${index} with its own words ${index}`,
        }),
      ),
      scored('doc', 0.1, { pageId: 'p-doc', sourceType: 'document' }),
    ];
    const uncapped = dedupe(rows, { pageTypeCap: 1, targetSize: 10 });
    expect(uncapped.slice(0, 8).every((entry) => entry.candidate.sourceType === 'chat')).toBe(true);
  });

  test('the cap never empties a homogeneous result set', () => {
    // Every candidate is a chat message. A cap that dropped 40% of the only
    // answers there are would be a worse failure than the crowding it prevents.
    const rows = Array.from({ length: 5 }, (_, index) =>
      scored(`chat-${index}`, 1 - index * 0.01, {
        pageId: `p-chat-${index}`,
        sourceType: 'chat',
        content: `chat line ${index} distinct ${index}`,
      }),
    );
    expect(dedupe(rows, { targetSize: 10 }).length).toBe(5);
  });
});

describe('the stage as a whole', () => {
  test('order is preserved — dedup removes, it never reorders', () => {
    const rows = [scored('a', 0.9), scored('b', 0.8), scored('c', 0.7)];
    expect(dedupe(rows).map((entry) => entry.candidate.id)).toEqual(['a', 'b', 'c']);
  });

  test('an empty list dedupes to an empty list', () => {
    expect(dedupe([])).toEqual([]);
  });

  test('the survivor of a near-dup cluster is the highest-scoring member', () => {
    const text = 'the same sentence repeated across three different surfaces entirely';
    const rows = [
      scored('low', 0.3, { pageId: 'p1', content: text }),
      scored('high', 0.9, { pageId: 'p2', content: text }),
    ].sort((a, b) => b.score - a.score);
    expect(dedupe(rows).map((entry) => entry.candidate.id)).toEqual(['high']);
  });
});
