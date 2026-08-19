/**
 * The two export formats (R17), and the three properties that make a parser
 * worth trusting with content a user can only export once.
 *
 *  1. **Branches survive.** A ChatGPT conversation is a tree; `current_node`
 *     names the branch the user kept. A parser that reads `mapping` as a bag of
 *     messages emits every regeneration inline and produces a transcript that
 *     never happened. One that walks only the main path silently drops the
 *     drafts. Neither is acceptable, so the main path is the page and each
 *     divergent segment is its own page — asserted here as *no duplication in
 *     either direction*.
 *  2. **A malformed conversation is logged and skipped, and the rest of the
 *     export completes.** An export is one file; one bad object must not cost
 *     the other nine thousand.
 *  3. **Re-running the parser over the stored bytes reproduces identical
 *     pages.** That is R16's raw-payload promise stated as an equality rather
 *     than as an intention — without it, "extraction improvements can re-derive
 *     fleet-wide" has nothing behind it.
 *
 * Plus the one that is a security property rather than a fidelity one: a setup
 * capability that travelled through a transcript is redacted on the way back in
 * (U9's claim URL is a capability, and this file is where it re-enters the
 * brain).
 */

import { describe, expect, test } from 'bun:test';

import {
  REDACTED,
  detectChatExportFormat,
  parseChatExport,
  parseChatExportBytes,
  redactSetupCapabilities,
  renderTranscript,
} from '../../src/ingest/import/chat-export.ts';

const CLAUDE_EXPORT = [
  {
    uuid: 'conv-1',
    name: 'Rollout plan',
    created_at: '2026-05-01T10:00:00.000000Z',
    updated_at: '2026-05-01T10:30:00.000000Z',
    account: { uuid: 'acct-1' },
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        created_at: '2026-05-01T10:00:00.000000Z',
        // Deliberately different from `content[]`: newer exports leave a stale
        // or truncated value here, and a parser reading it loses the real message.
        text: 'stale legacy copy',
        content: [{ type: 'text', text: 'When does the rollout start?' }],
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        created_at: '2026-05-01T10:00:05.000000Z',
        text: '',
        content: [{ type: 'text', text: 'It starts on the 14th.' }],
        attachments: [],
        files: [],
      },
      {
        uuid: 'm3',
        sender: 'human',
        created_at: '2026-05-01T10:01:00.000000Z',
        text: 'See attached',
        content: [{ type: 'text', text: 'See attached' }],
        attachments: [
          {
            file_name: 'plan.md',
            file_size: 40,
            file_type: 'text/markdown',
            extracted_content: '# Plan\nShip on the 14th.',
          },
        ],
        files: [{ file_name: 'chart.png' }],
      },
    ],
  },
];

const CHATGPT_EXPORT = [
  {
    title: 'Runway math',
    create_time: 1_778_000_000,
    update_time: 1_778_000_100,
    conversation_id: 'gpt-1',
    id: 'gpt-1',
    current_node: 'n4',
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        parent: 'root',
        children: ['n6'],
        message: {
          id: 'n1',
          author: { role: 'system', name: null, metadata: {} },
          create_time: null,
          content: { content_type: 'text', parts: [''] },
          metadata: { is_visually_hidden_from_conversation: true },
          recipient: 'all',
        },
      },
      n6: {
        id: 'n6',
        parent: 'n1',
        children: ['n2'],
        message: {
          id: 'n6',
          author: { role: 'user', name: null, metadata: {} },
          create_time: 1_778_000_000,
          content: { content_type: 'text', parts: ['INJECTED CONTEXT BLOCK'] },
          metadata: { is_visually_hidden_from_conversation: true },
          recipient: 'all',
        },
      },
      n2: {
        id: 'n2',
        parent: 'n6',
        children: ['n3', 'n5'],
        message: {
          id: 'n2',
          author: { role: 'user', name: null, metadata: {} },
          create_time: 1_778_000_001,
          content: { content_type: 'text', parts: ['What is our runway?'] },
          metadata: {
            attachments: [
              { id: 'file-1', name: 'burn.csv', mime_type: 'text/csv', size: 12 },
            ],
          },
          recipient: 'all',
        },
      },
      n3: {
        id: 'n3',
        parent: 'n2',
        children: ['n4'],
        message: {
          id: 'n3',
          author: { role: 'assistant', name: null, metadata: {} },
          create_time: 1_778_000_002,
          content: { content_type: 'text', parts: ['About nine months at the current burn.'] },
          metadata: {},
          recipient: 'all',
        },
      },
      n4: {
        id: 'n4',
        parent: 'n3',
        children: [],
        message: {
          id: 'n4',
          author: { role: 'user', name: null, metadata: {} },
          create_time: 1_778_000_003,
          content: { content_type: 'text', parts: ['Thanks, that settles it.'] },
          metadata: {},
          recipient: 'all',
        },
      },
      n5: {
        id: 'n5',
        parent: 'n2',
        children: [],
        message: {
          id: 'n5',
          author: { role: 'assistant', name: null, metadata: {} },
          create_time: 1_778_000_004,
          content: { content_type: 'text', parts: ['Roughly a year, on the old burn rate.'] },
          metadata: {},
          recipient: 'all',
        },
      },
    },
  },
];

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe('format detection reads the shape, not the filename', () => {
  test('both vendors call the file conversations.json, so the key set decides', () => {
    expect(detectChatExportFormat(CLAUDE_EXPORT)).toBe('claude');
    expect(detectChatExportFormat(CHATGPT_EXPORT)).toBe('chatgpt');
  });

  test('an unrecognised document is null rather than a guess', () => {
    expect(detectChatExportFormat([{ hello: 'world' }])).toBeNull();
    expect(detectChatExportFormat('not a document')).toBeNull();
    expect(detectChatExportFormat([])).toBeNull();
  });

  test('an export wrapped in a conversations key is still recognised', () => {
    expect(detectChatExportFormat({ conversations: CLAUDE_EXPORT })).toBe('claude');
  });
});

describe('the Claude export', () => {
  test('one page per conversation, roles normalised, timestamps carried', () => {
    const parsed = parseChatExport(CLAUDE_EXPORT);
    expect(parsed.format).toBe('claude');
    expect(parsed.failures).toEqual([]);
    expect(parsed.conversations).toHaveLength(1);

    const page = parsed.conversations[0]!;
    expect(page.externalRef).toBe('claude:conv-1');
    expect(page.title).toBe('Rollout plan');
    expect(page.branch).toBe('main');
    expect(page.messageCount).toBe(3);
    expect(page.occurredAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');
    expect(page.body).toContain('user — 2026-05-01T10:00:00.000Z');
    expect(page.body).toContain('assistant — 2026-05-01T10:00:05.000Z');
    // `content[]` is preferred over the legacy `text`, which the export leaves
    // empty on newer messages — reading `text` alone loses the answer entirely.
    expect(page.body).toContain('It starts on the 14th.');
    // And the legacy field loses when the two disagree.
    expect(page.body).toContain('When does the rollout start?');
    expect(page.body).not.toContain('stale legacy copy');
  });

  test("an attachment's extracted text becomes part of the page, not a filename", () => {
    const page = parseChatExport(CLAUDE_EXPORT).conversations[0]!;
    expect(page.attachments.map((a) => a.fileName)).toEqual(['plan.md', 'chart.png']);
    expect(page.attachments[0]!.extractedContent).toBe('# Plan\nShip on the 14th.');
    // The whole point: the document's words are searchable, not just its name.
    expect(page.body).toContain('Ship on the 14th.');
    expect(page.body).toContain('[attachment: plan.md (text/markdown)]');
    // A file with no extracted text still leaves its name behind.
    expect(page.body).toContain('[attachment: chart.png]');
    expect(page.attachments[1]!.extractedContent).toBeNull();
  });
});

describe('the ChatGPT export is a tree, and the tree is the point', () => {
  test('the main page is the branch the user kept, in order, hidden system dropped', () => {
    const parsed = parseChatExport(CHATGPT_EXPORT);
    expect(parsed.format).toBe('chatgpt');
    expect(parsed.failures).toEqual([]);

    const main = parsed.conversations.find((c) => c.branch === 'main');
    expect(main).toBeDefined();
    expect(main!.externalRef).toBe('chatgpt:gpt-1');
    expect(main!.title).toBe('Runway math');
    expect(main!.messageCount).toBe(3);
    // A message the UI hid is not part of the conversation, whatever its role.
    expect(main!.body).not.toContain('INJECTED CONTEXT BLOCK');
    expect(main!.body).toContain('What is our runway?');
    expect(main!.body).toContain('About nine months at the current burn.');
    expect(main!.body).toContain('Thanks, that settles it.');
    // The regenerated answer is not on the branch the user kept.
    expect(main!.body).not.toContain('on the old burn rate');
    expect(main!.occurredAt?.toISOString()).toBe('2026-05-05T16:53:20.000Z');
  });

  test('a divergent branch is its own page carrying only what diverged', () => {
    const parsed = parseChatExport(CHATGPT_EXPORT);
    const alternates = parsed.conversations.filter((c) => c.branch === 'alternate');
    expect(alternates).toHaveLength(1);

    const branch = alternates[0]!;
    expect(branch.externalRef).toBe('chatgpt:gpt-1#n5');
    expect(branch.body).toContain('on the old burn rate');
    // Not duplicated: the shared prefix stays on the main page only, or every
    // shared question is embedded twice and ranks against itself.
    expect(branch.body).not.toContain('What is our runway?');
    expect(branch.messageCount).toBe(1);
  });

  test("a message's attachments are carried from ChatGPT's metadata block", () => {
    const main = parseChatExport(CHATGPT_EXPORT).conversations.find((c) => c.branch === 'main')!;
    expect(main.attachments.map((a) => a.fileName)).toEqual(['burn.csv']);
    expect(main.attachments[0]!.mediaType).toBe('text/csv');
    expect(main.attachments[0]!.extractedContent).toBeNull();
  });

  test('a conversation with no current_node still parses, deterministically', () => {
    const [conversation] = CHATGPT_EXPORT;
    const orphaned = [{ ...conversation, current_node: 'gone' }];
    const parsed = parseChatExport(orphaned);
    const main = parsed.conversations.find((c) => c.branch === 'main');
    expect(main).toBeDefined();
    // Deepest leaf wins, ties broken by node id, so two runs agree.
    expect(parseChatExport(orphaned)).toEqual(parsed);
  });
});

describe('a malformed conversation is logged and skipped', () => {
  const damaged = [
    'this is not a conversation',
    CLAUDE_EXPORT[0],
    { name: 'no identifier', chat_messages: [{ uuid: 'x', sender: 'human', text: 'hi' }] },
    { uuid: 'empty-conv', name: 'nothing here', chat_messages: [] },
  ];

  test('the rest of the export completes', () => {
    const parsed = parseChatExport(damaged);
    expect(parsed.conversations.map((c) => c.externalRef)).toEqual(['claude:conv-1']);
  });

  test('each failure names what it was and where, and never its content', () => {
    const parsed = parseChatExport(damaged);
    expect(parsed.failures).toEqual([
      { externalRef: null, reason: 'not_an_object', ordinal: 0 },
      { externalRef: null, reason: 'no_identifier', ordinal: 2 },
      { externalRef: 'claude:empty-conv', reason: 'no_messages', ordinal: 3 },
    ]);
  });

  test('bytes that are not JSON at all are one failure, not a throw', () => {
    const parsed = parseChatExportBytes(new TextEncoder().encode('{ not json'));
    expect(parsed.format).toBeNull();
    expect(parsed.conversations).toEqual([]);
    expect(parsed.failures).toEqual([
      { externalRef: null, reason: 'unreadable_json', ordinal: 0 },
    ]);
  });
});

describe('R16: the stored bytes reproduce identical pages', () => {
  test('parsing the raw payload equals parsing the document it came from', () => {
    for (const document of [CLAUDE_EXPORT, CHATGPT_EXPORT]) {
      expect(parseChatExportBytes(bytesOf(document))).toEqual(parseChatExport(document));
    }
  });

  test('and it is stable across runs, which is what makes a re-derive a no-op', () => {
    const once = parseChatExportBytes(bytesOf(CHATGPT_EXPORT));
    const twice = parseChatExportBytes(bytesOf(CHATGPT_EXPORT));
    expect(twice).toEqual(once);
  });
});

describe('the transcript format is stable by contract', () => {
  test('changing it re-chunks every imported conversation, so it is pinned', () => {
    const rendered = renderTranscript([
      {
        role: 'user',
        at: new Date('2026-05-01T10:00:00.000Z'),
        text: 'When does the rollout start?',
        attachments: [],
      },
      {
        role: 'assistant',
        at: null,
        text: 'It starts on the 14th.',
        attachments: [
          { fileName: 'plan.md', mediaType: 'text/markdown', extractedContent: '# Plan' },
        ],
      },
    ]);

    expect(rendered).toBe(
      [
        'user — 2026-05-01T10:00:00.000Z',
        'When does the rollout start?',
        '',
        'assistant',
        'It starts on the 14th.',
        '',
        '[attachment: plan.md (text/markdown)]',
        '# Plan',
      ].join('\n'),
    );
  });
});

describe('a setup capability does not survive a round trip through a transcript', () => {
  const envelope =
    'Here is what came back:\n' +
    '{"protocol_version":1,"setup":{"kind":"connect_source",' +
    '"detail":"Connect Gmail to fill your brain","url":"https://brainz.app/claim/s3cr3t-token"},' +
    '"notice":["one line"]}\n' +
    'and the meta block {"brainz.app/setup_url":"https://brainz.app/claim/s3cr3t-token"}';

  test('the url is replaced and the surrounding copy is not', () => {
    const redacted = redactSetupCapabilities(envelope);
    expect(redacted).not.toContain('s3cr3t-token');
    expect(redacted.split(REDACTED)).toHaveLength(3);
    expect(redacted).toContain('Connect Gmail to fill your brain');
    expect(redacted).toContain('"notice":["one line"]');
  });

  test('ordinary prose about setup is untouched', () => {
    const prose = 'The setup was easy and the url I used was https://example.com/docs';
    expect(redactSetupCapabilities(prose)).toBe(prose);
  });

  test('and the parser applies it, so a claim url cannot be recalled later', () => {
    const withEnvelope = [
      {
        uuid: 'conv-2',
        name: 'Connecting',
        created_at: '2026-05-02T09:00:00.000000Z',
        chat_messages: [
          {
            uuid: 'm1',
            sender: 'assistant',
            created_at: '2026-05-02T09:00:00.000000Z',
            content: [{ type: 'text', text: envelope }],
            attachments: [],
            files: [],
          },
        ],
      },
    ];
    const page = parseChatExport(withEnvelope).conversations[0]!;
    expect(page.body).not.toContain('s3cr3t-token');
    expect(page.body).toContain('Connect Gmail to fill your brain');
  });

  test('an attachment body carrying one is redacted too', () => {
    const withAttachment = [
      {
        uuid: 'conv-3',
        name: 'Pasted',
        created_at: '2026-05-02T09:00:00.000000Z',
        chat_messages: [
          {
            uuid: 'm1',
            sender: 'human',
            created_at: '2026-05-02T09:00:00.000000Z',
            content: [{ type: 'text', text: 'see file' }],
            attachments: [
              { file_name: 'log.json', file_type: 'application/json', extracted_content: envelope },
            ],
            files: [],
          },
        ],
      },
    ];
    const page = parseChatExport(withAttachment).conversations[0]!;
    expect(page.body).not.toContain('s3cr3t-token');
    expect(page.attachments[0]!.extractedContent).not.toContain('s3cr3t-token');
  });
});

describe('a claim URL in ordinary prose', () => {
  /** The shape `mintClaimUrl` produces: a uuid path segment, the secret in the fragment. */
  const CLAIM =
    'https://brainz.example/connect/claim/6f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6071#Zm9vYmFyYmF6cXV1eDEyMzQ1Ng';

  test('is redacted out of a transcript the fleet re-ingests', () => {
    // The envelope's own key names are the structural signal, and they catch a
    // capability that arrives *as* an envelope. They do not catch one an
    // assistant simply typed into a sentence — and that one lands in the
    // transcript, gets imported here, and is `recall`-able for its whole TTL:
    // a live, single-use, tenant-bound capability sitting in the brain.
    const prose = `Sure — open ${CLAIM} and pick the account you want.`;
    const redacted = redactSetupCapabilities(prose);

    expect(redacted).not.toContain(CLAIM);
    expect(redacted).not.toContain('#Zm9vYmFyYmF6cXV1eDEyMzQ1Ng');
    expect(redacted).toContain('open the account you want.'.slice(0, 4));
  });

  test('survives the parse, not just the helper', () => {
    const parsed = parseChatExport([
        {
          uuid: 'conv-claim',
          name: 'Connecting mail',
          created_at: '2026-08-13T10:00:00Z',
          chat_messages: [
            {
              uuid: 'm1',
              sender: 'human',
              created_at: '2026-08-13T10:00:00.000000Z',
              text: 'connect my mail',
              content: [{ type: 'text', text: 'connect my mail' }],
              attachments: [],
              files: [],
            },
            {
              uuid: 'm2',
              sender: 'assistant',
              created_at: '2026-08-13T10:00:01.000000Z',
              text: '',
              content: [{ type: 'text', text: `Open ${CLAIM} to finish.` }],
              attachments: [],
              files: [],
            },
          ],
        },
    ]);
    const body = parsed.conversations[0]?.body ?? '';
    expect(body).toContain('to finish');
    expect(body).not.toContain(CLAIM);
  });

  test('and an ordinary link is left alone', () => {
    const prose = 'The deck is at https://widget-co.example/deck/2026-q3 if you want it.';
    expect(redactSetupCapabilities(prose)).toBe(prose);
  });
});
