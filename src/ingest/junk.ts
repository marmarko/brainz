/**
 * The junk gate (U9 approach 3) — heuristics only, and it runs **before the
 * meter**.
 *
 * KTD8 prices a large first import in dollars, and a consumer mailbox is
 * mostly not correspondence: newsletters, promotions, receipts and
 * notifications outnumber the mail a person would ever ask about. Embedding
 * that at full price is the single largest avoidable cost in the product, so
 * the verdict has to be reached *before* anything is encoded — not filtered out
 * of retrieval afterwards, which pays for the vector and then hides it.
 *
 * **Two markers, and the difference between them is money and recall.**
 *
 *   * `hidden` — the item is written, hidden from reads, and **never embedded**.
 *     It reaches U4 through the `quarantine` seam, which is the structural
 *     guarantee: a quarantined page contributes no facts (nothing to embed
 *     synchronously) and its chunks are excluded from the backlog query, so the
 *     saving is a property of the schema rather than of this module being
 *     careful.
 *   * `warned` — machine-generated but worth finding. A receipt is the case
 *     that decides it: "what did I pay for that flight" is a question the brain
 *     should answer, and quarantining every `no-reply@` sender silently drops a
 *     whole class of the user's own records. Warned items are embedded and
 *     searchable; {@link quarantineMarkerFor} returns `null` for them, which is
 *     the one line that keeps warned from collapsing into hidden.
 *
 * **What `warned` does NOT get: a column.** U4's seam is one nullable marker
 * whose only meaning is "quarantine this", and the tenant schema is U3's
 * append-only ladder — a `junk_class` column is a rung, not a line here. So a
 * warned item is stored exactly like ordinary mail (searchable, embedded) and
 * the verdict survives in the pull's result and in the ingest-log disposition
 * (`written`, with `items_quarantined` counting hidden items only). The
 * consequence is stated rather than hidden: a caller cannot later ask the
 * database "which pages were warned". Adding that is a rung whenever a surface
 * needs it; inventing a marker that quarantines instead would trade a missing
 * label for missing mail.
 *
 * **The unknown reads clean, deliberately, and this is the one place in the
 * unit where the safe direction is *not* the closed one.** An item with no
 * headers — every calendar event, every Drive file, and any mail whose provider
 * did not return headers — is ordinary content. Reading an absent signal as
 * junk would quarantine a whole source wholesale and the failure would be
 * invisible: nothing errors, the brain simply stops knowing things. The cost of
 * the opposite mistake is an embedding call.
 *
 * **What this deliberately is not.** There is no model here. Sending mail
 * bodies to a classifier is a trust-boundary decision of the same class as
 * Pipedream's own placement (Gap Register #5) — it needs an explicit call and
 * an entry in R10's register, not a default someone added because accuracy was
 * disappointing. Heuristics over headers cost nothing, leak nothing, and are
 * auditable by the user whose mail they are.
 */

/** What a verdict does to the item. `null` is clean. */
export type JunkVisibility = 'hidden' | 'warned';

/** The marker string stored on a hidden page. Read by U5's quarantine filter. */
export const JUNK_MARKER_BULK = 'junk:bulk';

/** Warned items carry this in the pull's result; it never reaches U4's seam. */
export const JUNK_MARKER_TRANSACTIONAL = 'junk:transactional';

export interface JunkInput {
  /** Provider headers, in whatever case the provider used. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly from?: string | null;
  readonly subject?: string | null;
  /** Gmail label ids, which carry the provider's own bulk classification. */
  readonly labels?: readonly string[];
}

export interface JunkVerdict {
  readonly visibility: JunkVisibility | null;
  readonly marker: string | null;
  /** Which rules fired. Carried so a user can be told *why* mail was hidden. */
  readonly signals: readonly string[];
}

const CLEAN: JunkVerdict = { visibility: null, marker: null, signals: [] };

/**
 * Bulk evidence: the message says of itself that it was sent to a list.
 *
 * `List-Unsubscribe` is the strongest single signal in mail and the one RFC
 * 8058 made near-universal for commercial senders. The rest are the older
 * conventions that still appear.
 */
const BULK_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['list-unsubscribe', 'list-unsubscribe'],
  ['list-id', 'list-id'],
  ['x-campaign-id', 'campaign-header'],
  ['x-feedback-id', 'feedback-header'],
  ['x-mailchimp-id', 'campaign-header'],
];

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

/** Gmail's own classification, which is free and better than ours at promotions. */
const BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']);
const SPAM_LABELS = new Set(['SPAM']);

/**
 * Transactional evidence: machine-generated, *and* about something that
 * happened to this user. The subject patterns are deliberately narrow — a
 * newsletter with the word "update" in it must not read as a receipt.
 */
const TRANSACTIONAL_SUBJECT =
  /\b(receipt|invoice|order\s*(?:#|no\.?|\d)|order\s+(?:confirm\w*|shipp\w*|deliver\w*)|payment\s+(?:receiv\w*|confirm\w*|fail\w*)|statement|booking\s+confirm\w*|itinerary|refund)\b/i;

const AUTO_SUBMITTED = /^auto-/i;

/** Senders that are machine mailboxes. Not junk on their own — see the header. */
const MACHINE_SENDER = /(^|[.\-_+])(no-?reply|do-?not-?reply|notifications?|mailer-daemon)([.\-_+]|@)/i;

function readHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  const lowered = new Map<string, string>();
  if (headers === undefined) return lowered;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // An empty value is not a signal. A provider that returns every header it
    // knows about with an empty value would otherwise quarantine the mailbox.
    if (trimmed.length === 0) continue;
    lowered.set(name.trim().toLowerCase(), trimmed);
  }
  return lowered;
}

/**
 * Classify one item.
 *
 * Pure, synchronous, and cheap enough to run on every item of a 40,000-message
 * backfill — which it has to be, since running it anywhere but in front of the
 * estimate would price a mailbox the fleet is not going to embed.
 */
export function classifyJunk(input: JunkInput): JunkVerdict {
  const headers = readHeaders(input.headers);
  const labels = new Set(input.labels ?? []);
  const bulk: string[] = [];
  const transactional: string[] = [];

  for (const [header, signal] of BULK_HEADERS) {
    if (headers.has(header)) bulk.push(signal);
  }

  const precedence = headers.get('precedence')?.toLowerCase();
  if (precedence !== undefined && BULK_PRECEDENCE.has(precedence)) bulk.push('precedence-bulk');

  for (const label of labels) {
    if (SPAM_LABELS.has(label)) bulk.push('spam-label');
    else if (BULK_LABELS.has(label)) bulk.push('promotions-label');
  }

  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted !== undefined && AUTO_SUBMITTED.test(autoSubmitted)) {
    transactional.push('auto-submitted');
  }
  if (input.subject != null && TRANSACTIONAL_SUBJECT.test(input.subject)) {
    transactional.push('transactional-subject');
  }
  if (input.from != null && MACHINE_SENDER.test(input.from)) transactional.push('machine-sender');

  // A machine sender ALONE is not enough to warn: plenty of ordinary mail is
  // relayed from a no-reply address. It counts only alongside a header or a
  // subject that says what the message is for.
  const transactionalEnough =
    transactional.length > 1 ||
    transactional.some((signal) => signal !== 'machine-sender');

  if (bulk.length > 0 && !transactionalEnough) {
    return { visibility: 'hidden', marker: JUNK_MARKER_BULK, signals: [...new Set(bulk)] };
  }

  if (transactionalEnough) {
    // Bulk **and** transactional lands here on purpose: order confirmations
    // from large senders carry list headers too, and hiding one loses the only
    // record of a purchase the user has.
    return {
      visibility: 'warned',
      marker: JUNK_MARKER_TRANSACTIONAL,
      signals: [...new Set([...transactional, ...bulk])],
    };
  }

  return CLEAN;
}

/**
 * What U4's `quarantine` seam is handed.
 *
 * Non-null hides the page and stops it ever being embedded; null lets it
 * through as ordinary content. This function is the entire difference between
 * the two markers, which is why it is one place and not an inline ternary at
 * the call site.
 */
export function quarantineMarkerFor(verdict: JunkVerdict): string | null {
  return verdict.visibility === 'hidden' ? verdict.marker : null;
}

/** One item, gated: the verdict, what U4 is handed, and what the meter prices. */
export interface JunkGated<T> {
  readonly item: T;
  readonly verdict: JunkVerdict;
  /** Non-null hides the page and stops it ever being embedded. */
  readonly quarantine: string | null;
  /** What the estimate prices this item at. **Zero for a hidden one.** */
  readonly characters: number;
}

/**
 * **The seam both runners reach.**
 *
 * The verdict used to be reached inside the pull runner, which left the import
 * runner — the path the MBOX fallback and every folder scan take — with no bulk
 * filtering at all: a consumer mailbox arriving that way would be chunked,
 * embedded and priced in full, which is the cost this module exists to avoid.
 * Living here means neither runner can drift from the other about what junk is,
 * and a new importer gets the gate by filling in `junk` rather than by
 * remembering to call two functions in the right order.
 *
 * The zeroing is half the point and it is why this returns `characters` rather
 * than leaving the caller to multiply: hidden items must be priced at nothing
 * *before* the estimate, or a newsletter backlog inflates an approval the fleet
 * is never going to spend.
 */
export function gateJunk<T extends { readonly body: string; readonly junk?: JunkInput }>(
  items: readonly T[],
): ReadonlyArray<JunkGated<T>> {
  return items.map((item) => {
    const verdict = classifyJunk(item.junk ?? {});
    return {
      item,
      verdict,
      quarantine: quarantineMarkerFor(verdict),
      characters: verdict.visibility === 'hidden' ? 0 : item.body.length,
    };
  });
}
