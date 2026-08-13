/**
 * Chat-export import (R17): the Claude and ChatGPT data-export formats.
 *
 * **Why this path exists at all.** An MCP server sees tool calls, not
 * transcripts — conversation content cannot reach one in volume. So the export
 * file is the honest route for chat history, and getting the format right is
 * the whole job: a parser that drops branches or attachments loses content the
 * user cannot re-supply, because they exported it once.
 *
 * **Everything here is pure.** Bytes in, pages out, no clock, no database, no
 * network. That is what makes R16's raw-payload promise checkable rather than
 * asserted: the export is preserved under the tenant's `raw/` prefix, and
 * re-running this function over those bytes has to reproduce byte-identical
 * pages, or "extraction improvements can re-derive fleet-wide" is a hope.
 *
 * **The two formats are shaped differently, and only one of them has branches.**
 *
 *   * *Claude* is a list of conversations, each with a flat `chat_messages`
 *     array. Attachments arrive with their text already extracted
 *     (`extracted_content`), which is the best case in the whole unit: the
 *     document's words are in the export, so they become part of the page
 *     rather than a filename nobody can search. The newer messages leave the
 *     legacy `text` field empty and carry the answer in `content[]`, so a
 *     parser reading `text` alone silently imports the questions and none of
 *     the answers.
 *   * *ChatGPT* is a list of conversations, each with a `mapping` that is a
 *     **tree**, not a list. Every edit and every regeneration forks it.
 *     `current_node` is the leaf of the branch the user actually kept, so
 *     walking parents from there to the root is the conversation as they
 *     remember it. The other leaves are real content too — an answer they
 *     regenerated away from still happened — so each divergent branch becomes
 *     its own page containing **only its divergent segment**. Nothing is
 *     duplicated, and the main transcript is not polluted with the drafts.
 *
 * **A malformed conversation is logged and skipped, and the rest completes.**
 * An export is one file; one bad object in it must not cost a user the other
 * nine thousand. Failures come back as data next to the conversations, so the
 * caller writes them to the ingest log rather than discovering them in a stack
 * trace. A failure names an ordinal and an id — never a fragment of content.
 *
 * **Setup capabilities are redacted, per U9's note on the claim URL.** A claim
 * URL is a capability: whoever holds it can attach their own Google account to
 * this tenant. It travels in the MCP envelope's `setup` field and in the
 * `brainz.app/setup_url` meta key — which means it lands in the assistant's
 * transcript, which is the file this parser reads back in. Left alone, `recall`
 * could resurface a live capability months later.
 *
 * **Two rules, because they catch different things.** The structural one keys
 * on the envelope's own stable key names, and it catches a capability that
 * arrives *as* an envelope whatever the URL looks like. The shape rule is U9's
 * own {@link redactClaimUrls}, imported rather than re-derived, and it catches
 * the one the structural rule cannot see: a claim link an assistant simply
 * typed into a sentence. That one is a live, single-use, tenant-bound
 * capability sitting in the brain for the length of its TTL. When this file was
 * written the URL shape did not exist yet and a shape rule would have been a
 * guard against a value nobody had minted; it exists now.
 */

import { redactClaimUrls } from '../pipedream/client.ts';

/** Never a real URL, and not a value any parser will mistake for one. */
export const REDACTED = '[redacted:setup-capability]';

export type ChatExportFormat = 'claude' | 'chatgpt';

export interface ParsedAttachment {
  readonly fileName: string;
  readonly mediaType: string | null;
  /** Present when the export carried the extracted text (Claude does). */
  readonly extractedContent: string | null;
}

export interface ParsedConversation {
  /** `claude:<uuid>` / `chatgpt:<id>`, or `chatgpt:<id>#<leaf>` for a branch. */
  readonly externalRef: string;
  readonly title: string | null;
  /** The rendered transcript. Stable by contract — see {@link renderTranscript}. */
  readonly body: string;
  readonly occurredAt: Date | null;
  readonly messageCount: number;
  readonly attachments: readonly ParsedAttachment[];
  /** `alternate` is a ChatGPT branch the user navigated away from. */
  readonly branch: 'main' | 'alternate';
}

export type ParseFailureReason =
  | 'not_an_object'
  | 'no_identifier'
  | 'no_messages'
  | 'unreadable_json'
  | 'unknown_format';

export interface ParseFailure {
  /** Null when the object was too malformed to carry an id. */
  readonly externalRef: string | null;
  readonly reason: ParseFailureReason;
  /** Where in the export it was, so a user can find it. Never its content. */
  readonly ordinal: number;
}

export interface ChatExportParse {
  readonly format: ChatExportFormat | null;
  readonly conversations: readonly ParsedConversation[];
  readonly failures: readonly ParseFailure[];
}

export interface RenderedMessage {
  readonly role: string;
  readonly at: Date | null;
  readonly text: string;
  readonly attachments: readonly ParsedAttachment[];
}

// ---------------------------------------------------------------------------
// Shape helpers. Everything an export offers is `unknown` until it is checked;
// a cast here would be a parser that trusts a file the user downloaded.
// ---------------------------------------------------------------------------

type Record_ = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Record_ | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record_)
    : null;
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseInstant(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // ChatGPT quotes epoch seconds, fractional.
    return new Date(Math.round(value * 1_000));
  }
  const text = asString(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The conversations a document offers, whichever wrapper it uses. */
function conversationsOf(value: unknown): readonly unknown[] | null {
  const direct = asArray(value);
  if (direct !== null) return direct;
  const record = asRecord(value);
  if (record === null) return null;
  return asArray(record.conversations);
}

// ---------------------------------------------------------------------------
// Redaction.
// ---------------------------------------------------------------------------

const SETUP_URL_META = /("brainz\.app\/setup_url"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
const URL_FIELD = /("url"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
const SETUP_KEY = '"setup"';
const SETUP_KEY_OPENS = /^\s*:\s*\{/;

/**
 * The end of the JSON object that starts at `open`, or -1.
 *
 * String-aware, because a brace inside a quoted value is not a brace. Bounded
 * by the input, so a truncated transcript cannot spin here.
 */
function objectEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = open; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Strip setup capabilities out of transcript text.
 *
 * Keys on the envelope's stable key names — `"setup"` objects and the
 * `brainz.app/setup_url` meta key — inside JSON-shaped spans, so ordinary prose
 * containing the word "setup" is untouched. Exported because it is the property
 * a test has to be able to point at directly.
 */
export function redactSetupCapabilities(text: string): string {
  // The shape rule first: it is a plain replace with no cursor to keep true,
  // and running it before the structural pass means a claim URL inside a
  // `setup` object is already gone by the time the object walk reaches it.
  let output = redactClaimUrls(text);
  output = output.replace(SETUP_URL_META, `$1"${REDACTED}"`);

  // A forward cursor, not a rescan from zero. Replacing inside a span shifts
  // every index after it, so a cached match list would redact the wrong bytes —
  // and a rescan that finds the same key again is an infinite loop whenever
  // there was nothing in that object to redact.
  let cursor = 0;
  for (;;) {
    const at = output.indexOf(SETUP_KEY, cursor);
    if (at === -1) break;

    const opener = SETUP_KEY_OPENS.exec(output.slice(at + SETUP_KEY.length));
    if (opener === null) {
      cursor = at + SETUP_KEY.length;
      continue;
    }

    const open = at + SETUP_KEY.length + opener[0].length - 1;
    const end = objectEnd(output, open);
    if (end === -1) break;

    const span = output.slice(open, end);
    const cleaned = span.replace(URL_FIELD, `$1"${REDACTED}"`);
    output = output.slice(0, open) + cleaned + output.slice(end);
    cursor = open + cleaned.length;
  }

  return output;
}

function redactAttachment(attachment: ParsedAttachment): ParsedAttachment {
  return {
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    extractedContent:
      attachment.extractedContent === null
        ? null
        : redactSetupCapabilities(attachment.extractedContent),
  };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/**
 * The transcript format. **Stable by contract**: it is the page body, so
 * changing it re-chunks and re-embeds every imported conversation in every
 * brain, and the raw round-trip stops reproducing what was stored. Pinned by a
 * literal assertion in `test/ingest/chat-export.test.ts`.
 */
export function renderTranscript(messages: readonly RenderedMessage[]): string {
  const blocks: string[] = [];

  for (const message of messages) {
    const header = message.at === null
      ? message.role
      : `${message.role} — ${message.at.toISOString()}`;
    blocks.push(message.text.length > 0 ? `${header}\n${message.text}` : header);

    for (const attachment of message.attachments) {
      const label =
        attachment.mediaType === null
          ? `[attachment: ${attachment.fileName}]`
          : `[attachment: ${attachment.fileName} (${attachment.mediaType})]`;
      blocks.push(
        attachment.extractedContent === null || attachment.extractedContent.length === 0
          ? label
          : `${label}\n${attachment.extractedContent}`,
      );
    }
  }

  return blocks.join('\n\n');
}

function pageFrom(input: {
  readonly externalRef: string;
  readonly title: string | null;
  readonly messages: readonly RenderedMessage[];
  readonly occurredAt: Date | null;
  readonly branch: 'main' | 'alternate';
}): ParsedConversation {
  const attachments = input.messages.flatMap((message) => [...message.attachments]);
  return {
    externalRef: input.externalRef,
    title: input.title,
    body: renderTranscript(input.messages),
    occurredAt: input.occurredAt,
    messageCount: input.messages.length,
    attachments,
    branch: input.branch,
  };
}

// ---------------------------------------------------------------------------
// Format detection.
// ---------------------------------------------------------------------------

/**
 * Which export this is, from its shape rather than from a filename.
 *
 * A filename is the caller's, and `conversations.json` is what both vendors
 * call theirs — so the discriminator has to be structural: a ChatGPT
 * conversation carries `mapping`, a Claude one carries `chat_messages`.
 */
export function detectChatExportFormat(value: unknown): ChatExportFormat | null {
  const conversations = conversationsOf(value);
  if (conversations === null) return null;

  for (const candidate of conversations) {
    const record = asRecord(candidate);
    if (record === null) continue;
    if (asRecord(record.mapping) !== null) return 'chatgpt';
    if (asArray(record.chat_messages) !== null) return 'claude';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude.
// ---------------------------------------------------------------------------

function claudeText(message: Record_): string {
  const content = asArray(message.content);
  if (content !== null) {
    const parts: string[] = [];
    for (const block of content) {
      const record = asRecord(block);
      if (record === null) continue;
      const text = asString(record.text);
      if (text !== null) parts.push(text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return asString(message.text) ?? '';
}

function claudeAttachments(message: Record_): ParsedAttachment[] {
  const attachments: ParsedAttachment[] = [];

  for (const raw of asArray(message.attachments) ?? []) {
    const record = asRecord(raw);
    if (record === null) continue;
    const fileName = asString(record.file_name);
    if (fileName === null) continue;
    attachments.push({
      fileName,
      mediaType: asString(record.file_type),
      extractedContent: asString(record.extracted_content),
    });
  }

  // `files` is the other half of the same idea: an upload with no extracted
  // text. Its name is still worth keeping — "the deck I sent in May" is a query.
  for (const raw of asArray(message.files) ?? []) {
    const record = asRecord(raw);
    if (record === null) continue;
    const fileName = asString(record.file_name);
    if (fileName === null) continue;
    attachments.push({ fileName, mediaType: asString(record.file_type), extractedContent: null });
  }

  return attachments;
}

function claudeRole(sender: unknown): string {
  const value = asString(sender);
  if (value === 'assistant') return 'assistant';
  if (value === 'human' || value === 'user') return 'user';
  return value ?? 'unknown';
}

function parseClaudeConversation(
  value: unknown,
  ordinal: number,
): { readonly page: ParsedConversation } | { readonly failure: ParseFailure } {
  const record = asRecord(value);
  if (record === null) return { failure: { externalRef: null, reason: 'not_an_object', ordinal } };

  const uuid = asString(record.uuid) ?? asString(record.id);
  if (uuid === null) return { failure: { externalRef: null, reason: 'no_identifier', ordinal } };
  const externalRef = `claude:${uuid}`;

  const messages: RenderedMessage[] = [];
  for (const raw of asArray(record.chat_messages) ?? []) {
    const message = asRecord(raw);
    if (message === null) continue;
    const text = redactSetupCapabilities(claudeText(message));
    const attachments = claudeAttachments(message).map(redactAttachment);
    if (text.length === 0 && attachments.length === 0) continue;
    messages.push({
      role: claudeRole(message.sender),
      at: parseInstant(message.created_at),
      text,
      attachments,
    });
  }

  if (messages.length === 0) return { failure: { externalRef, reason: 'no_messages', ordinal } };

  return {
    page: pageFrom({
      externalRef,
      title: asString(record.name),
      messages,
      occurredAt: parseInstant(record.created_at) ?? messages[0]?.at ?? null,
      branch: 'main',
    }),
  };
}

// ---------------------------------------------------------------------------
// ChatGPT.
// ---------------------------------------------------------------------------

interface TreeNode {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly message: Record_ | null;
}

function chatgptText(message: Record_): string {
  const content = asRecord(message.content);
  if (content === null) return '';
  const parts = asArray(content.parts);
  if (parts === null) return asString(content.text) ?? '';

  const rendered: string[] = [];
  for (const part of parts) {
    // Non-string parts are image pointers and tool payloads. U21 owns media;
    // what belongs here is not inventing text for something that has none.
    if (typeof part === 'string' && part.length > 0) rendered.push(part);
  }
  return rendered.join('\n');
}

function chatgptAttachments(message: Record_): ParsedAttachment[] {
  const metadata = asRecord(message.metadata);
  if (metadata === null) return [];
  const attachments: ParsedAttachment[] = [];
  for (const raw of asArray(metadata.attachments) ?? []) {
    const record = asRecord(raw);
    if (record === null) continue;
    const fileName = asString(record.name);
    if (fileName === null) continue;
    attachments.push({
      fileName,
      mediaType: asString(record.mime_type),
      extractedContent: null,
    });
  }
  return attachments;
}

/** User and assistant only. System prompts and tool plumbing are not the
 * conversation, and a hidden system message is hidden for a reason. */
function visibleMessage(node: TreeNode): RenderedMessage | null {
  const message = node.message;
  if (message === null) return null;

  const author = asRecord(message.author);
  const role = author === null ? null : asString(author.role);
  if (role !== 'user' && role !== 'assistant') return null;

  const metadata = asRecord(message.metadata);
  if (metadata !== null && metadata.is_visually_hidden_from_conversation === true) return null;

  const text = redactSetupCapabilities(chatgptText(message));
  const attachments = chatgptAttachments(message).map(redactAttachment);
  if (text.length === 0 && attachments.length === 0) return null;

  return { role, at: parseInstant(message.create_time), text, attachments };
}

function readTree(mapping: Record_): Map<string, TreeNode> {
  const nodes = new Map<string, TreeNode>();
  for (const [key, raw] of Object.entries(mapping)) {
    const record = asRecord(raw);
    if (record === null) continue;
    const children: string[] = [];
    for (const child of asArray(record.children) ?? []) {
      const id = asString(child);
      if (id !== null) children.push(id);
    }
    nodes.set(key, {
      id: asString(record.id) ?? key,
      parent: asString(record.parent),
      children,
      message: asRecord(record.message),
    });
  }
  return nodes;
}

/** Root-to-leaf, by walking parents. Cycle-safe: a malformed export that points
 * a node at its own ancestor would otherwise hang the import. */
function pathToRoot(nodes: Map<string, TreeNode>, leaf: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leaf;
  while (cursor !== null && nodes.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    path.push(cursor);
    cursor = nodes.get(cursor)?.parent ?? null;
  }
  return path.reverse();
}

/**
 * The branch the user kept: `current_node` when the export names one this
 * mapping actually holds, and otherwise the deepest leaf with ties broken by
 * node id — so two runs over the same bytes agree, which is what the raw
 * round-trip requires.
 */
function mainLeaf(nodes: Map<string, TreeNode>, currentNode: string | null): string | null {
  if (currentNode !== null && nodes.has(currentNode)) return currentNode;

  let best: { id: string; depth: number } | null = null;
  for (const id of [...nodes.keys()].sort()) {
    if ((nodes.get(id)?.children.length ?? 0) > 0) continue;
    const depth = pathToRoot(nodes, id).length;
    if (best === null || depth > best.depth) best = { id, depth };
  }
  return best?.id ?? null;
}

function parseChatgptConversation(
  value: unknown,
  ordinal: number,
): { readonly pages: ParsedConversation[] } | { readonly failure: ParseFailure } {
  const record = asRecord(value);
  if (record === null) return { failure: { externalRef: null, reason: 'not_an_object', ordinal } };

  const id = asString(record.conversation_id) ?? asString(record.id);
  if (id === null) return { failure: { externalRef: null, reason: 'no_identifier', ordinal } };
  const externalRef = `chatgpt:${id}`;

  const mapping = asRecord(record.mapping);
  if (mapping === null) return { failure: { externalRef, reason: 'no_messages', ordinal } };

  const nodes = readTree(mapping);
  const leaf = mainLeaf(nodes, asString(record.current_node));
  if (leaf === null) return { failure: { externalRef, reason: 'no_messages', ordinal } };

  const mainPath = pathToRoot(nodes, leaf);
  const onMain = new Set(mainPath);
  const title = asString(record.title);

  const mainMessages: RenderedMessage[] = [];
  for (const nodeId of mainPath) {
    const node = nodes.get(nodeId);
    if (node === undefined) continue;
    const message = visibleMessage(node);
    if (message !== null) mainMessages.push(message);
  }

  if (mainMessages.length === 0) return { failure: { externalRef, reason: 'no_messages', ordinal } };

  const pages: ParsedConversation[] = [
    pageFrom({
      externalRef,
      title,
      messages: mainMessages,
      occurredAt: parseInstant(record.create_time) ?? mainMessages[0]?.at ?? null,
      branch: 'main',
    }),
  ];

  // Divergent branches: everything the user navigated away from. Each carries
  // only the segment that diverged, so the shared prefix is embedded once.
  for (const nodeId of [...nodes.keys()].sort()) {
    const node = nodes.get(nodeId);
    if (node === undefined || node.children.length > 0 || onMain.has(nodeId)) continue;

    const segment: RenderedMessage[] = [];
    for (const candidate of pathToRoot(nodes, nodeId)) {
      if (onMain.has(candidate)) continue;
      const branchNode = nodes.get(candidate);
      if (branchNode === undefined) continue;
      const message = visibleMessage(branchNode);
      if (message !== null) segment.push(message);
    }
    if (segment.length === 0) continue;

    pages.push(
      pageFrom({
        externalRef: `${externalRef}#${nodeId}`,
        title,
        messages: segment,
        occurredAt: segment[0]?.at ?? null,
        branch: 'alternate',
      }),
    );
  }

  return { pages };
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

/** Parse an already-decoded export document. */
export function parseChatExport(value: unknown): ChatExportParse {
  const format = detectChatExportFormat(value);
  const conversations = conversationsOf(value);

  if (format === null || conversations === null) {
    return {
      format: null,
      conversations: [],
      failures: [{ externalRef: null, reason: 'unknown_format', ordinal: 0 }],
    };
  }

  const pages: ParsedConversation[] = [];
  const failures: ParseFailure[] = [];

  for (const [ordinal, candidate] of conversations.entries()) {
    if (format === 'claude') {
      const parsed = parseClaudeConversation(candidate, ordinal);
      if ('failure' in parsed) failures.push(parsed.failure);
      else pages.push(parsed.page);
      continue;
    }
    const parsed = parseChatgptConversation(candidate, ordinal);
    if ('failure' in parsed) failures.push(parsed.failure);
    else pages.push(...parsed.pages);
  }

  return { format, conversations: pages, failures };
}

/** Parse the bytes as they were stored under `{tenant}/raw/`. */
export function parseChatExportBytes(bytes: Uint8Array): ChatExportParse {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      format: null,
      conversations: [],
      failures: [{ externalRef: null, reason: 'unreadable_json', ordinal: 0 }],
    };
  }
  return parseChatExport(document);
}
