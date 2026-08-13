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
  ENVELOPE_KEYS,
  META_KEYS,
  MAX_NEXT,
  MAX_NOTICE,
  PROTOCOL_VERSION,
  buildEnvelope,
  degradedSearch,
  envelopeViolations,
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
    expect(envelope.protocol_version).toBe(PROTOCOL_VERSION);
  });
});

describe('the bounded lanes', () => {
  test('refuses more than two notices', () => {
    const findings = envelopeViolations(
      { protocol_version: PROTOCOL_VERSION, notice: ['a', 'b', 'c'] },
      'mcp',
    );
    expect(findings.join(' ')).toMatch(/notice/);
  });

  test('refuses more than three suggestions', () => {
    const next = new Array(MAX_NEXT + 1).fill({ tool: 'recall', args: {}, why: 'why' });
    const findings = envelopeViolations({ protocol_version: PROTOCOL_VERSION, next }, 'mcp');
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
        protocol_version: PROTOCOL_VERSION,
        next: [{ tool: 'recall', args: { query: 'x' }, why: 'read it back' }],
      },
      'openai',
    );
    expect(findings.join(' ')).toMatch(/recall/);
  });

  test('a suggestion carrying an argument outside the tool schema is a violation', () => {
    const findings = envelopeViolations(
      {
        protocol_version: PROTOCOL_VERSION,
        next: [{ tool: 'recall', args: { qeury: 'typo' }, why: 'read it back' }],
      },
      'mcp',
    );
    expect(findings.join(' ')).toMatch(/qeury/);
  });

  test('a suggestion naming an unadvertised-but-dispatchable tool is still a violation', () => {
    for (const hidden of ['manage', 'synthesize']) {
      const findings = envelopeViolations(
        { protocol_version: PROTOCOL_VERSION, next: [{ tool: hidden, args: {}, why: 'no' }] },
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

describe('search_degraded', () => {
  test('a tenant with nothing indexed gets a named shape, not an empty success', () => {
    const degraded = degradedSearch({ pages: 0, chunks: 0, chunksPendingEmbedding: 0, importInProgress: false });
    expect(degraded).not.toBeNull();
    expect(degraded?.kind).toBe('search_degraded');
    expect(degraded?.reasons).toContain('no_content_yet');
  });

  test('a tenant mid-first-import says so, and names the backlog as the reason', () => {
    const degraded = degradedSearch({
      pages: 40,
      chunks: 900,
      chunksPendingEmbedding: 400,
      importInProgress: true,
    });
    expect(degraded?.kind).toBe('search_degraded');
    expect(degraded?.reasons).toContain('import_in_progress');
    expect(degraded?.reasons).toContain('embedding_backlog');
  });

  test('a fully indexed tenant is not degraded', () => {
    expect(
      degradedSearch({ pages: 40, chunks: 900, chunksPendingEmbedding: 0, importInProgress: false }),
    ).toBeNull();
  });

  test('a read that lost its vector arm reports the arm, not an empty result set', () => {
    const degraded = degradedSearch(
      { pages: 40, chunks: 900, chunksPendingEmbedding: 0, importInProgress: false },
      ['embedding_unavailable'],
    );
    expect(degraded?.reasons).toContain('embedding_unavailable');
  });

  test('the degraded detail is content-free', () => {
    const degraded = degradedSearch({
      pages: 0,
      chunks: 0,
      chunksPendingEmbedding: 0,
      importInProgress: false,
    });
    // Counts and state names only: this string reaches logs and support tickets.
    expect(degraded?.detail).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/);
  });
});
