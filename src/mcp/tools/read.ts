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

import { briefing as assembleBriefing, type BriefingRecord } from '../../core/briefing/assemble.ts';
import { recall as rankedRead } from '../../core/search/read.ts';
import { formatId, recordUrl } from '../ids.ts';
import { parseId } from '../ids.ts';
import { demarcateIfExternal } from '../demarcation.ts';
import { degradedBriefing, degradedSearch } from '../envelope.ts';
import { entityCard, fetchRecord } from '../reads.ts';
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
  // **`not_found`, not `invalid_params`, and the schema is why.** `recall`
  // declares `id` as a plain `string` with no pattern: the id grammar is
  // deliberately unpublished, because ids are minted here and a caller able to
  // construct one would be addressing rows rather than quoting them back. A
  // caller's string is therefore never the wrong *type* — whether it names a
  // record is a lookup, and a lookup that finds nothing is `not_found`.
  // Answering `invalid_params` published the grammar in the vocabulary reserved
  // for parameters the schema itself rejects, and split one fact the caller
  // cannot act on differently into two codes it would branch on.
  const parsed = parseId(rawId);
  if (parsed === null) return { ok: false, code: 'not_found', message: 'No such record.' };

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

/**
 * `briefing` — the standing bundle, assembled by SQL over U11's materialised
 * output.
 *
 * **The whole assembly lives in `core/briefing/assemble.ts`**, which is where
 * the "no request-time fan-out that scales with corpus size" constraint is
 * argued statement by statement. This handler does four things and no more:
 * parse the window, call it, wrap every piece of row content in R2a's
 * demarcation, and put the bounded upgrade prompt in the advisory lane.
 *
 * **Degraded is now conditional.** A cold layer — a brain that has never
 * consolidated, or a free-tier brain that never will — gets `briefing_degraded`
 * and a `not_included` list naming what the paid tier would add (R8). A
 * consolidated one gets neither, because a bundle that keeps announcing missing
 * cards while returning them teaches an agent to distrust the shape.
 *
 * **Every participant card is demarcated too.** A card is a model's summary of
 * mail an outsider wrote; returning it outside the untrusted region would be the
 * exact laundering R2a's wrapper exists to prevent, one derivation removed.
 */
export const briefing: Handler = async (ctx, args) => {
  const until = stringArg(args, 'until') ?? ctx.now.toISOString();
  // `null` is passed through rather than defaulted here, and that is the seam
  // the delta rule hangs on: the assembler has to be able to tell "no window
  // asked for" from "a window that happens to equal the default", because the
  // first reads the connection's bookmark and moves it while the second does
  // neither. Defaulting at this layer erased the difference.
  const since = stringArg(args, 'since');
  if ((since !== null && Number.isNaN(Date.parse(since))) || Number.isNaN(Date.parse(until))) {
    return invalid('`since` and `until` must be ISO dates.');
  }

  const focus = stringArg(args, 'focus');
  const bundle = await assembleBriefing(ctx.sql, ctx.grant, {
    since,
    until,
    focus,
    callerKey: ctx.callerKey,
    now: ctx.now,
    budgetTokens: intArg(args, 'budget_tokens', DEFAULT_BRIEFING_TOKENS, MAX_BRIEFING_TOKENS),
  });

  const wrap = (record: BriefingRecord): ProjectedRecord =>
    project(
      {
        id: formatId(record.kind, record.id),
        kind: record.kind,
        title: record.title,
        text: record.text,
        origins: record.origins,
        sourceType: record.sourceType,
        createdAt: record.createdAt,
      },
      ctx.nonce,
    );

  const degraded = degradedBriefing(await ctx.indexState(), {
    materialized: bundle.coverage === 'materialized',
  });

  // The advisory lane, and both of its tenants. Each carries its own dismissal
  // because each is bounded by its own rule — a shared sentence would describe
  // one of them wrongly, and this is the lane whose whole justification is that
  // the reader can trust what it says about how often it will say it again.
  const notice = [
    ...(bundle.prompt === null ? [] : [`${bundle.prompt.text} ${bundle.prompt.dismissal}`]),
    ...(bundle.backup === null ? [] : [`${bundle.backup.text} ${bundle.backup.dismissal}`]),
  ];

  return {
    ok: true,
    ...(degraded === null ? {} : { resultClass: 'degraded' as const }),
    degraded,
    ...(notice.length === 0 ? {} : { notice }),
    content: {
      coverage: bundle.coverage,
      tier: bundle.tier,
      window: bundle.window,
      ...(focus === null ? {} : { focus }),
      meetings: bundle.meetings.map((meeting) => ({
        ...wrap(meeting),
        // When the meeting *is*, which is what the lane sorted on. `created_at`
        // rides along from the shared projection and stays what it says it is:
        // when this brain heard about it.
        occurred_at: meeting.occurredAt,
        participants: meeting.participants.map((person) => ({
          id: formatId('ent', person.entityId),
          name: person.name,
          card:
            person.card === null
              ? null
              : demarcateIfExternal(person.card, person.origins, ctx.nonce).text,
        })),
      })),
      commitments: bundle.commitments.map((commitment) => ({
        id: formatId('fact', commitment.id),
        statement: demarcateIfExternal(commitment.statement, commitment.origins, ctx.nonce).text,
        owner: commitment.owner,
        due_on: commitment.dueOn,
        // R12a's stored admission decision, surfaced rather than recomputed.
        corroborated: commitment.compiledTruth,
      })),
      delta: {
        since: bundle.delta.since,
        // Which rule put the delta where it starts. A reader who asked for a
        // week and a reader who asked for nothing get different answers from
        // the same field, and this is what tells them apart.
        basis: bundle.delta.basis,
        first_read: bundle.delta.firstRead,
        changed: bundle.delta.changed.map(wrap),
        stated: bundle.delta.stated.map(wrap),
      },
      stale: bundle.stale.map((entry) => ({
        id: formatId('doc', entry.id),
        title:
          entry.title === null
            ? null
            : demarcateIfExternal(entry.title, entry.origins, ctx.nonce).text,
        stale_at: entry.staleAt,
        relevance: entry.relevance,
      })),
      counts: {
        contradictions: bundle.counts.contradictions,
        pending_debt: bundle.counts.pendingDebt,
        pending_review: bundle.counts.pendingReview,
        uncorroborated_claims: bundle.counts.uncorroboratedClaims,
      },
      tokens: bundle.tokens,
      not_included: bundle.notIncluded,
    },
  };
};
