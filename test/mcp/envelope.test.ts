/**
 * The response envelope (R21) — the one growth channel that is free on every
 * client, and therefore the one that will be asked to carry everything.
 *
 * Three rules keep it from becoming a hidden API, and each one is a test here:
 *
 *   * **Closed key set, additive forever.** A key never disappears and never
 *     changes meaning. The guard pins the frozen names as a *subset* of what
 *     the builder emits, so adding a key is legal and removing one is not.
 *   * **Bounded lanes.** `notice` ≤ 2, `next` ≤ 3. An unbounded advisory list
 *     is a prompt-injection surface the server itself operates.
 *   * **Referential integrity on `next[]`.** Every suggestion must name a tool
 *     advertised *on that endpoint*, with every argument key in that tool's own
 *     schema — otherwise the discovery channel teaches models to call things
 *     that return `unknown_tool`.
 *
 * `search_degraded` lives here too, because this unit owns the envelope and U8
 * consumes the shape. A tenant with nothing indexed yet is the ordinary state
 * during a first import, and an empty success is the answer that makes a user
 * believe their brain is broken.
 */

import { describe, expect, test } from 'bun:test';

import {
  CONSOLIDATION_CORPUS_FLOOR,
  CONSOLIDATION_DOCUMENTS_PER_FACT,
  ENVELOPE_KEYS,
  META_KEYS,
  MAX_NEXT,
  MAX_NOTICE,
  MCP_PROTOCOL_VERSION,
  MEMORY_VERBS_VERSION,
  buildEnvelope,
  degradedBriefing,
  degradedNotice,
  degradedSearch,
  envelopeViolations,
  setupHint,
  type IndexState,
} from '../../src/mcp/envelope.ts';
import { advertisedTools, toolByName } from '../../src/mcp/tools/index.ts';

describe('the closed key set', () => {
  test('carries the frozen names, and a build may only add to them', () => {
    for (const key of ['protocol_version', 'degraded', 'notice', 'next', 'setup']) {
      expect(ENVELOPE_KEYS as readonly string[]).toContain(key);
    }
    for (const key of ['brainz.app/brain', 'brainz.app/setup_url']) {
      expect(META_KEYS as readonly string[]).toContain(key);
    }
  });

  test('a built envelope emits no key outside the closed set', () => {
    const envelope = buildEnvelope({
      endpoint: 'mcp',
      notice: ['one'],
      next: [{ tool: 'recall', args: { query: 'anything' }, why: 'read it back' }],
    });
    for (const key of Object.keys(envelope)) {
      expect(ENVELOPE_KEYS as readonly string[]).toContain(key);
    }
    expect(envelope.protocol_version).toBe(MEMORY_VERBS_VERSION);
  });

  /**
   * The failure this pins: one constant carried two unrelated versions.
   *
   * `protocol_version` is the version of *this response body's shape*. The MCP
   * wire revision is a different dimension — dated, negotiated per connection,
   * and answered at `initialize`. Stamping the revision here made the field
   * false under both readings the moment negotiation landed: a client that
   * agreed on `2025-11-25` was handed `2026-07-28` in every envelope of that
   * same connection, which is neither the envelope version nor the revision it
   * negotiated.
   */
  test('stamps the memory-verbs envelope version, never the MCP wire revision', () => {
    const envelope = buildEnvelope({ endpoint: 'mcp' });
    expect(typeof envelope.protocol_version).toBe('number');
    expect(Number.isInteger(envelope.protocol_version)).toBe(true);
    expect(envelope.protocol_version).not.toBe(MCP_PROTOCOL_VERSION as unknown as number);
  });

  test('an envelope carrying the wire revision is a violation, not a variant', () => {
    const findings = envelopeViolations(
      { protocol_version: MCP_PROTOCOL_VERSION as unknown as number },
      'mcp',
    );
    expect(findings.join(' ')).toMatch(/protocol_version/);
  });
});

describe('the bounded lanes', () => {
  test('refuses more than two notices', () => {
    const findings = envelopeViolations(
      { protocol_version: MEMORY_VERBS_VERSION, notice: ['a', 'b', 'c'] },
      'mcp',
    );
    expect(findings.join(' ')).toMatch(/notice/);
  });

  test('refuses more than three suggestions', () => {
    const next = new Array(MAX_NEXT + 1).fill({ tool: 'recall', args: {}, why: 'why' });
    const findings = envelopeViolations({ protocol_version: MEMORY_VERBS_VERSION, next }, 'mcp');
    expect(findings.join(' ')).toMatch(/next/);
  });

  test('the builder truncates rather than emitting an over-long lane', () => {
    const envelope = buildEnvelope({
      endpoint: 'mcp',
      notice: ['a', 'b', 'c', 'd'],
      next: [
        { tool: 'recall', args: {}, why: '1' },
        { tool: 'recall', args: {}, why: '2' },
        { tool: 'recall', args: {}, why: '3' },
        { tool: 'recall', args: {}, why: '4' },
      ],
    });
    expect(envelope.notice?.length).toBe(MAX_NOTICE);
    expect(envelope.next?.length).toBe(MAX_NEXT);
    expect(envelopeViolations(envelope, 'mcp')).toEqual([]);
  });
});

describe('referential integrity on next[]', () => {
  test('a suggestion naming a tool not advertised on this endpoint is a violation', () => {
    // `recall` is the `/mcp` name; `/openai` advertises `search` instead. A
    // suggestion that crosses endpoints teaches the model a call that fails.
    const findings = envelopeViolations(
      {
        protocol_version: MEMORY_VERBS_VERSION,
        next: [{ tool: 'recall', args: { query: 'x' }, why: 'read it back' }],
      },
      'openai',
    );
    expect(findings.join(' ')).toMatch(/recall/);
  });

  test('a suggestion carrying an argument outside the tool schema is a violation', () => {
    const findings = envelopeViolations(
      {
        protocol_version: MEMORY_VERBS_VERSION,
        next: [{ tool: 'recall', args: { qeury: 'typo' }, why: 'read it back' }],
      },
      'mcp',
    );
    expect(findings.join(' ')).toMatch(/qeury/);
  });

  test('a suggestion naming an unadvertised-but-dispatchable tool is still a violation', () => {
    for (const hidden of ['manage', 'synthesize']) {
      const findings = envelopeViolations(
        { protocol_version: MEMORY_VERBS_VERSION, next: [{ tool: hidden, args: {}, why: 'no' }] },
        'mcp',
      );
      expect(findings.join(' ')).toMatch(new RegExp(hidden));
    }
  });

  test('every suggestion the builder emits satisfies the rule on both endpoints', () => {
    for (const endpoint of ['mcp', 'openai'] as const) {
      const reader = endpoint === 'mcp' ? 'recall' : 'search';
      const envelope = buildEnvelope({
        endpoint,
        next: [{ tool: reader, args: { query: 'the fact I just stored' }, why: 'confirm it' }],
      });
      expect(envelopeViolations(envelope, endpoint)).toEqual([]);
    }
  });

  test('the advertised set is exactly seven names on each endpoint', () => {
    for (const endpoint of ['mcp', 'openai'] as const) {
      expect(advertisedTools(endpoint).map((tool) => tool.name)).toHaveLength(7);
    }
    expect(toolByName('recall')).toBeDefined();
  });
});

/**
 * A brain with nothing wrong with it, as the baseline every case below varies
 * from one field at a time.
 *
 * Deliberately ABOVE {@link CONSOLIDATION_CORPUS_FLOOR} with facts to match: a
 * baseline under the floor would satisfy the healthy-silence assertion by being
 * too small for the consolidation ratio to have an opinion, which is the shape
 * of green that proves nothing.
 */
const HEALTHY: IndexState = {
  pages: 600,
  chunks: 900,
  chunksPendingEmbedding: 0,
  importInProgress: false,
  facts: 120,
  ingestRuns: 3,
  capturedByAgent: 4,
};

/** A tenant before its first write: no corpus, no source, no capture. */
const EMPTY: IndexState = {
  pages: 0,
  chunks: 0,
  chunksPendingEmbedding: 0,
  importInProgress: false,
  facts: 0,
  ingestRuns: 0,
  capturedByAgent: 0,
};

const WEB_APP = 'https://app.brainz.test';

describe('search_degraded', () => {
  test('a tenant with nothing indexed gets a named shape, not an empty success', () => {
    const degraded = degradedSearch(EMPTY);
    expect(degraded).not.toBeNull();
    expect(degraded?.kind).toBe('search_degraded');
    expect(degraded?.reasons).toContain('no_content_yet');
  });

  test('a tenant mid-first-import says so, and names the backlog as the reason', () => {
    const degraded = degradedSearch({
      ...HEALTHY,
      chunksPendingEmbedding: 400,
      importInProgress: true,
    });
    expect(degraded?.kind).toBe('search_degraded');
    expect(degraded?.reasons).toContain('import_in_progress');
    expect(degraded?.reasons).toContain('embedding_backlog');
  });

  test('a fully indexed tenant is not degraded', () => {
    expect(
      degradedSearch(HEALTHY),
    ).toBeNull();
  });

  test('a read that lost its vector arm reports the arm, not an empty result set', () => {
    const degraded = degradedSearch(HEALTHY, ['embedding_unavailable']);
    expect(degraded?.reasons).toContain('embedding_unavailable');
  });

  test('the degraded detail is content-free', () => {
    const degraded = degradedSearch(EMPTY);
    // Counts and state names only: this string reaches logs and support tickets.
    expect(degraded?.detail).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
  });

  test('BOTH ARMS DOWN IS ONE SENTENCE, NOT TWO THAT CONTRADICT EACH OTHER', () => {
    // **The per-reason sentence shape names the survivors, and two of them
    // disagree.** Each sentence was written as if its reason were the only one
    // that had fired, so it states what the *other* arms answered from.
    // `embedding_unavailable` therefore says results came from text and graph,
    // `query_too_complex` says they came from meaning and graph, and a read that
    // fired both — a caller pasting a document as a query, which exhausts the
    // read's spend ceiling and Postgres's tsquery parser in the same call —
    // gets both sentences in one `detail`. One of them is always false, the
    // reader cannot tell which, and only the graph arm actually ran.
    const degraded = degradedSearch(HEALTHY, ['embedding_unavailable', 'query_too_complex']);

    expect(degraded?.reasons).toContain('embedding_unavailable');
    expect(degraded?.reasons).toContain('query_too_complex');

    const detail = degraded?.detail ?? '';
    // Neither survivor claim may stand: the text arm did not run, and neither
    // did the meaning arm.
    expect(detail).not.toContain('came from text and graph');
    expect(detail).not.toContain('came from meaning and graph');
    // What is left is the one arm that did run, said once.
    expect(detail).toContain('graph matching alone');
    // Still content-free, and still short enough for the envelope's own bound.
    expect(detail).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
    expect(detail.length).toBeLessThan(600);
  });

  test('one arm down still names the arms that answered', () => {
    // The half that keeps the fix from being "delete the sentences". Each
    // reason on its own keeps saying which arms carried the result.
    const noVector = degradedSearch(HEALTHY, ['embedding_unavailable']);
    expect(noVector?.detail).toContain('came from text and graph matching only');

    const noText = degradedSearch(HEALTHY, ['query_too_complex']);
    expect(noText?.detail).toContain('came from meaning and graph matching only');
  });
});

describe('consolidation_behind — a corpus that is indexed but not yet worked out', () => {
  test('a large corpus with almost no facts is degraded, and says which kind of behind', () => {
    // The measured state of a real brain: the documents are all there and all
    // embedded, and the layer built from them is not. Nothing else in the
    // closed set describes it — `no_content_yet` is false, `embedding_backlog`
    // is false, and the read comes back a clean success over raw passages.
    const degraded = degradedSearch({ ...HEALTHY, pages: 5608, chunks: 16_913, facts: 167 });
    expect(degraded?.reasons).toContain('consolidation_behind');
    expect(degraded?.reasons).not.toContain('no_content_yet');
    expect(degraded?.reasons).not.toContain('embedding_backlog');
  });

  test('a brain under the corpus floor is new, not behind', () => {
    // The floor is what keeps the ratio from calling every brand-new brain
    // behind. Three documents and no facts yet is the first minute of an
    // import, and `import_in_progress` is the reason that describes it.
    const degraded = degradedSearch({
      ...HEALTHY,
      pages: CONSOLIDATION_CORPUS_FLOOR - 1,
      chunks: 40,
      facts: 0,
    });
    expect(degraded).toBeNull();
  });

  test('a corpus whose facts keep pace is not behind', () => {
    const atTheLine = {
      ...HEALTHY,
      pages: CONSOLIDATION_CORPUS_FLOOR * 4,
      facts: (CONSOLIDATION_CORPUS_FLOOR * 4) / CONSOLIDATION_DOCUMENTS_PER_FACT,
    };
    expect(degradedSearch(atTheLine)).toBeNull();
    // One fact short of the line is behind, which is what makes the line a line.
    expect(degradedSearch({ ...atTheLine, facts: atTheLine.facts - 1 })?.reasons).toContain(
      'consolidation_behind',
    );
  });

  test('the detail carries counts and state names only', () => {
    const degraded = degradedSearch({ ...HEALTHY, pages: 5608, chunks: 16_913, facts: 167 });
    expect(degraded?.detail).toContain('167');
    expect(degraded?.detail).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
  });

  test('a briefing over a layer that never ran says pending, and does not also say behind', () => {
    // Both are true of a cold brain and they are the same news to a reader.
    // `consolidation_pending` is the stronger claim, so the detail states it
    // once rather than stacking a ratio sentence behind it.
    const degraded = degradedBriefing(
      { ...HEALTHY, pages: 5608, chunks: 16_913, facts: 167 },
      { materialized: false },
    );
    expect(degraded?.reasons).toContain('consolidation_pending');
    expect(degraded?.detail).toContain('consolidation has not run over it yet');
    expect(degraded?.detail).not.toContain('turned into facts');
    // Both reasons are still on the wire — the collapse is in the sentence, not
    // in the machine-readable half, which stays additive the way the set says.
    expect(degraded?.reasons).toContain('consolidation_behind');
  });

  test('and the notice collapses the same way, so one state is one sentence', () => {
    // Both reasons are true of a cold brain and they are one piece of news, so
    // the stronger reason silences the weaker rather than sitting beside it.
    //
    // This collapse is reachable from `briefing` alone — `degradedSearch` never
    // pushes `consolidation_pending` — so it is NOT what keeps the behind-line
    // honest on `recall`. That line has to be true on its own, and the test
    // below is the one that holds it to that.
    const notice = degradedNotice(
      degradedBriefing(
        { ...HEALTHY, pages: 5608, chunks: 16_913, facts: 167 },
        { materialized: false },
      ),
    );
    expect(notice).toEqual([]);
  });
});

describe('the notice a user actually hears', () => {
  /**
   * THE ASSERTION THAT STOPS THIS BECOMING A NAG.
   *
   * A healthy brain says nothing in either advisory lane. This is the test a
   * future edit breaks first — every new sentence anyone is tempted to add to
   * the envelope has to get past it, and "quiet by default" is a property only
   * for as long as something fails when it stops being true.
   */
  test('A HEALTHY BRAIN CARRIES NEITHER A NOTICE NOR A SETUP HINT', () => {
    const degraded = degradedSearch(HEALTHY);
    expect(degraded).toBeNull();
    expect(degradedNotice(degraded)).toEqual([]);
    expect(setupHint(HEALTHY, WEB_APP)).toBeNull();
  });

  test('a consolidation-behind read carries one sentence a person can hear', () => {
    const degraded = degradedSearch({ ...HEALTHY, pages: 5608, chunks: 16_913, facts: 167 });
    const notice = degradedNotice(degraded);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/consolidat/i);
    // Prose, not a code: the whole point is that the model relays it.
    expect(notice[0]).not.toContain('consolidation_behind');
  });

  test('a free-tier-shaped brain is not told it is catching up', () => {
    // THE PROMISE THIS LINE USED TO MAKE ON EVERY FREE-TIER `recall`.
    //
    // The chain, and every link of it is load-bearing: `degradedSearch` pushes
    // `consolidation_behind` and never `consolidation_pending`; the guard in
    // `degradedNotice` that would silence the weaker line only ever sees both
    // reasons on `briefing`, so it is unreachable from `recall` and `search`;
    // and the cycle skips every model phase on the free tier, so the layer it
    // was promising would catch up never grows. "It sharpens as consolidation
    // catches up" was therefore permanently false for that user, on every read,
    // with no call they could make to change it.
    //
    // **The fix is not more plumbing, and that is the point of this test.** The
    // read path has no access to the tenant's tier by design —
    // `consolidationBehind` uses grant-fenced state only, so that a per-grant
    // sentence is never made out of a fact about origins the grant may not
    // reach — so the line cannot know whether the state is temporary. What it
    // can state is what the counts show. It must say only that, on both tiers.
    const freeShaped: IndexState = { ...HEALTHY, pages: 5608, chunks: 16_913, facts: 167 };
    const notice = degradedNotice(degradedSearch(freeShaped));

    expect(notice).toHaveLength(1);
    // The observation, which is true whichever tier this brain is on.
    expect(notice[0]).toContain('leans on raw passages');
    // And no claim about a future the state cannot show. `yet` is included
    // deliberately: it is the smallest word that smuggles the promise back in.
    expect(notice[0]).not.toMatch(/catch(es|ing)? up/i);
    expect(notice[0]).not.toContain('sharpens');
    expect(notice[0]).not.toMatch(/\byet\b/);
  });

  test('several reasons at once still produce one line, never one per cause', () => {
    // The lane is two entries wide and `briefing` already owns both on a brain
    // that owes an upgrade prompt and a backup reminder. A degradation that
    // spent the whole lane on itself would push a bounded, scheduled notice out
    // of a response that had already banked it as shown.
    const notice = degradedNotice(
      degradedSearch({ ...HEALTHY, pages: 5608, facts: 4, chunksPendingEmbedding: 900, importInProgress: true }, [
        'embedding_unavailable',
        'rerank_unavailable',
      ]),
    );
    expect(notice).toHaveLength(1);
  });

  test('the widest cause wins, because it is the one that explains the thinness', () => {
    const stillImporting = degradedNotice(
      degradedSearch({ ...HEALTHY, pages: 5608, facts: 4, importInProgress: true }),
    );
    expect(stillImporting[0]).toMatch(/import/i);

    const done = degradedNotice(degradedSearch({ ...HEALTHY, pages: 5608, facts: 4 }));
    expect(done[0]).toMatch(/consolidat/i);
  });

  test('an empty brain gets a setup hint and no notice — one lane per state', () => {
    // `no_content_yet` is deliberately absent from the notice table. The
    // sentence a user needs there names an action, and that is `setup`'s job;
    // saying it in both lanes is the same news twice in one response.
    const degraded = degradedSearch(EMPTY);
    expect(degraded?.reasons).toContain('no_content_yet');
    expect(degradedNotice(degraded)).toEqual([]);
    expect(setupHint(EMPTY, WEB_APP)).not.toBeNull();
  });

  test('a cold briefing gets no notice, because that state is not temporary', () => {
    // `consolidation_pending` is the permanent and correct state of a free-tier
    // brain (R8). A line promising it fills in would be false there, and the
    // bounded upgrade prompt is already the sentence written for it.
    const degraded = degradedBriefing(HEALTHY, { materialized: false });
    expect(degraded?.reasons).toContain('consolidation_pending');
    expect(degradedNotice(degraded)).toEqual([]);
  });

  test('a per-call arm loss is worth a line too, and says it is worth retrying', () => {
    const notice = degradedNotice(degradedSearch(HEALTHY, ['rerank_unavailable']));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatch(/again/i);
  });

  test('every line the table can emit fits the lane and reads as prose', () => {
    for (const line of ALL_NOTICE_LINES) {
      expect(line.length).toBeLessThan(220);
      // No reason names, no snake_case: this is the half of the envelope that
      // is addressed to a person rather than to a parser.
      expect(line).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});

/** Every notice the table can produce, reached through the public function. */
const ALL_NOTICE_LINES: readonly string[] = [
  degradedSearch({ ...HEALTHY, importInProgress: true }),
  degradedSearch({ ...HEALTHY, pages: 5608, facts: 4 }),
  degradedSearch({ ...HEALTHY, chunksPendingEmbedding: 400 }),
  degradedSearch(HEALTHY, ['query_too_complex']),
  degradedSearch(HEALTHY, ['embedding_unavailable']),
  degradedSearch(HEALTHY, ['rerank_unavailable']),
].flatMap((degraded) => degradedNotice(degraded));

describe('setup earns its slot', () => {
  test('a brain with no source and no memory is told what fills it, with somewhere to go', () => {
    const hint = setupHint(EMPTY, WEB_APP);
    expect(hint?.kind).toBe('connect_source');
    // The destination is the hint. A suggestion the user cannot act on is the
    // failure `forget`'s notice was rewritten to close.
    expect(hint?.url).toContain(WEB_APP);
  });

  test('a brain with material but nothing the user ever told it asks for the habit', () => {
    const hint = setupHint({ ...HEALTHY, capturedByAgent: 0 }, WEB_APP);
    expect(hint?.kind).toBe('first_memory');
  });

  test('a brain that is merely behind is left alone', () => {
    // The task's third rung: a brain that is consolidating needs no action from
    // the user at all, so `setup` says nothing and the notice carries the news.
    expect(setupHint({ ...HEALTHY, pages: 5608, facts: 167 }, WEB_APP)).toBeNull();
  });

  test('only the first rung fires when both would', () => {
    // An empty brain has captured nothing either. Two hints in one response is
    // two demands, and the lane holds one by type — the ladder is what decides
    // which, rather than whichever branch was written last.
    const hint = setupHint({ ...EMPTY, ingestRuns: 0, capturedByAgent: 0 }, WEB_APP);
    expect(hint?.kind).toBe('connect_source');
  });

  test('a source that has delivered nothing this connection can see reads as no source', () => {
    // `ingestRuns` is fenced like every other counter here: a run whose origin
    // this grant cannot read is not this connection's source. The hint is
    // therefore true of the brain this caller has, which is the only brain it
    // can act on.
    expect(setupHint({ ...EMPTY, ingestRuns: 0 }, WEB_APP)?.kind).toBe('connect_source');
  });

  test('one remember ends the second rung for good', () => {
    const before = setupHint({ ...HEALTHY, capturedByAgent: 0 }, WEB_APP);
    const after = setupHint({ ...HEALTHY, capturedByAgent: 1 }, WEB_APP);
    expect(before).not.toBeNull();
    expect(after).toBeNull();
  });
});
