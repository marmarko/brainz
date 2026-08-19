/**
 * The pages, rendered from typed data.
 *
 * **No bundler, no framework, and that is a constraint rather than a taste.**
 * Adding a web app without touching `package.json` means nothing to compile a
 * component with, so these are functions from a typed union to a string. The
 * consequence is honest and worth stating: this is a server-rendered site with a
 * small amount of inline script, not the SPA the roadmap's wording implies. The
 * API in `src/web/app.ts` is the deliverable; these pages are the thinnest thing
 * that makes it usable.
 *
 * **Everything is escaped.** A page that interpolated a tier name or a tenant id
 * unescaped would be an injection point fed by a database, and the database is
 * fed by a signup form.
 */

/**
 * Imported rather than restated: the connector panel's vocabulary is decided
 * where the control plane is read, and a second copy of the state union here is
 * a second place for it to drift.
 */
import type { ConnectorStatus } from './connector-panel.ts';

/**
 * Where a signed-in account with no brain is offered one.
 *
 * **A constant because two fleets name this page.** The MCP fleet renders the
 * no-brain answer on `/authorize` and has to tell the user where to go; the web
 * fleet serves the page they are being sent to. They are separate processes, so
 * the only things that can hold the sentence and the destination together are a
 * shared literal and a test that follows the link across the boundary
 * (`test/web/app.test.ts`). Before this existed the MCP page said *"open your
 * dashboard — it can build one"* and the dashboard could not.
 *
 * `src/web/app.ts` dispatches on the literal rather than on this constant, and
 * deliberately: `test/mcp/router.test.ts` derives the app's route table by
 * reading `path === '…'` out of that file, and a route spelled as an identifier
 * would be invisible to the edge's routing guard.
 */
export const BRAIN_SETUP_PATH = '/brain';

/**
 * Where the connector controls post.
 *
 * A constant because three pages name it — the dashboard's control, the
 * disconnect confirmation's control, and the test that follows every form
 * action on every page to a route that exists.
 */
export const CONNECTORS_PATH = '/api/connectors';

export type Page =
  | {
      readonly kind: 'login';
      /**
       * Where to go after signing in, when something sent the user here
       * mid-flow. Already validated by `app.ts:returnPathAfterLogin` — this
       * page escapes it and does not re-decide it.
       */
      readonly next?: string;
    }
  | {
      readonly kind: 'signup';
      readonly languages: readonly { readonly value: string; readonly label: string }[];
    }
  | { readonly kind: 'reset_request' }
  | { readonly kind: 'reset_sent' }
  | { readonly kind: 'reset_complete'; readonly token: string }
  | {
      readonly kind: 'dashboard';
      readonly tier: string;
      readonly status: string;
      readonly tenantId: string | null;
      readonly connectorsAvailable: boolean;
      /**
       * One entry per offered source, each carrying what this brain can
       * actually say about it. Empty when {@link connectorsAvailable} is false —
       * the gate's explanation is rendered instead, and **no control is
       * rendered at all**, because a button whose route answers 402 is the dead
       * affordance this page exists to stop having.
       */
      readonly connectors: readonly ConnectorStatus[];
      readonly providers: readonly string[];
    }
  | {
      readonly kind: 'connect';
      readonly installLink: string;
      readonly command: string;
      readonly steps: readonly string[];
      readonly connected: boolean;
    }
  | {
      /**
       * The page a signed-in account with no brain is sent to — see
       * {@link BRAIN_SETUP_PATH}.
       */
      readonly kind: 'brain_setup';
      readonly languages: readonly { readonly value: string; readonly label: string }[];
      /**
       * What went wrong on the press that led back here. Absent on the first
       * render.
       *
       * A sentence rather than a code: the router's `{ok:false,code:…}` body is
       * what a `fetch` gets, and rendering it to a browser is how an error
       * becomes a stack trace with nothing in it a user can do.
       */
      readonly problem?: string;
    }
  | {
      /**
       * The answer to a form connect: the vendor's link, as a link.
       *
       * **Not a redirect, and the reason is the app's own policy.** See
       * `app.ts:handleConnect` — `form-action` is enforced by the document that
       * carries the form, which is the dashboard, which renders before any
       * claim URL exists. This page is served in place of the redirect that
       * would be blocked.
       */
      readonly kind: 'connector_claim';
      readonly source: string;
      readonly claimUrl: string;
      readonly expiresAt: Date;
    }
  | {
      /** What a disconnect asks before it revokes anything. */
      readonly kind: 'connector_confirm_disconnect';
      readonly source: string;
    }
  | {
      /** What a disconnect did, in the vendor's own vocabulary. */
      readonly kind: 'connector_disconnected';
      readonly source: string;
      readonly pollingStopped: number;
      readonly vendorDeleted: boolean;
      readonly tokensRevoked: string;
    }
  | {
      /**
       * A connector refusal a browser can read.
       *
       * The `refusedBuild` shape one section over, for the same reason: a form
       * post answered with `{"ok":false,…}` renders that object as text in a
       * browser window, on a page with no way back.
       */
      readonly kind: 'connector_notice';
      readonly heading: string;
      readonly message: string;
    }
  | {
      /**
       * The 72-hour window, as somewhere a person can actually go.
       *
       * **Why this page exists when severance has none.** `/api/severance` is
       * API-only and no page posts to it; it is reachable today only by a
       * hand-rolled request. That is survivable for a destructive control the
       * user is talked through out of band. It is not survivable here, because
       * the `forget` notice has to NAME a destination — a JSON endpoint alone
       * would move the gap rather than close it, which is the whole defect this
       * change is about.
       *
       * **Every field is shape, and that is structural rather than careful.**
       * The port that fills this reads two ledgers and no content table, so
       * there is no title, statement, excerpt, filename, alias or external
       * reference available to render even by mistake. Origins are safe and
       * deliberately shown: they are the credential labels the user chose,
       * already on the connectors panel, and already the string
       * `/api/severance` demands as its own echo.
       */
      readonly kind: 'retractions';
      /** False renders the explanation instead of a control that cannot work. */
      readonly available: boolean;
      readonly retractions: readonly {
        readonly deletedAt: string;
        readonly restorableUntil: string;
        readonly kind: 'record' | 'origin';
        readonly origins: readonly string[];
        readonly targetKind: string | null;
        readonly counts: Readonly<Record<string, number>>;
      }[];
      readonly overflowed: boolean;
      readonly ttlHours: number;
    }
  | {
      /**
       * What a browser gets back from the Restore button.
       *
       * **A page rather than the JSON body, for the reason `connector_notice`
       * states one union member up:** a form post answered with `{"ok":true,…}`
       * renders that object as text in a browser window with no way back, and
       * the whole argument for `/retractions` existing was that a JSON endpoint
       * alone moves the gap rather than closing it. A button that ends in JSON
       * is that gap with one extra click.
       *
       * **And not a bare redirect either.** The sentence a severance restore
       * carries — the account is still disconnected — is load-bearing, and this
       * app has no flash mechanism to carry a message through a 303. So the
       * outcome is rendered where it happened, with the way back on it.
       */
      readonly kind: 'retraction_notice';
      readonly heading: string;
      readonly message: string;
    };

/** HTML-escape. Five characters, applied to every interpolation without exception. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; }
  input, button, select { font: inherit; padding: 0.5rem; }
  input, select { width: 100%; box-sizing: border-box; }
  button { margin-top: 1rem; cursor: pointer; }
  code { padding: 0.15rem 0.35rem; background: rgba(127,127,127,0.15); border-radius: 3px; }
  .note { opacity: 0.75; font-size: 0.9rem; }
  .problem { border-left: 3px solid currentColor; padding-left: 0.75rem; }
  ol { padding-left: 1.25rem; }
  .connected { font-weight: 600; }
  .sources { list-style: none; padding-left: 0; }
  .sources > li { border-top: 1px solid rgba(127,127,127,0.3); padding: 0.75rem 0; }
  .sources form { display: flex; gap: 0.5rem; }
  .sources button { width: auto; }
  .source-name { font-weight: 600; text-transform: capitalize; }
  .failing { border-left: 3px solid currentColor; padding-left: 0.75rem; }
`;

function shell(title: string, main: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${main}</main></body></html>`;
}

/**
 * KTD9's choice, rendered once for both pages that ask it.
 *
 * **Two pages ask, so one function answers.** Signup asks it and the recovery
 * page asks it again — the choice lives only in `account.brain` and a signup
 * whose provisioning failed wrote no row, so there is nothing to remember. A
 * second copy of the markup is a second place for the list, the wording and the
 * empty-first-option rule to drift.
 *
 * **The empty first option is the part that matters.** A `select` whose first
 * option is a real language *is* a default: the browser selects it with no
 * `selected` attribute anywhere and `required` never fires, because something is
 * always chosen. That is KTD9's silent anglicisation arriving through markup
 * rather than through code — every user who submits without reading gets
 * English, and the failure is invisible afterwards because search still works,
 * just worse. An empty, disabled, selected placeholder makes `required` mean
 * what it says.
 */
function languageChoice(
  languages: readonly { readonly value: string; readonly label: string }[],
): string {
  const options = languages
    .map(
      (language) =>
        `<option value="${escapeHtml(language.value)}">${escapeHtml(language.label)}</option>`,
    )
    .join('');
  return `  <label for="fts_language">What language is most of your mail and your notes in?</label>
  <select id="fts_language" name="fts_language" required><option value="" disabled selected>Choose a language</option>${options}</select>
  <p class="note">This decides how your brain indexes words, and it is set once when the brain is built.
  We do not guess it, because guessing wrong is invisible — everything would still work, and search
  would quietly be worse forever.</p>`;
}

/**
 * A moment, in the one format that cannot be misread.
 *
 * ISO rather than "3 hours ago": the server renders once and the page is then
 * read at an unknown later time, so a relative phrase is a number that starts
 * lying the moment it is sent.
 */
function moment(at: Date): string {
  return `<time datetime="${escapeHtml(at.toISOString())}">${escapeHtml(at.toISOString())}</time>`;
}

/**
 * What a failure code means to the person whose mail is not arriving, and what
 * — if anything — they can do about it.
 *
 * **A sentence per code, and the codes are two closed vocabularies rather than
 * this file's invention:** `ingest_log.failure_code`'s
 * (`src/ingest/log.ts:INGEST_FAILURE_CODES`) where a run got far enough to
 * record one, and `control.job.failure_code`'s (`src/worker/jobs.ts`) where it
 * did not. Both reach this page through `control.connector_health`.
 *
 * **Why the second half of each sentence matters more than the first.** The
 * panel used to render the queue's own code — `handler_error` — verbatim, and
 * tell every user the same thing: disconnect and connect again. That is the
 * right instruction for exactly one of these causes and wrong for the rest: it
 * does nothing for a rate limit, nothing for an unreachable database, and for an
 * exhausted spend cap it costs the user a re-authorization and then fails again
 * in the same place. So the branch is on the cause, and the honest answer for
 * most of them is *nothing, it retries on its own*.
 *
 * An unrecognised code renders as itself rather than as a guess: a connector
 * polled by a fleet older than this record has no cause at all, and inventing
 * one would be worse than the gap.
 */
export function causeSentence(cause: string | null): string | null {
  switch (cause) {
    case null:
      return null;
    case 'auth_expired':
      return (
        'The provider stopped accepting our access — usually because the permission was ' +
        'withdrawn or expired. <strong>Disconnecting and connecting again is the fix</strong>, ' +
        'and it is the only one of these you can do anything about.'
      );
    case 'fleet_auth_failed':
      // **The sentence this whole split exists to make possible.** The code it
      // used to share said "the permission was withdrawn — reconnect", which
      // for this cause is false in the fact and expensive in the instruction:
      // the credential that failed is brainz's own, one pair for the entire
      // fleet, and a re-authorization costs the user a trip to Google to fix
      // something that was never theirs. So it says what is true and asks for
      // nothing. What it does *not* say is the part an operator needs; that
      // travels as the code, on `/admin connector_status`.
      return (
        'Our own connection to the service that carries your accounts stopped working. That is ' +
        'ours, not yours — your accounts are untouched — and the checks keep trying while we fix it.'
      );
    case 'rate_limited':
      return 'The provider asked us to slow down. Nothing to do — it backs off and tries again.';
    case 'budget_exhausted':
      return (
        'This brain’s spending cap stopped the import before it finished. Nothing was lost: ' +
        'the check resumes from where it stopped once there is room under the cap.'
      );
    case 'provider_error':
      return 'The provider refused the request. Nothing to do — it tries again on its own.';
    case 'embed_key_unavailable':
      // Same sentence as the general case on purpose. The split exists for the
      // operator, who gets the code; the difference between a credential we
      // cannot resolve and a provider that refused is not a difference the
      // person waiting for their mail can act on, and naming it here would
      // spend their attention on our configuration.
      return (
        'The service that makes your text searchable could not be reached, so this check ' +
        'stopped rather than file anything it could not index. Nothing was lost — it resumes ' +
        'from where it stopped once indexing is back.'
      );
    case 'embed_transport_failed':
      return (
        'The service that makes your text searchable refused the request, so this check ' +
        'stopped rather than file anything it could not index. Nothing was lost — it resumes ' +
        'from where it stopped once indexing is back.'
      );
    case 'embed_unavailable':
      // Deliberately says "indexing", not "importing". What failed is the step
      // that makes text searchable, and the mail itself is not lost — the cursor
      // holds, so the same items are re-offered the moment the indexer answers.
      // Asks for nothing, for `fleet_auth_failed`'s reason: the service that
      // could not be reached is ours.
      return (
        'The service that makes your text searchable could not be reached, so this check ' +
        'stopped rather than file anything it could not index. Nothing was lost — it resumes ' +
        'from where it stopped once indexing is back.'
      );
    case 'parse_failed':
      return 'Something came back in a shape we could not read. That one is ours to fix.';
    case 'cancelled':
      return 'The check stopped before it finished. It picks up where it left off.';
    case 'tenant_unavailable':
      return (
        'Your brain’s database could not be reached when the check ran. That is ours, not ' +
        'yours, and the check retries on its own.'
      );
    case 'attempt_timed_out':
      return 'The check ran out of time. It retries, and picks up where it left off.';
    case 'lease_stolen':
      return 'The check was interrupted and handed to another worker. It retries.';
    case 'handler_error':
      return 'Something went wrong on our side. It retries, and it is ours to fix.';
    default:
      return `The last check reported <code>${escapeHtml(cause)}</code>.`;
  }
}

/**
 * The instruction the `blocked` copy appends, when there is one worth giving.
 *
 * A named function rather than the comparison it replaces, because the decision
 * has two reasons behind it and an inline `cause === 'auth_expired'` could only
 * ever record one:
 *
 *   * **`auth_expired` — already said.** {@link causeSentence} gives this exact
 *     instruction, and a page that gives it twice reads as one that does not
 *     know what it is telling you.
 *   * **`fleet_auth_failed` — wrong to say at all.** The credential that failed
 *     is the fleet's own. Reconnecting cannot repair it, and asking for one
 *     spends a user's trip to their provider on a problem they do not have.
 *     This cause is retryable, so it should never reach `blocked` — but copy
 *     has to be right where it lands, not where it is expected to.
 *
 * Everything else keeps the instruction: a lane that stopped **below** its
 * budget was stopped deliberately, and for a cause nothing here recognises,
 * reconnecting is the best remedy this page can name.
 */
export function blockedReconnectSuffix(cause: string | null): string {
  if (cause === 'auth_expired' || cause === 'fleet_auth_failed') return '';
  return ' Disconnect this source and connect it again to start the checks.';
}

/** What the last attempt lost, when it lost anything. Silent otherwise. */
function lossSentence(status: ConnectorStatus): string {
  if (status.itemsFailed <= 0) return '';
  return (
    ` The last check could not import ${status.itemsFailed} ` +
    `item${status.itemsFailed === 1 ? '' : 's'}.`
  );
}

/**
 * **Whether anything is arriving, which is the question the rest of this panel
 * could not ask.**
 *
 * Every other sentence here is built from the queue: a job is open, one died, a
 * lane is on attempt three. During the ten hours this fleet imported nothing,
 * every one of those read as it does on a healthy brain — a pull that halts
 * returns `stopped`, a stopped run is deliberately not thrown on, so its job
 * *completed* — and the panel printed *"Connected. Last checked 12:04."* over a
 * connector that had imported nothing since breakfast. The clock that had
 * stopped was `last_success_at`, and nothing on this page read it.
 *
 * **An instant, never a duration.** The rule that makes {@link moment} ISO
 * applies twice over here: the server renders once and the page is read at an
 * unknown later time, so *"nothing for ten hours"* is a number that starts
 * lying the moment it is sent — and it is the number a worried person would
 * quote back. The comparison against the threshold is safe to do server-side
 * because it compares two instants; the rendered string says *since when*.
 *
 * Silent on the readings that are not a claim: a working connector, a single
 * refused poll, a source still inside its first window, a source nobody has
 * connected. A staleness banner on a healthy brain is how the banner stops being
 * read, and this page only gets one chance at being believed.
 */
function stalenessSentence(status: ConnectorStatus): string {
  switch (status.freshness) {
    case 'stale':
      return status.lastSuccessAt === null
        ? ''
        : ` <strong>Nothing has been imported since ${moment(status.lastSuccessAt)}</strong>, which is` +
            ` longer than a check should ever take.`;
    case 'never_succeeded':
      // Deliberately not a duration and not a clock: there is no success to
      // count from, which is the whole of what this state says. "It has failed
      // since March" and "it has never worked once" are different emergencies.
      //
      // And deliberately no instruction. Which remedy is right depends entirely
      // on the cause — reconnecting fixes a withdrawn permission and wastes a
      // trip to the provider on an exhausted spend cap or on a credential of
      // ours — and {@link causeSentence} is printed beside this and already
      // says the right one. A second instruction here would be the panel giving
      // the same advice to everybody again, which is the defect that copy was
      // written to end.
      return ` <strong>No check has ever finished importing anything from this source.</strong>`;
    case 'unattended':
      // The last attempt COMPLETED — nothing is failing, nothing is even being
      // tried. There is no action for the user in it, so none is asked of them.
      return status.lastSuccessAt === null
        ? ''
        : ` <strong>Nothing has checked this source since ${moment(status.lastSuccessAt)}.</strong>` +
            ` That is ours, not yours.`;
    case 'current':
    case 'slipping':
    case 'starting':
    case 'unpolled':
    case 'not_connected':
      return '';
  }
}

/** Whether the freshness reading is one the page should paint as a problem. */
function readsAsBroken(status: ConnectorStatus): boolean {
  return (
    status.freshness === 'stale' ||
    status.freshness === 'never_succeeded' ||
    status.freshness === 'unattended'
  );
}

/**
 * How far along the ladder this lane is, when the queue can say.
 *
 * Silent when either number is missing — a lane polled by a fleet older than the
 * per-kind policy has no budget recorded, and "0 of 0 attempts" is worse than
 * nothing.
 */
function ladderSentence(status: ConnectorStatus): string {
  if (status.attempts <= 0 || status.maxAttempts <= 0) return '';
  return (
    ` That is ${status.attempts} failed attempt${status.attempts === 1 ? '' : 's'} out of ` +
    `${status.maxAttempts} before it stops trying.`
  );
}

/**
 * What one source's status says, in a sentence rather than a struct.
 *
 * The states come from `connector-panel.ts`, whose header carries the reason
 * each is the most this app can honestly claim. The copy's job is to not
 * over-claim them: `unknown` is *as far as this brain can tell*, because
 * attached-but-never-polled and never-attached are the same rows.
 *
 * **Three of these sentences answer the same question and must not blur into
 * each other.** A user whose connector is not working needs to know which world
 * they are in — it retries on its own and roughly when (`retrying`), it needs
 * them to reconnect (`blocked`), or it gave up and there is a button
 * (`failing`) — because the three have different answers and only one of them
 * costs the user anything. The previous copy had one sentence for the last two
 * and ended it with *"disconnecting and connecting again restarts the polling"*,
 * which was the right instruction for a revoked grant, a wasted
 * re-authorization for an outage, and — while a dead lane could not be cleared
 * at all — untrue for both.
 */
function connectorStatusSentence(status: ConnectorStatus): string {
  const cause = causeSentence(status.cause);
  switch (status.state) {
    case 'failing':
      // It spent its whole ladder. Nothing is required of the user, so nothing
      // is asked of them beyond the one press that costs them nothing.
      return (
        `<p class="failing">Connected, and <strong>no longer being polled</strong>. The check kept ` +
        `failing and gave up${status.lastCheckedAt === null ? '' : `, most recently at ${moment(status.lastCheckedAt)}`}.` +
        `${ladderSentence(status)}` +
        // The cause first, because it decides whether the instruction after it
        // is the right one at all.
        `${cause === null ? ' Nothing recorded why.' : ` ${cause}`}` +
        `${lossSentence(status)}` +
        ` <strong>Use the button below to try it again.</strong> That starts the checks from ` +
        `scratch and does not cost you a reconnection.` +
        `</p>`
      );
    case 'blocked':
      // It stopped early and deliberately: the provider refused us in a way no
      // amount of asking again resolves. Deliberately NOT offered the retry
      // button — pressing it would fail in the same place, in seconds.
      return (
        `<p class="failing">Connected at your provider, but <strong>we can no longer read it</strong>. ` +
        `The checks have stopped${status.lastCheckedAt === null ? '' : ` — the last one was at ${moment(status.lastCheckedAt)}`}, ` +
        `rather than retrying for days against an answer that will not change.` +
        `${cause === null ? '' : ` ${cause}`}` +
        `${lossSentence(status)}` +
        // Only when there is an instruction worth giving. See
        // `blockedReconnectSuffix` for the two causes that get none, and why
        // they get none for different reasons.
        `${blockedReconnectSuffix(status.cause)}` +
        `</p>`
      );
    case 'retrying':
      // Deliberately NOT the `checking` sentence. A lane on its third attempt is
      // queued and running exactly like a healthy one, and telling a user whose
      // grant was revoked that a check is running now is how they find out four
      // failures later, from an error they cannot act on.
      //
      // **"around", never "at".** The fleet is woken by a cron every thirty
      // minutes, so the queue's `run_at` is the earliest a retry can happen and
      // not the moment it will. A time stated to the second would be wrong most
      // of the time in the one direction a user notices.
      return (
        `<p class="failing">Connected, and the last check <strong>did not work</strong>. It is ` +
        `trying again on its own${status.nextAttemptAt === null ? '' : ` — the next attempt is due around ${moment(status.nextAttemptAt)}`}.` +
        `${ladderSentence(status)}` +
        `${cause === null ? '' : ` ${cause}`}` +
        `${lossSentence(status)}` +
        // A retrying lane says how this attempt is going. It does not say how
        // long it has been since one worked, and a user reading "it is trying
        // again on its own" has no way to tell a lane four minutes into a
        // backoff from one that has been saying it since yesterday.
        `${stalenessSentence(status)}` +
        `${status.lastCheckedAt === null ? '' : ` The last check that finished was ${moment(status.lastCheckedAt)}.`}` +
        `</p>`
      );
    case 'checking':
      return (
        `<p${readsAsBroken(status) ? ' class="failing"' : ''}>Connected. A check is queued or running now` +
        `${status.lastCheckedAt === null ? ', and none has finished yet' : `; last checked ${moment(status.lastCheckedAt)}`}.` +
        // A queued check says nothing about whether the last several worked. A
        // lane can be checking every half hour and importing nothing all week.
        `${stalenessSentence(status)}</p>`
      );
    case 'connected':
      return (
        `<p${readsAsBroken(status) ? ' class="failing"' : ''}>Connected. Last checked ${status.lastCheckedAt === null ? 'at an unrecorded time' : moment(status.lastCheckedAt)}.` +
        // **The clause that used to be gated on `itemsFailed > 0`, and the gate
        // is what hid the ten hours.** A halted run's failed-item count is zero
        // by construction — the halt breaks out of the loop before anything is
        // counted as lost — so the cause was suppressed on exactly the runs it
        // existed to explain.
        //
        // No counter is consulted now, and none is needed: `connector_health`'s
        // own CHECK constraint says a completed run may name no cause, so a
        // cause that is present at all IS the evidence that the last run did not
        // complete. A `stopped` or `refused` run completes its *job* — the
        // cursor is held and the next tick resumes it — so this stays the one
        // place a user is told that a check came back short rather than empty.
        `${stalenessSentence(status)}${cause === null ? '' : ` ${cause}`}${lossSentence(status)}</p>`
      );
    // The half hour between authorizing and the first poll, said out loud. A
    // user who is told only "connected" and then sees nothing arrive concludes
    // it is broken; a user given the number waits.
    case 'attached':
      return (
        `<p><strong>Connected.</strong> The first check has not run yet — it starts within about ` +
        `half an hour, and the first one takes longer than the rest because it has a backlog to read.</p>`
      );
    // Deliberately not "connecting…": nothing here is in progress. The user
    // either has not finished at the provider or did not finish at all, and only
    // they can tell which — so the copy says what is true and what to do.
    case 'pending':
      return (
        `<p>You started connecting this. Nothing has been attached yet — if you closed the provider's ` +
        `page before finishing, connect again; if you did finish, this appears on its own within about ` +
        `half an hour.</p>`
      );
    case 'absent':
      return `<p>Not connected.</p>`;
  }
}

/**
 * One source: what it is, what is known about it, and the things that can be
 * done to it.
 *
 * **One form, named submits, no script.** The app's policy has no `script-src`,
 * so the control cannot be a `fetch` and cannot be a button that "does"
 * anything: it is a form, and which button was pressed arrives as `intent`
 * because a browser sends the name and value of the submit that fired and of no
 * other. A form submitted by the Enter key sends neither, which is why `app.ts`
 * reads an absent intent as `connect` — the non-destructive half.
 *
 * **The retry control is a submit on that same form, and it could not be a
 * link.** A `GET /api/connectors?intent=retry` would be fired by every
 * link-prefetching browser, every crawler that follows an `href`, and every
 * chat client that unfurls a pasted dashboard URL — each of them silently
 * re-opening a lane the fleet had deliberately closed. It writes, so it is a
 * POST.
 *
 * **It is offered only on `failing`.** A `blocked` lane died because the
 * provider refuses us; a retry there would fail again within seconds of being
 * pressed, and a button that visibly does nothing is worse than no button. That
 * copy asks for a reconnection instead, which is the thing that actually works.
 */
function connectorRow(status: ConnectorStatus): string {
  const source = escapeHtml(status.source);
  const retry =
    status.state === 'failing'
      ? `\n    <button type="submit" name="intent" value="retry">Try ${source} again</button>`
      : '';
  return `<li>
  <p class="source-name">${source}</p>
  ${connectorStatusSentence(status)}
  <form method="post" action="${CONNECTORS_PATH}">
    <input type="hidden" name="source" value="${source}">${retry}
    <button type="submit" name="intent" value="connect">Connect ${source}</button>
    <button type="submit" name="intent" value="disconnect">Disconnect ${source}</button>
  </form>
</li>`;
}

export function renderPage(page: Page): string {
  switch (page.kind) {
    case 'login':
      return shell(
        'Sign in — brainz',
        `<h1>brainz</h1>
<p class="note">Your brain, wherever your assistant is.</p>
${
  page.next === undefined
    ? ''
    : '<p class="note">Sign in to finish connecting your assistant. You will be brought back to the ' +
      'consent step, not to your dashboard.</p>'
}
<form method="post" action="/api/login">
${
  page.next === undefined
    ? ''
    : `  <input type="hidden" name="next" value="${escapeHtml(page.next)}">\n`
}  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="note"><a href="/password/reset">Forgotten your password?</a> &middot; <a href="/signup">Create an account</a></p>`,
      );

    case 'signup': {
      // KTD9's choice, made by the person it is about. The API refuses a signup
      // without it rather than defaulting to English, so a page with no field
      // for it would make the product unusable through its own front door.
      return shell(
        'Create an account — brainz',
        `<h1>Create your brain</h1>
<form method="post" action="/api/signup">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
  <p class="note">Twelve characters or more. A phrase is easier to remember and harder to guess than a
  short password with punctuation in it.</p>
${languageChoice(page.languages)}
  <button type="submit">Create account</button>
</form>
<p class="note">Building your brain takes about fifteen seconds, and this page will sit still until it
is done.</p>
<p class="note"><a href="/login">Already have an account?</a></p>`,
      );
    }

    case 'reset_request':
      return shell(
        'Reset your password — brainz',
        `<h1>Reset your password</h1>
<form method="post" action="/api/password/reset">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <button type="submit">Send a reset link</button>
</form>
<p class="note">We answer the same way whether or not that address has an account here. That is
deliberate: an endpoint that said "no such account" would tell anyone who asked which addresses are
registered.</p>`,
      );

    case 'reset_sent':
      return shell(
        'Check your mail — brainz',
        `<h1>Check your mail</h1>
<p>If that address has an account, a reset link is on its way. It works once and expires in thirty
minutes.</p>
<p class="note">Resetting your password signs out every session on every device — including this one.</p>
<p><a href="/login">Back to sign in</a></p>`,
      );

    case 'reset_complete':
      return shell(
        'Choose a new password — brainz',
        `<h1>Choose a new password</h1>
<form method="post" action="/api/password/complete">
  <input type="hidden" name="token" value="${escapeHtml(page.token)}">
  <label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
  <button type="submit">Set password</button>
</form>
<p class="note">This signs out every other session, and it does not confirm your email address —
that is a separate step, on purpose.</p>`,
      );

    case 'dashboard': {
      const providers = page.providers
        .map((provider) => `<option value="${escapeHtml(provider)}">${escapeHtml(provider)}</option>`)
        .join('');
      // The gate's copy names the actual reason. "Upgrade for more" tells a user
      // nothing they can act on; a monthly per-connection vendor fee is a fact
      // they can weigh.
      //
      // **And the gated render carries no control at all.** Not a disabled one,
      // not a differently-worded one: a form whose route answers 402 or 501 is
      // the dead affordance the whole panel exists to stop being.
      const connectors = page.connectorsAvailable
        ? `<ul class="sources">${page.connectors.map(connectorRow).join('')}</ul>
<p class="note">Connecting opens a consent screen at the connector vendor. The link it gives you is a
capability — anyone who has it can attach their account to this brain — so it expires in ten minutes
and works once. It is shown on one page, once, and is not stored anywhere you can go back to.</p>
<p class="note">You do not have to come back here after authorizing. The consent happens at the connector
vendor and the vendor does not report it, so this brain goes and asks — loading this page asks about
any connect you have started, and it asks again on its own within about half an hour. Authorize and
return here and the source reads as connected straight away; authorize and close the tab and it
appears by itself.</p>`
        : `<p>Connected accounts are on the paid plan. Each connected mailbox carries a monthly fee from the
connector vendor whether or not the brain is used, which the free plan cannot carry.</p>
<p class="note">Chat exports and folder imports are included on every plan and need no connection at all.</p>`;

      return shell(
        'brainz',
        `<h1>brainz</h1>
<p>Plan: <strong>${escapeHtml(page.tier)}</strong> (${escapeHtml(page.status)})${
          page.tenantId === null ? '' : ` &middot; brain <code>${escapeHtml(page.tenantId)}</code>`
        }</p>
<p><a href="/connect">Connect brainz to Claude &rarr;</a></p>
<h2>Connected accounts</h2>
${connectors}
<h2>Your own model key</h2>
<p class="note">Inference runs on our keys by default. Bring your own and your calls are still metered for
your own spend cap, but billed to you rather than to us.</p>
<form method="post" action="/api/byok">
  <label for="provider">Provider</label><select id="provider" name="provider">${providers}</select>
  <label for="key">API key</label><input id="key" name="key" type="password" autocomplete="off">
  <button type="submit">Save key</button>
</form>
<h2>Spend</h2>
<p class="note">Loaded from <code>/api/spend</code>.</p>
<h2>Export</h2>
<p class="note">Scheduled self-export lands with the lifecycle unit; the button is not wired to a store yet
and says so rather than pretending to save.</p>`,
      );
    }

    case 'brain_setup': {
      // The refusal, above the form rather than below it, and in a sentence
      // rather than a code. This page is reached by somebody whose signup
      // already failed once; the second failure has to read as a thing that
      // happened to them and not as a body they were handed.
      const problem =
        page.problem === undefined
          ? ''
          : `<p class="problem"><strong>${escapeHtml(page.problem)}</strong></p>\n`;
      return shell(
        'Build your brain — brainz',
        `<h1>Build your brain</h1>
<p>You are signed in, and this account has no brain yet. That happens when provisioning failed while
you were signing up — the account was created, the brain was not. This page is how you get one.</p>
${problem}<form method="post" action="/api/brain">
${languageChoice(page.languages)}
  <button type="submit">Build my brain</button>
</form>
<p class="note">Building takes about fifteen seconds. Nothing moves on this page while it happens —
that is the wait, not a hang. <strong>Press the button once.</strong> A second press while the first
is still working is refused rather than obeyed, because two brains for one account is a bill you did
not agree to and a database nobody would ever look in.</p>
<p class="note">Nothing you have already sent us is lost by waiting: your account, your password and
your plan are all in place already. The brain is the only piece missing.</p>`,
      );
    }

    case 'connect': {
      const steps = page.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
      const status = page.connected
        ? '<p class="connected">Connected. Your assistant has reached this brain.</p>'
        : '<p class="note">Nothing has reached this brain yet. This page notices when something does.</p>';

      return shell(
        'Connect to Claude — brainz',
        `<h1>Connect brainz to Claude</h1>
${status}
<p><a href="${escapeHtml(page.installLink)}">Connect to Claude</a></p>
<p class="note">The link opens Claude with the connector already filled in. You will still confirm it —
Claude asks you to, and shows a notice that the details came from an external link. Nothing is added or
granted until you say so.</p>
<h2>What happens</h2>
<ol>${steps}</ol>
<h2>Claude Code</h2>
<p>Run this once:</p>
<p><code>${escapeHtml(page.command)}</code></p>
<p class="note">Then <code>/mcp</code> in a session to sign in.</p>`,
      );
    }

    case 'connector_claim': {
      const source = escapeHtml(page.source);
      // **A link, not a redirect, and not a control that could be re-fired.**
      // `rel="noreferrer"` on top of the response's own `referrer-policy`:
      // two independent statements of the same rule, because the one that
      // travels with the markup survives a later edit to the header helper.
      //
      // **`target="_blank"`, because the vendor's page never comes back.** Its
      // consent flow ends on "you can now close this window" and issues no
      // redirect — there is no return leg. Navigating this tab therefore
      // replaces the only page that can tell the user whether the connection
      // took with a dead end whose sole exit is the back button, at the moment
      // they most need to be told. `noopener` is written out beside `noreferrer`
      // rather than left to be implied: the opener handle is the thing a new tab
      // introduces, and it should not go away if the referrer rule is ever
      // relaxed. No script is involved — the response's CSP forbids inline
      // JavaScript, so a scripted opener would be a control that does nothing.
      return shell(
        `Connect ${page.source} — brainz`,
        `<h1>Connect ${source}</h1>
<p>Follow this link to ${source}'s consent screen at the connector vendor:</p>
<p><a href="${escapeHtml(page.claimUrl)}" target="_blank" rel="noreferrer noopener">Connect ${source} at the connector vendor &rarr;</a></p>
<p class="note">It opens in a <strong>new tab</strong>, and that tab does not come back: the vendor
finishes by telling you to close the window. Close it when it does — <strong>this page</strong>, and
the dashboard behind it, is where you come back to. Your brain notices the new connection on its own
within a few minutes; nothing here needs you to press anything again.</p>
<p class="note">That link is a capability, not an address. Anyone who has it can attach <em>their</em>
${source} account to <em>this</em> brain, so it expires at ${moment(page.expiresAt)} and works once.
Do not paste it anywhere — not into a chat, not into a note, not to yourself.</p>
<p class="note">This page is not stored: reloading it will not bring the link back, and neither will
the back button. If you need another, press Connect on the dashboard again — the one above stops
working when a new one is made.</p>
<p><a href="/dashboard">Back to your dashboard</a></p>`,
      );
    }

    case 'connector_confirm_disconnect': {
      const source = escapeHtml(page.source);
      // The confirmation is a form carrying the answer, rather than a link: a
      // link that disconnected would be a GET that changes state, which is the
      // thing a prefetcher, a link scanner or a mail client fires without a
      // person being involved.
      return shell(
        `Disconnect ${page.source} — brainz`,
        `<h1>Disconnect ${source}?</h1>
<p>This asks the connector vendor to delete the account behind ${source} and stops this brain polling
it. Anything already brought in stays in your brain — this is about the connection, not about what it
collected.</p>
<p class="note">Reconnecting afterwards means going through the vendor's consent screen again. Nothing
here deletes what was ingested; the export and erasure controls are the ones that do that.</p>
<form method="post" action="${CONNECTORS_PATH}">
  <input type="hidden" name="source" value="${source}">
  <input type="hidden" name="intent" value="disconnect">
  <input type="hidden" name="confirm" value="${source}">
  <button type="submit">Disconnect ${source}</button>
</form>
<p><a href="/dashboard">No, keep it connected</a></p>`,
      );
    }

    case 'connector_disconnected': {
      const source = escapeHtml(page.source);
      // Reported exactly as the vendor reported it. `unverified` stays
      // `unverified`: "no live credential remains anywhere" is a sentence that
      // ends up in a privacy policy, and this page is not where it gets made up.
      return shell(
        `${page.source} disconnected — brainz`,
        `<h1>${source} disconnected</h1>
<p>The connector vendor was asked to delete the account behind ${source} and answered
<code>${page.vendorDeleted ? 'deleted' : 'nothing to delete'}</code>.</p>
<p>${page.pollingStopped === 0 ? 'No check was standing for it.' : `${page.pollingStopped} standing ${page.pollingStopped === 1 ? 'check was' : 'checks were'} stopped.`}</p>
<p class="note">Token revocation at the vendor is reported as
<code>${escapeHtml(page.tokensRevoked)}</code>. We report what the vendor reports rather than
claiming more than it told us.</p>
<p><a href="/dashboard">Back to your dashboard</a></p>`,
      );
    }

    case 'connector_notice':
      return shell(
        `${page.heading} — brainz`,
        `<h1>${escapeHtml(page.heading)}</h1>
<p class="problem">${escapeHtml(page.message)}</p>
<p><a href="/dashboard">Back to your dashboard</a></p>`,
      );

    case 'retraction_notice':
      return shell(
        `${page.heading} — brainz`,
        `<h1>${escapeHtml(page.heading)}</h1>
<p>${escapeHtml(page.message)}</p>
<p><a href="/retractions">Back to what you can undo</a></p>`,
      );

    case 'retractions':
      return shell(
        'What you can undo — brainz',
        `<h1>What you can undo</h1>
${
  page.available
    ? `<p class="note">Anything you retracted in the last ${escapeHtml(String(page.ttlHours))} hours can be
put back. After that it is swept for good.</p>
${
  page.retractions.length === 0
    ? '<p class="note">Nothing here. You have retracted nothing inside the window.</p>'
    : `<ul class="sources">
${page.retractions.map(retractionEntry).join('\n')}
</ul>`
}
${
  page.overflowed
    ? '<p class="note">There are more than shown. Restore some of these and reload to see the rest.</p>'
    : ''
}`
    : '<p class="problem">This deployment cannot restore retractions. Nothing here can put anything back, ' +
      'and a button that said otherwise would be the lie this page exists to avoid.</p>'
}
<p><a href="/dashboard">Back to your dashboard</a></p>`,
      );
  }
}

/**
 * One offer, and the hidden field is the whole reason the echo is bearable.
 *
 * The confirmation is the instant, and an instant is the one value where a typo
 * produces another valid key — so the page carries it rather than asking anyone
 * to retype it. Severance asks for a retype because its echo is a *consent*
 * control; this one is an *identity* control, and demanding deliberation for it
 * would be ceremony that teaches people to paste carelessly.
 */
function retractionEntry(entry: {
  readonly deletedAt: string;
  readonly restorableUntil: string;
  readonly kind: 'record' | 'origin';
  readonly origins: readonly string[];
  readonly targetKind: string | null;
  readonly counts: Readonly<Record<string, number>>;
}): string {
  const what =
    entry.kind === 'origin'
      ? 'Disconnected an account'
      : `Retracted ${escapeHtml(RETRACTION_NOUNS[entry.targetKind ?? ''] ?? 'a record')}`;
  const counted = Object.entries(entry.counts)
    .filter(([, value]) => Number(value) > 0)
    .map(([field, value]) => `${escapeHtml(String(value))} ${escapeHtml(field)}`)
    .join(', ');
  return `  <li>
    <div class="source-name">${what}</div>
    <p class="note">${escapeHtml(entry.deletedAt)} &middot; from ${escapeHtml(entry.origins.join(', '))}
${counted.length === 0 ? '' : ` &middot; ${counted}`}</p>
    <p class="note">Restorable until ${escapeHtml(entry.restorableUntil)}.</p>
    <form method="post" action="/api/restore">
      <input type="hidden" name="deleted_at" value="${escapeHtml(entry.deletedAt)}">
      <input type="hidden" name="confirm" value="${escapeHtml(entry.deletedAt)}">
      <button type="submit">Restore</button>
    </form>
  </li>`;
}

/**
 * What each id kind is called to a person. Deliberately generic: naming the
 * record would mean reading it, and this page reads no content table.
 */
const RETRACTION_NOUNS: Readonly<Record<string, string>> = {
  doc: 'a document',
  chunk: 'a passage',
  fact: 'a fact',
  ent: 'a person or company',
};
