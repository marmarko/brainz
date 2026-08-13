/**
 * The tool table — nine names on the wire, seven advertised on any endpoint
 * (KTD3).
 *
 * **Definitions live here and nowhere else.** gbrain grew three inline schema
 * mappers that drifted until the live HTTP path silently dropped `items` for a
 * release; the fix upstream was one generator, and the fix here is one table
 * that `tools/list`, the envelope's referential check, the `brain` tool's
 * published matrix and the definitions digest all read.
 *
 * **Seven advertised, and which seven depends on the endpoint rather than on
 * the caller's claimed identity.** `io.modelcontextprotocol/clientInfo` is
 * self-reported and only *SHOULD* be sent, so sniffing it to decide the surface
 * means one missing header rejects a connector. The user picks an endpoint at
 * install and the grant binds to it. `/mcp` advertises `recall`; `/openai`
 * advertises `search`, which is `recall`'s query mode under OpenAI's mandated
 * schema. Each endpoint therefore advertises exactly seven names.
 *
 * **`search` stays dispatchable on `/mcp` and `recall` on `/openai`.** A
 * misrouted install still works; it simply does not spend prompt tokens
 * advertising a synonym. That is the reading that satisfies KTD3's headline
 * number — seven in front of any model — without breaking a caller who arrives
 * with the other endpoint's vocabulary.
 *
 * **`manage` is advertised nowhere and needs a nonce.** SEP-1865 panel actions
 * can only ride `tools/call`, and the action enum it carries is an anti-pattern
 * for a model precisely because no model is meant to select it. Whether hosts
 * forward `tools/call` for a name absent from `tools/list` is unconfirmed; if
 * they refuse, this becomes an eighth advertised name and is still safe, because
 * a model holds no nonce and the enum contains nothing worth reaching.
 *
 * **`synthesize` is dispatchable and returns `unavailable`.** A caller carrying
 * gbrain's frozen five gets an actionable error naming `briefing` rather than
 * `unknown_tool`. brainz declares `memory-verbs-v1-partial` and publishes the
 * delta rather than pretending to conform.
 *
 * **`openWorldHint: false` on all nine.** The spec default is `true`, which
 * tells a client these tools reach an unbounded external world. For a per-user
 * Neon project that is simply false, and it is the kind of thing that never gets
 * fixed after it ships.
 */

import { createHash } from 'node:crypto';

import { CAPTURE_AND_CONSULT_CLAUSE, UNTRUSTED_DATA_CLAUSE } from '../instructions.ts';

export const ENDPOINTS = ['mcp', 'openai'] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/** The nine names on the wire. Frozen: a name never changes meaning (R21). */
export const TOOL_NAMES = [
  'recall',
  'search',
  'fetch',
  'entity',
  'briefing',
  'remember',
  'forget',
  'brain',
  'manage',
  'synthesize',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  /** Always false. A per-user Neon project is not an open world. */
  readonly openWorldHint: false;
}

export interface ParamDef {
  readonly type: 'string' | 'integer' | 'boolean';
  readonly description: string;
  readonly required?: boolean;
  readonly enum?: readonly string[];
}

export interface ToolDef {
  readonly name: ToolName;
  readonly description: string;
  readonly params: Readonly<Record<string, ParamDef>>;
  readonly annotations: ToolAnnotations;
  /** Endpoints whose `tools/list` names this tool. */
  readonly advertisedOn: readonly Endpoint[];
  /** Endpoints that will dispatch it. A superset of {@link advertisedOn}. */
  readonly dispatchableOn: readonly Endpoint[];
  /** `manage` only: refused without a short-TTL panel nonce. */
  readonly requiresPanelNonce?: boolean;
}

const READ: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * The trip-wire's param budget: eight model-facing parameters per tool.
 *
 * Calibrated on gbrain's most-loaded verb, which ships ten — two of them a mode
 * switch and a client-side filter. It is a judgement call rather than a
 * measurement, and it is written down so that exceeding it is a decision rather
 * than a drift.
 */
export const MAX_PARAMS = 8;

const BOTH: readonly Endpoint[] = ['mcp', 'openai'];

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'recall',
    description:
      `Relevance-ranked read over this person's brain — consolidated facts and the source passages behind them. ${CAPTURE_AND_CONSULT_CLAUSE} ` +
      'Pass `query` for a question, or `id` to re-read one identified record in full. ' +
      `${UNTRUSTED_DATA_CLAUSE}`,
    params: {
      query: { type: 'string', description: 'The question, in the user\'s own words.' },
      id: {
        type: 'string',
        description: 'An opaque id from an earlier result (`fact:`, `doc:`, `chunk:`, `ent:`) to read in full.',
      },
      entity: { type: 'string', description: 'Narrow to one person, company or project by name.' },
      limit: { type: 'integer', description: 'Maximum results. Default 10.' },
      budget_tokens: { type: 'integer', description: 'Token ceiling for the packed payload.' },
      // `since`, `until` and `relation` are deliberately ABSENT, and the absence
      // is worth more than the parameters would be. A declared parameter the
      // handler ignores returns unfiltered results with no error — silently
      // wrong answers, which is the failure mode the whole trip-wire exists to
      // avoid. And this schema is frozen additively: publishing them now makes
      // removing them a breaking change forever. The temporal read the ledger
      // asks for is `briefing(since, until)`, which is implemented; a date
      // filter on the ranked read belongs in U5's arms rather than as a
      // post-rank filter here, because filtering after ranking is exactly the
      // post-filter recall collapse hazard H3 documents.
    },
    annotations: { title: 'recall (ranked read)', ...READ },
    advertisedOn: ['mcp'],
    dispatchableOn: BOTH,
  },
  {
    name: 'search',
    description:
      `Search this person's brain and return matching records. ${CAPTURE_AND_CONSULT_CLAUSE} ` +
      'Use `fetch` to read any result in full. ' +
      `${UNTRUSTED_DATA_CLAUSE}`,
    params: {
      query: { type: 'string', description: 'The search query.', required: true },
    },
    annotations: { title: 'search (ranked read)', ...READ },
    advertisedOn: ['openai'],
    dispatchableOn: BOTH,
  },
  {
    name: 'fetch',
    description:
      'Read one identified record in full — no ranking, no token budget. Takes an opaque id from `search` or `recall`. ' +
      `${UNTRUSTED_DATA_CLAUSE}`,
    params: {
      id: { type: 'string', description: 'The opaque id (`fact:`, `doc:`, `chunk:`, `ent:`).', required: true },
    },
    annotations: { title: 'fetch (one record in full)', ...READ },
    advertisedOn: BOTH,
    dispatchableOn: BOTH,
  },
  {
    name: 'entity',
    description:
      'One person, company or project as a typed card — who they are, what is known, what changed. Fast and free: no model call. Never errors on a miss; returns suggestions instead. ' +
      `${UNTRUSTED_DATA_CLAUSE}`,
    params: {
      name: { type: 'string', description: 'The name as the user said it. Aliases resolve.', required: true },
    },
    annotations: { title: 'entity (one card)', ...READ },
    advertisedOn: BOTH,
    dispatchableOn: BOTH,
  },
  {
    name: 'briefing',
    description:
      'The standing bundle for a moment — what changed, what is open, who is involved — assembled by SQL over what the brain already knows. You write the prose. ' +
      `${UNTRUSTED_DATA_CLAUSE}`,
    params: {
      since: { type: 'string', description: 'ISO date the window opens. Default: 24h ago.' },
      until: { type: 'string', description: 'ISO date the window closes. Default: now.' },
      focus: { type: 'string', description: 'Narrow the bundle to one person, project or topic.' },
      budget_tokens: { type: 'integer', description: 'Token ceiling for the bundle.' },
    },
    annotations: { title: 'briefing (standing bundle)', ...READ },
    advertisedOn: BOTH,
    dispatchableOn: BOTH,
  },
  {
    name: 'remember',
    description:
      `Store something this person told you, in their words. ${CAPTURE_AND_CONSULT_CLAUSE} ` +
      'Returns `duplicate` rather than writing twice, so restating a known fact is free and safe.',
    params: {
      statement: { type: 'string', description: 'The fact or note, in the user\'s own words.', required: true },
      title: { type: 'string', description: 'Optional title for a longer note.' },
      source_type: {
        type: 'string',
        description: 'What kind of thing this is. Default `note`.',
        enum: ['note', 'document', 'file'],
      },
    },
    annotations: {
      title: 'remember (store one fact or note)',
      readOnlyHint: false,
      destructiveHint: false,
      // A duplicate statement writes nothing and returns the existing id, so a
      // retried call has the same effect as the first one.
      idempotentHint: true,
      openWorldHint: false,
    },
    advertisedOn: BOTH,
    dispatchableOn: BOTH,
  },
  {
    name: 'forget',
    description:
      'Retract one record by id. The record stops being returned immediately and stays recoverable for 72 hours; nothing is erased by this call.',
    params: {
      id: { type: 'string', description: 'The opaque id to retract.', required: true },
      // No `reason`. There is nowhere to keep one: the tombstone is a
      // `deleted_at` on the row itself, and a free-text retraction note is
      // exactly the shape that turns a content-free audit trail into a place
      // where a model's paraphrase of the user's mail lives. The retraction
      // *history* — who, when, why, and the version it restored — is U17's,
      // where versions live and a column for it can be designed rather than
      // borrowed. Declaring the parameter now would be a promise this handler
      // silently drops, permanently, under an additive-forever schema.
    },
    annotations: {
      title: 'forget (retract one record)',
      readOnlyHint: false,
      // The hard law of the surface: a retraction carries destructiveHint where
      // a create does not, because every client gates confirmation per tool.
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    advertisedOn: BOTH,
    dispatchableOn: BOTH,
  },
  {
    name: 'brain',
    description:
      'What this brain is: inventory counts, health, the isolation attestation, and the published tool matrix. Read-only self-report; answer privacy and "what do you actually have" questions from it.',
    params: {},
    annotations: { title: 'brain (self-report)', ...READ },
    advertisedOn: BOTH,
    dispatchableOn: BOTH,
  },
  {
    name: 'manage',
    description:
      'Panel control plane. Reversible settings only, and only from a panel view holding a short-TTL nonce. Not for models.',
    params: {
      action: {
        type: 'string',
        description: 'The setting to change.',
        required: true,
        enum: ['set_context_policy', 'set_spend_cap', 'pause_source', 'resume_source'],
      },
      value: { type: 'string', description: 'The new value for the action.' },
      panel_nonce: { type: 'string', description: 'The nonce minted into the panel at resources/read.', required: true },
    },
    annotations: {
      title: 'manage (panel settings)',
      readOnlyHint: false,
      // Every action is reversible by construction. Disconnect, delete, export
      // and sharing deep-link to the web app instead of living here, which is
      // what lets this hint be honest rather than annotated around.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    advertisedOn: [],
    dispatchableOn: ['mcp'],
    requiresPanelNonce: true,
  },
  {
    name: 'synthesize',
    description:
      'Not available on this server. Use `briefing`, which assembles the same material from work already paid for.',
    params: {
      query: { type: 'string', description: 'Ignored.' },
    },
    annotations: { title: 'synthesize (unavailable)', ...READ },
    advertisedOn: [],
    dispatchableOn: BOTH,
  },
];

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((tool) => [tool.name, tool]));

export function toolByName(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** What `tools/list` returns on an endpoint. Exactly seven names, by construction. */
export function advertisedTools(endpoint: Endpoint): readonly ToolDef[] {
  return TOOLS.filter((tool) => tool.advertisedOn.includes(endpoint));
}

export function isDispatchable(name: string, endpoint: Endpoint): boolean {
  const tool = BY_NAME.get(name);
  return tool !== undefined && tool.dispatchableOn.includes(endpoint);
}

/** The JSON Schema an MCP client sees for one tool. Generated, never hand-written. */
export function inputSchemaFor(tool: ToolDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(tool.params)) {
    properties[name] = {
      type: def.type,
      description: def.description,
      ...(def.enum === undefined ? {} : { enum: [...def.enum] }),
    };
    if (def.required === true) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * The digest a client can pin, and the `brain` tool publishes.
 *
 * Covers names, descriptions, schemas and annotations — everything an
 * enterprise admin would have approved — so a silent change to any of them is
 * visible as a changed digest rather than as a surprise at review time.
 */
export function definitionsDigest(): string {
  const canonical = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: inputSchemaFor(tool),
    annotations: tool.annotations,
    advertisedOn: [...tool.advertisedOn],
  }));
  // sha256 for the same reason `instructionsDigest` uses it: a digest a
  // client pins must not change because the runtime changed.
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}
