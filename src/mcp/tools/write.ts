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
import { invalid, stringArg, type Handler, type HandlerFailure } from './context.ts';

/**
 * The source types a `remember` may declare.
 *
 * Deliberately short, and deliberately excluding every externally-sourced type:
 * a caller that could declare `email` could stamp its own writes with an
 * attestation channel that belongs to content an outsider produced.
 */
const ALLOWED_SOURCE_TYPES = new Set(['note', 'document', 'file']);

/**
 * What one `remember` may spend. Micro-USD, integer, and named as a ceiling
 * rather than as money: the canonical pricing table is the only place in `src/`
 * that may name a price, and this is a limit on spending rather than a rate.
 *
 * One statement, chunked and embedded through the routed embedding seat at
 * 11,800 µUSD per million input tokens — a 10,000-character statement is 2,500
 * tokens, about 30 µUSD, and the write path embeds the extracted fact beside the
 * chunk, so call the ordinary ceiling ~60 µUSD. This is roughly ten times that:
 * wide enough that no honest write meets it, narrow enough that a caller pasting
 * a book into one tool call gets a typed refusal instead of a bill.
 *
 * **Re-derived when the seat moved, and that is the maintenance this constant
 * needs.** It was 6,000 against an embedding seat priced eleven times higher. A
 * ceiling left at the old number after the price fell is not a safer ceiling —
 * it is a ceiling that has quietly stopped being ten times ordinary and started
 * being a hundred, which is the number at which a pasted book becomes an
 * ordinary write. Exported so the test that exercises it sizes its input against
 * this rather than against a price, which is the thing that moved.
 */
export const REMEMBER_SPEND_CEILING = 600;

export const remember: Handler = async (ctx, args) => {
  const statement = stringArg(args, 'statement');
  if (statement === null) {
    return invalid(
      'remember needs a `statement`.',
      'Pass `statement` as the single claim to store, written as a sentence — "Ada prefers ' +
        'async updates", not a topic or a keyword. One claim per call; the write path ' +
        'de-duplicates, so restating something already known costs nothing.',
    );
  }

  // U21 step 4, and it runs *before* the write: a caller that declared a file
  // gets an answer about the file, not a memory of the sentence describing it.
  // Storing the prose and saying nothing about the attachment is the silent
  // acceptance the whole media path is designed against.
  const mediaType = stringArg(args, 'media_type');
  if (mediaType !== null) {
    return invalid(
      rememberMediaMessage(mediaPolicyForRemember(mediaType)),
      'Store what you want remembered about the attachment as a `statement` in words, with no ' +
        '`media_type`. This tool writes one claim; it does not ingest files.',
    );
  }

  const declared = stringArg(args, 'source_type') ?? 'note';
  if (!ALLOWED_SOURCE_TYPES.has(declared)) {
    return invalid(
      `\`source_type\` must be one of ${[...ALLOWED_SOURCE_TYPES].join(', ')}.`,
      'Omit `source_type` unless the user is dictating from a document or a file — it defaults to ' +
        '`note`, which is right for anything said in conversation. Types naming an external ' +
        'channel are not writable here: those are stamped by the connector that imported them.',
    );
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
      budget: createBudget({ label: 'mcp-remember', capMicroUsd: REMEMBER_SPEND_CEILING }),
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
      suggestion:
        failure.reason === 'embed_failed'
          ? 'Nothing was written, so retrying is safe. The embedding provider did not answer — try ' +
            'the same call again shortly, and tell the user it is not stored yet if it fails twice.'
          : 'Nothing was written. Shorten `statement` to the single claim worth keeping and try ' +
            'again — a whole document pasted into one call is refused rather than billed.',
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

/**
 * The one refusal for "no such record to retract", shared by both sites for the
 * reason `read.ts` shares its own: an id that does not parse and an id naming no
 * live row are the same fact to a caller, so two sentences here would
 * re-introduce the distinction the codes stopped making.
 */
const noSuchRecordToRetract = (): HandlerFailure => ({
  ok: false,
  code: 'not_found',
  message: 'No such record.',
  suggestion:
    'Ids are minted by this brain and are only valid inside it. Run `recall` or `search` and pass ' +
    "a result's `id` field back verbatim. If it was already retracted, it is already gone from " +
    'reads — retracting again is not an error and returns an empty cascade.',
});

export const forget: Handler = async (ctx, args) => {
  const raw = stringArg(args, 'id');
  if (raw === null) {
    return invalid(
      'forget needs an `id`.',
      'Pass `id` as the opaque id of the one record to retract. Run `recall` or `search` first ' +
        "and pass a result's `id` field back verbatim.",
    );
  }

  // Same rule as `recall({id})`: the schema declares `id` as a plain string, so
  // an id this brain never issued is `not_found` however it is malformed. A
  // missing `id` above stays `invalid_params` — that one the schema does reject.
  const parsed = parseId(raw);
  if (parsed === null) return noSuchRecordToRetract();

  const outcome = await forgetRecord(ctx.sql, { id: parsed, grant: ctx.grant, now: ctx.now });
  if (!outcome.ok) {
    return outcome.reason === 'scope_denied'
      ? {
          ok: false,
          code: 'scope_denied',
          message: 'That record is outside the origins this connection may reach.',
          suggestion:
            'This connection is scoped to part of the brain and that record sits outside it. No ' +
            'parameter widens it — retract what this connection can reach, or ask the user to do ' +
            'it themselves in the web app.',
        }
      : noSuchRecordToRetract();
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
      // **The destination is the notice.** This sentence promised a recovery
      // window for as long as `restoreForgotten` had no production caller — the
      // window was real in the code and unreachable in the product, which is a
      // worse artifact than no promise at all now that the retention lane
      // hard-deletes. Naming the page is what converts it into something a user
      // can act on, and `webAppBaseUrl` is already on the context because the
      // manage twin and the panel deep-link through it.
      `Retracted, not erased: it stops being returned now and can be restored until ${outcome.recoverableUntil} at ${ctx.webAppBaseUrl.replace(/\/+$/, '')}/retractions.`,
    ],
  };
};
