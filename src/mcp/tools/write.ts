/**
 * The two write handlers, and the two consent classes they exist to separate.
 *
 * **`remember` is the single create path.** It rides U4's write path, so a
 * duplicate statement writes nothing and returns the existing id — which is what
 * makes `idempotentHint: true` honest and makes "restate what you already know"
 * a free action rather than a way to fill retrieval with copies of one claim.
 *
 * **The origin is the grant's, never the caller's.** R15: `origin_context` is
 * credential-derived and immutable. There is deliberately no `origin` parameter
 * on `remember` — a model choosing where a memory lands would be a model
 * choosing which fence it sits behind.
 *
 * **`forget` is a tombstone and says so in its own description.** It carries
 * `destructiveHint: true` where `remember` carries false, because every client
 * gates its confirmation prompt per tool and a bundled write/retract pair makes
 * that prompt unable to say which is happening.
 */

import { remember as writeRemember } from '../../core/write/write-path.ts';
import { mediaPolicyForRemember, rememberMediaMessage } from '../../core/media/accept.ts';
import { createBudget } from '../../ai/gateway.ts';
import { parseId } from '../ids.ts';
import { forgetRecord } from '../tombstone.ts';
import { invalid, stringArg, type Handler } from './context.ts';

/**
 * The source types a `remember` may declare.
 *
 * Deliberately short, and deliberately excluding every externally-sourced type:
 * a caller that could declare `email` could stamp its own writes with an
 * attestation channel that belongs to content an outsider produced.
 */
const ALLOWED_SOURCE_TYPES = new Set(['note', 'document', 'file']);

/**
 * What one `remember` may spend, in micro-USD.
 *
 * One statement, chunked and embedded through `text-embedding-3-large` at
 * 130,000 µUSD per million input tokens — a 10,000-character statement is 2,500
 * tokens, about 325 µUSD, and the write path embeds the extracted fact beside
 * the chunk, so call the ordinary ceiling ~650 µUSD. This is roughly ten times
 * that: wide enough that no honest write meets it, narrow enough that a caller
 * pasting a book into one tool call gets a typed refusal instead of a bill.
 */
const REMEMBER_BUDGET_MICRO_USD = 6_000;

export const remember: Handler = async (ctx, args) => {
  const statement = stringArg(args, 'statement');
  if (statement === null) return invalid('remember needs a `statement`.');

  // U21 step 4, and it runs *before* the write: a caller that declared a file
  // gets an answer about the file, not a memory of the sentence describing it.
  // Storing the prose and saying nothing about the attachment is the silent
  // acceptance the whole media path is designed against.
  const mediaType = stringArg(args, 'media_type');
  if (mediaType !== null) {
    return invalid(rememberMediaMessage(mediaPolicyForRemember(mediaType)));
  }

  const declared = stringArg(args, 'source_type') ?? 'note';
  if (!ALLOWED_SOURCE_TYPES.has(declared)) {
    return invalid(`\`source_type\` must be one of ${[...ALLOWED_SOURCE_TYPES].join(', ')}.`);
  }

  const outcome = await writeRemember(
    {
      sql: ctx.sql,
      gateway: ctx.gateway,
      tenantId: ctx.tenantId,
      caller: ctx.caller,
      // A ceiling on this one write, minted per call. `remember` embeds one
      // statement, so the same order-of-magnitude argument the read path makes
      // applies here with far more room: an uncapped budget on a request-path
      // write is a caller-sized bill, and there is no tenant-level cap on this
      // path to fall back on. A refusal returns `embed_failed` through
      // `writeRemember`'s typed outcome, which is answered as `unavailable`
      // below rather than thrown.
      budget: createBudget({ label: 'mcp-remember', capMicroUsd: REMEMBER_BUDGET_MICRO_USD }),
    },
    {
      // R15, in one line: where this lands is decided by the credential.
      originContext: ctx.writeOrigin,
      statement,
      sourceType: declared as 'note' | 'document' | 'file',
      title: stringArg(args, 'title'),
    },
  );

  if (!('ok' in outcome) || outcome.ok !== true) {
    const failure = outcome as { reason: string };
    return {
      ok: false,
      code: failure.reason === 'embed_failed' ? 'unavailable' : 'invalid_params',
      message: `The memory was not stored (${failure.reason}).`,
    };
  }

  const status = outcome.status;
  return {
    ok: true,
    // A duplicate wrote nothing, so it created no consolidation debt. Counting
    // it would put a tenant into a cycle for work that did not happen.
    debt: status === 'duplicate' ? 0 : 1,
    content: {
      id: `fact:${outcome.id}`,
      status,
      page_id: outcome.pageId === null ? null : `doc:${outcome.pageId}`,
    },
    next: [
      {
        tool: ctx.endpoint === 'openai' ? 'search' : 'recall',
        args: { query: statement.slice(0, 120) },
        why: 'Read it back to confirm it is stored the way the user meant it.',
      },
    ],
  };
};

export const forget: Handler = async (ctx, args) => {
  const raw = stringArg(args, 'id');
  if (raw === null) return invalid('forget needs an `id`.');

  const parsed = parseId(raw);
  if (parsed === null) return invalid(`\`${raw}\` is not a record id this brain issued.`);

  const outcome = await forgetRecord(ctx.sql, { id: parsed, grant: ctx.grant, now: ctx.now });
  if (!outcome.ok) {
    return outcome.reason === 'scope_denied'
      ? {
          ok: false,
          code: 'scope_denied',
          message: 'That record is outside the origins this connection may reach.',
        }
      : { ok: false, code: 'not_found', message: 'No such record.' };
  }

  return {
    ok: true,
    debt: 1,
    content: {
      id: outcome.id,
      deleted_at: outcome.deletedAt,
      recoverable_until: outcome.recoverableUntil,
      cascade: outcome.cascade,
    },
    notice: [
      `Retracted, not erased: it stops being returned now and can be restored until ${outcome.recoverableUntil}.`,
    ],
  };
};
