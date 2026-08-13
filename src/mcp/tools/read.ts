/**
 * The read handlers: `recall`, its two projections, `entity` and `briefing`.
 *
 * **`search` and `fetch` are projections, not tools.** One handler, two shapes:
 * `search` is `recall`'s query mode rendered under OpenAI's mandated
 * `{results:[{id,title,url}]}`, and `fetch` is `recall({id})` rendered as one
 * whole record. They call the same functions in the same order, which is what
 * makes the equivalence test a *pin* rather than a coincidence — and it is why
 * the authorization check cannot live in a handler: a scope check added to
 * `fetch` and not to `recall({id})` is a cross-origin read that comparing two
 * same-grant results would never surface.
 *
 * **Nothing here issues SQL or resolves a credential.** Both live one layer up
 * (`reads.ts`, `dispatch.ts`), enforced by a scan.
 */

import { estimateTokens } from '../../core/search/pipeline.ts';
import { recall as rankedRead } from '../../core/search/read.ts';
import { recordUrl } from '../ids.ts';
import { parseId } from '../ids.ts';
import { degradedBriefing, degradedSearch } from '../envelope.ts';
import { briefingBundle, entityCard, fetchRecord } from '../reads.ts';
import {
  intArg,
  invalid,
  project,
  stringArg,
  type Handler,
  type HandlerOutcome,
  type ProjectedRecord,
  type ToolContext,
} from './context.ts';

/** Where a record is addressable in the user's own web app (U15). */
const RECORD_BASE = 'https://app.brainz.test';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** The briefing's default and maximum token ceilings. */
const DEFAULT_BRIEFING_TOKENS = 4000;
const MAX_BRIEFING_TOKENS = 32_000;

/**
 * `recall` — the ranked read, and the id-addressed read.
 *
 * Two modes rather than two tools because the *response contract* is the same
 * list of records either way; what differs is how many and how they were found.
 */
export const recall: Handler = async (ctx, args) => {
  const id = stringArg(args, 'id');
  if (id !== null) return recallById(ctx, id);

  const query = stringArg(args, 'query') ?? stringArg(args, 'entity');
  if (query === null) return invalid('recall needs either `query` or `id`.');

  const limit = intArg(args, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const response = await rankedRead({
    sql: ctx.sql,
    gateway: ctx.gateway,
    tenantId: ctx.tenantId,
    caller: ctx.caller,
    query,
    grant: ctx.grant,
    limit,
    now: ctx.now,
    ...(args.budget_tokens === undefined
      ? {}
      : { compose: { budget: { maxTokens: intArg(args, 'budget_tokens', 4000, 100_000) } } }),
  });

  const results: ProjectedRecord[] = response.results.map((scored) =>
    project(
      {
        id: `chunk:${scored.candidate.id}`,
        kind: 'chunk',
        title: scored.candidate.title,
        text: scored.candidate.content,
        origins: [scored.candidate.origin],
        sourceType: scored.candidate.sourceType,
        createdAt: scored.candidate.createdAt,
      },
      ctx.nonce,
    ),
  );

  // `snippet` exists for the `/openai` title fallback and is redundant next to
  // a full body, so it is dropped from this shape rather than paid for on every
  // ranked result. Both shapes still come off the same projection.
  const onWire = results.map(({ snippet: _snippet, ...rest }) => rest);

  const state = await ctx.indexState();
  const degraded = degradedSearch(state, response.degraded);
  const top = response.results[0];

  return {
    ok: true,
    projection: results,
    content: {
      results: onWire,
      total: onWire.length,
      intent: response.intent,
      tokens: response.tokens,
      arms_used: response.armsUsed,
    },
    degraded,
    ...(degraded === null ? {} : { resultClass: 'degraded' as const }),
    ...(state.pages === 0 && state.chunks === 0
      ? {
          setup: {
            kind: 'first_memory' as const,
            detail:
              'This brain has nothing in it yet. Store the first thing this person tells you about themselves with `remember`.',
          },
        }
      : {}),
    ...(top === undefined ? {} : { rank1Score: top.score }),
  };
};

/** `recall({id})` — the whole-record read, in the ranked read's shape. */
async function recallById(ctx: ToolContext, rawId: string): Promise<HandlerOutcome> {
  const parsed = parseId(rawId);
  if (parsed === null) return invalid(`\`${rawId}\` is not a record id this brain issued.`);

  const outcome = await fetchRecord(ctx.sql, ctx.grant, parsed);
  if (outcome.status !== 'ok') {
    return outcome.status === 'scope_denied'
      ? {
          ok: false,
          code: 'scope_denied',
          message: 'That record is outside the origins this connection may read.',
        }
      : { ok: false, code: 'not_found', message: 'No such record.' };
  }

  const projected = project(outcome.record, ctx.nonce);
  const { snippet: _snippet, ...onWire } = projected;
  return { ok: true, projection: [projected], content: { results: [onWire], total: 1 } };
}

/**
 * `search` — `recall`'s query mode under OpenAI's mandated schema.
 *
 * Same handler, same order, same fence; only the rendering differs. The
 * equivalence test asserts the ids match in order, which is the property that
 * makes "one handler, two projections" true rather than aspirational.
 */
export const search: Handler = async (ctx, args) => {
  const query = stringArg(args, 'query');
  if (query === null) return invalid('search needs a `query`.');

  const outcome = await recall(ctx, { query, ...(args.limit === undefined ? {} : { limit: args.limit }) });
  if (!outcome.ok) return outcome;

  return {
    ...outcome,
    content: {
      results: (outcome.projection ?? []).map((record) => ({
        id: record.id,
        // The title, or a demarcated excerpt of the body. Never a slice off the
        // already-wrapped text, which would cut the opening marker in half and
        // hand the model an unterminated region.
        title: record.title ?? record.snippet,
        url: recordUrl(RECORD_BASE, record.id),
      })),
    },
  };
};

/** `fetch` — `recall({id})`, rendered as one record rather than a list of one. */
export const fetchOne: Handler = async (ctx, args) => {
  const id = stringArg(args, 'id');
  if (id === null) return invalid('fetch needs an `id`.');

  const outcome = await recallById(ctx, id);
  if (!outcome.ok) return outcome;

  const record = outcome.projection?.[0];
  if (record === undefined) return { ok: false, code: 'not_found', message: 'No such record.' };

  return {
    ok: true,
    content: {
      id: record.id,
      title: record.title,
      text: record.text,
      url: recordUrl(RECORD_BASE, record.id),
      untrusted: record.untrusted,
      metadata: { source_type: record.source_type, created_at: record.created_at },
    },
  };
};

/**
 * `entity` — one card, no model call, and an honest latency shape.
 *
 * The published promise is warm-p99 under 100ms with the cold path budgeted
 * separately, because per-user Neon with scale-to-zero takes seconds to accept
 * its first query — on exactly the call an agent makes first. `cold_start` is
 * the accessor's own cache-miss observation, so the flag cannot drift from the
 * thing it describes.
 *
 * A miss is never an error: it returns `found: false` with suggestions, because
 * a tool that throws on "I have not heard of this person" teaches a model to
 * stop asking.
 */
export const entity: Handler = async (ctx, args) => {
  const started = performance.now();
  const name = stringArg(args, 'name');
  if (name === null) return invalid('entity needs a `name`.');

  const outcome = await entityCard(ctx.sql, ctx.grant, name);
  const latency = Math.max(0, Math.round(performance.now() - started));

  if (outcome.status === 'scope_denied') {
    return {
      ok: false,
      code: 'scope_denied',
      message: 'That entity is outside the origins this connection may read.',
    };
  }

  if (outcome.status === 'not_found') {
    return {
      ok: true,
      content: {
        found: false,
        latency_ms: latency,
        cold_start: ctx.coldStart,
        suggestions: outcome.suggestions,
      },
    };
  }

  const card = outcome.card;
  return {
    ok: true,
    content: {
      found: true,
      latency_ms: latency,
      cold_start: ctx.coldStart,
      card: {
        id: card.id,
        name: card.name,
        type: card.type,
        aliases: card.aliases,
        facts: card.facts.map((fact) =>
          project(
            { id: fact.id, kind: 'fact', title: null, text: fact.text, origins: fact.origins, sourceType: null, createdAt: '' },
            ctx.nonce,
          ),
        ),
      },
    },
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `briefing` — the standing bundle, assembled by SQL, and honestly degraded.
 *
 * U11 materialises the inputs this tool is designed around: participant cards,
 * extracted commitments, the synopsis layer. Until then it serves what SQL can
 * reach — what arrived and what was stated in the window — marked
 * `briefing_degraded`. Serving it unmarked would teach agents that this is what
 * a briefing is, and the upgrade would then read as a regression in shape.
 */
export const briefing: Handler = async (ctx, args) => {
  const until = stringArg(args, 'until') ?? ctx.now.toISOString();
  const since = stringArg(args, 'since') ?? new Date(ctx.now.getTime() - DAY_MS).toISOString();
  if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) {
    return invalid('`since` and `until` must be ISO dates.');
  }

  const focus = stringArg(args, 'focus');
  const bundle = await briefingBundle(ctx.sql, ctx.grant, { since, until, focus });

  // The token ceiling is applied by *dropping whole rows from the tail*, never
  // by truncating one. A half-quoted external message is a demarcated region
  // with no closing marker, which is the one shape the wrapper exists to make
  // impossible — so the budget must not be able to produce it.
  const budget = intArg(args, 'budget_tokens', DEFAULT_BRIEFING_TOKENS, MAX_BRIEFING_TOKENS);
  const changed: ProjectedRecord[] = [];
  const stated: ProjectedRecord[] = [];
  let spent = 0;
  for (const [into, records] of [
    [changed, bundle.changed],
    [stated, bundle.facts],
  ] as const) {
    for (const record of records) {
      const projected = project(record, ctx.nonce);
      const cost = estimateTokens(projected.text) + estimateTokens(projected.title ?? '');
      if (spent + cost > budget && into.length > 0) break;
      spent += cost;
      into.push(projected);
    }
  }

  return {
    ok: true,
    resultClass: 'degraded',
    degraded: degradedBriefing(await ctx.indexState()),
    content: {
      window: { since, until },
      ...(focus === null ? {} : { focus }),
      changed,
      stated,
      tokens: spent,
      not_included: ['participant_cards', 'extracted_commitments', 'synopsis'],
    },
  };
};
