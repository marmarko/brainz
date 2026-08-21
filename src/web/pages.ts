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
 * Imported for the same reason: the coverage view's vocabulary is decided where
 * the counts are read, and its type is the enforcement of the privacy rule this
 * page renders — every field a number, an instant, or a schema-declared code.
 */
import { isAlarming } from '../control/cycle-staleness.ts';
import type { CoverageView, EntityKind } from './coverage.ts';
import {
  PROCESSING_PHASES,
  type ProcessingPhase,
  type ProcessingView,
} from './processing.ts';
import type { Proposal, ReviewView } from './review.ts';

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

/**
 * Where the dashboard's coverage link points.
 *
 * **A query parameter on the dashboard rather than `/coverage`, and the reason
 * is `src/mcp/edge.ts`.** That file fronts this app with an enumerated set of
 * web paths — deliberately not a prefix, so a new endpoint cannot become public
 * merely by being written — and a path absent from it is `unrouted` at the edge.
 * A `/coverage` literal would therefore 404 in every deployment while passing
 * every test in this repository that does not cross that boundary, which is the
 * port-nobody-supplies defect one layer up. The dispatch and the follow-up are
 * written down at the route in `src/web/app.ts`.
 *
 * A constant because two places name it: the dashboard that links to it and the
 * test that follows every link on every page to a route that answers.
 */
export const COVERAGE_PATH = '/dashboard?view=coverage';

/**
 * Where the dashboard's processing link points.
 *
 * A query parameter for {@link COVERAGE_PATH}'s reason, one constant up:
 * `src/mcp/edge.ts` enumerates web paths and `/processing` is not one of them,
 * so a bare literal would 404 in every deployment while passing every test here.
 */
export const PROCESSING_PATH = '/dashboard?view=processing';

/**
 * Where the dashboard's "waiting on you" line points.
 *
 * A query parameter for {@link COVERAGE_PATH}'s reason. Named as a constant
 * because three places use it: the dashboard link, the two form actions'
 * redirect target, and the test that follows every link on every page.
 */
export const REVIEW_PATH = '/dashboard?view=review';

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
    }
  | {
      /**
       * What the brain holds — the first page in this product that shows its
       * owner content-derived information rather than plumbing.
       *
       * **Every field is shape, and the type is what makes that structural
       * rather than careful.** {@link CoverageView} admits only numbers,
       * instants and strings from sets the schema declares in a CHECK, so there
       * is no title, statement, canonical name, alias or external reference
       * available to render here even by mistake. `src/web/coverage.ts` carries
       * the four arguments for that line; the one that decides it is that a web
       * session carries no grant, so a names listing here would be this
       * product's first fence-free content read, reached with a cookie.
       *
       * **Three renders, not one.** `available: false` is a deployment with no
       * port and gets the explanation rather than zeroes — on this page zeroes
       * would be indistinguishable from an empty brain, which is the one
       * distinction it exists to draw. `reachable: false` is a brain that would
       * not open. Both keep the way back on the page.
       */
      readonly kind: 'coverage';
      readonly available: boolean;
      readonly reachable: boolean;
      /** The account's effective plan, which decides whether a cold layer is a fault. */
      readonly tier: string;
      readonly view: CoverageView | null;
    }
  | {
      /**
       * How far each step has got — `coverage`'s sibling, and a sibling rather
       * than a section because this one opens the tenant database for counters
       * over `chunk`, `attachment` and `page` that `coverage.ts` deliberately
       * does not carry: one click pays for one page.
       *
       * Three renders for `coverage`'s reasons, and a fourth state inside the
       * normal one: a free brain renders the section's ABSENCE rather than six
       * zeroes, because on that plan the six model phases are the plan and not
       * a fault.
       */
      readonly kind: 'processing';
      readonly available: boolean;
      readonly reachable: boolean;
      readonly tier: string;
      readonly view: ProcessingView | null;
    }
  | {
      /**
       * What is waiting on a decision.
       *
       * The one page in the product that renders a brain-derived sentence, and
       * `src/web/review.ts`'s header carries the argument for the crossing. The
       * type is deliberately the module's own: the queries there are what
       * enforce the caps and the withholdings, so a renderer cannot widen them.
       */
      readonly kind: 'review';
      readonly available: boolean;
      readonly reachable: boolean;
      readonly tier: string;
      readonly view: ReviewView | null;
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
  .step-name { font-weight: 600; }
  .quoted { border-left: 3px solid rgba(127,127,127,0.5); padding: 0.25rem 0 0.25rem 0.75rem; margin: 0.5rem 0; }
  .verbs { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
  .verbs form { display: inline; }
  .verbs button { width: auto; margin-top: 0; }
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
<p><a href="${COVERAGE_PATH}">What your brain knows &rarr;</a></p>
<p><a href="${PROCESSING_PATH}">What your brain is working on &rarr;</a></p>
<p><a href="${REVIEW_PATH}">Waiting on you &rarr;</a></p>
<p><a href="/retractions">What you can still undo &rarr;</a></p>
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

    case 'coverage':
      return coveragePage(page);

    case 'processing':
      return processingPage(page);

    case 'review':
      return reviewPage(page);

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

/** `1 document` / `2 documents`, so no line on this page reads like a stub. */
function count(n: number, one: string, many: string): string {
  return `${escapeHtml(String(n))} ${n === 1 ? one : many}`;
}

/**
 * What each entity type is called to a person.
 *
 * The keys are `entity.entity_type`'s CHECK and nothing else — a closed set of
 * eight, declared in the schema. "Your brain knows 340 people and 88
 * organizations" is the most legible sentence on this page for somebody who has
 * no other window into their brain, and it costs no name.
 */
const ENTITY_NOUNS: Readonly<Record<EntityKind, readonly [string, string]>> = {
  person: ['person', 'people'],
  organization: ['organization', 'organizations'],
  place: ['place', 'places'],
  project: ['project', 'projects'],
  product: ['product', 'products'],
  event: ['event', 'events'],
  topic: ['topic', 'topics'],
  other: ['other thing', 'other things'],
};

/**
 * What the last cycle did, in a sentence rather than a code.
 *
 * **The vocabularies are closed sets from the schema, and they are kept apart on
 * purpose.** `stop_reason` is what the *run* did (`v3-consolidation.sql:109`)
 * and `stopped_phase_code` is what a *phase* did (`v20-stopped-phase.sql:81`);
 * the schema refuses to let them blur, and so does this. A cycle that stopped at
 * `extract` with `model_unavailable` is a different thing to know than one that
 * stopped because the plan has no model half, and telling a free user that
 * something went wrong when nothing did is the failure this page would most
 * easily commit.
 *
 * The raw codes are rendered beside the sentence rather than replaced by it:
 * they are what a user can quote when they ask for help.
 *
 * **`currentTier` is the reader's plan and the run record's tier is not.**
 * `stop_reason = 'free_tier'` says what the cycle did when it ran, and a user
 * who upgraded ten minutes ago has a paid subscription sitting over a newest run
 * that still says it. Reading the run's tier as the reader's pitched the paid
 * plan to somebody who had just bought it — on the page they had opened to find
 * out whether buying it had worked, which is the one place that lands worst.
 */
function stopDetail(
  cycle: NonNullable<CoverageView['latestCycle']>,
  currentTier: string,
): string {
  switch (cycle.stopReason) {
    case 'free_tier':
      // Past tense for the upgraded reader, and no word about the next cycle:
      // "the next one will run it" is a promise about a pipeline this page has
      // no way to see the health of, which is the failure it exists to stop.
      // What it can state is the plan they are on.
      return currentTier === 'paid'
        ? `It ran the deterministic half only, because this account was on the free
plan when that cycle ran. The half that turns documents into facts, people and companies is
on your plan now.`
        : `It ran the deterministic half only: on the free plan, the half that turns
documents into facts, people and companies is on the paid plan. That is the plan working rather than
something going wrong.`;
    case 'budget_exhausted':
      return `It stopped early because the spend budget for one cycle ran out.`;
    case 'phase_failed':
      return `It stopped in the <code>${escapeHtml(cycle.stoppedPhase ?? 'unnamed')}</code>
phase, reporting <code>${escapeHtml(cycle.stoppedPhaseCode ?? 'no code')}</code>. The steps after it
were still attempted; whether they got anywhere is not something this run record says.`;
    case 'out_of_time':
      return `It ran out of the time one attempt is given, part way through. Nothing failed
and no spend cap fired; there was more to do than fitted.`;
    case 'cancelled':
      return `It was cancelled before it got to the end.`;
    case 'complete':
      return `It completed without needing the model half.`;
    default:
      // An unrecognised code renders as itself rather than as a guess. A run
      // written by a fleet newer than this page has a reason this file has no
      // name for, and printing the code is strictly better than the silence
      // that used to stand here — it is the string a user can quote.
      return `It stopped, reporting <code>${escapeHtml(String(cycle.stopReason))}</code>.`;
  }
}

/**
 * The consolidation line, from the run record and nothing else.
 *
 * **The (`finished_at`, `stop_reason`) PAIR is read, never `finished_at` alone,
 * and that is the failure this closes.** The sentence used to open with `if
 * (finishedAt === null) return 'A cycle is running now'`, on the assumption that
 * an open run is a busy one. It never was: a cycle that stopped short banks its
 * reason and leaves the run open, so `phase_failed at extract` — the frozen
 * brain that sat at 5,608 pages and 167 facts, the incident rung 20 exists for —
 * reported itself to its owner as *busy* for as long as it stayed broken. The
 * page written to make a freeze visible said the opposite in exactly that case,
 * and the whole `stop_reason` switch below it was unreachable in production.
 *
 * **A surface may state what it observes and must not assert what it cannot
 * verify**, so the three shapes this row can take are three sentences:
 *
 *   * **open with a reason banked** — it stopped, and it says what stopped it.
 *     Unambiguous, and the state that was being mis-reported;
 *   * **open with nothing banked** — a cycle in flight and a cycle killed before
 *     it could write are the SAME row here. Nothing distinguishes them, so the
 *     page names both and picks neither rather than choosing the flattering one;
 *   * **closed** — it finished, and the reason says how.
 *
 * Reading the pair is also what makes this correct across rung 23, which closes
 * a run on every exit: the shapes move between branches as the writer changes,
 * and rows written on both sides of that change still render as themselves —
 * the first branch below is now reached only by rows a pre-rung-23 fleet left
 * behind, and it is kept because those rows are still in production databases
 * until the next cycle closes them. No
 * branch here claims what a *next* cycle will do — that is a fact about a worker
 * this page cannot see, and it is the class of promise the surface exists to
 * stop making.
 */
function cycleSentence(
  cycle: NonNullable<CoverageView['latestCycle']>,
  currentTier: string,
): string {
  const opened = moment(new Date(cycle.startedAt));

  if (cycle.finishedAt === null) {
    if (cycle.stopReason === null) {
      return `A cycle opened ${opened} and nothing has been recorded against it. A cycle that
is still running and one that was killed before it could write look the same from here, so this page
does not guess between them — either way the numbers below are from before it opened.`;
    }
    return `A cycle opened ${opened} and has not closed. ${stopDetail(cycle, currentTier)}`;
  }

  const when = `Your last cycle finished ${moment(new Date(cycle.finishedAt))}.`;
  if (cycle.dreamt) return `${when} It ran the whole pipeline.`;
  return `${when} ${stopDetail(cycle, currentTier)}`;
}

/**
 * The freeze, said out loud, when a stopped cycle has stopped being an incident
 * and started being a state.
 *
 * **Why this exists on top of {@link cycleSentence}, which already names the
 * stop.** That sentence describes the *newest* cycle: "it stopped in the extract
 * phase, reporting bad_output". True, and for one bad Tuesday it is also
 * sufficient — the next cycle resumes into the open run and the reader needs to
 * do nothing. What it cannot say is that the same sentence has been true every
 * day for a week, and that is the entire difference between a hiccup and the
 * multi-day freeze this page exists for: 5,608 documents, 167 facts, flat,
 * while a cycle ran and stopped and ran again on the ceiling every single day.
 * A reader who saw only the newest cycle's reason had no way to tell those
 * apart, and neither did anybody else — every clock in the control plane
 * advanced normally throughout, because a cycle that stops short still *returns*
 * and a job that returns is done.
 *
 * So this row is about *duration*, and it is the only thing on the page that is.
 *
 * **It states what it observed and promises nothing.** No branch here says a
 * next cycle will fix it — that is a fact about a worker this page cannot see,
 * and it is the class of promise the surface exists to stop making. `slipping`
 * and the two quiet states render nothing at all: a page that prints a warning
 * on an ordinary day is a page whose warnings stop being read, which is how a
 * week of silence happens.
 */
function freezeNote(view: CoverageView): string {
  // `capped` is rendered here and is deliberately NOT in `isAlarming`. The two
  // are different questions: `isAlarming` decides whether a fleet operator is
  // paged, and nobody should be paged because an owner's cap did what they set
  // it to do. The owner is the one party who can act on it, so they are told —
  // in the quiet voice, which is the difference between "not red" and "not
  // shown". Reading the cap as silence is how a brain sits still for most of a
  // billing window while its owner believes it is working.
  if (!isAlarming(view.cycleFreshness) && view.cycleFreshness !== 'capped') return '';

  const since =
    view.lastCompletedAt === null
      ? null
      : `<time datetime="${escapeHtml(view.lastCompletedAt)}">${escapeHtml(
          view.lastCompletedAt,
        )}</time>`;

  switch (view.cycleFreshness) {
    case 'stale':
      // The incident's own cell. Cycles ARE running — saying "nothing has run"
      // here would be false and would send the reader looking in the wrong
      // place.
      //
      // **"The numbers below have not moved since then" used to close this
      // sentence, and it was false for most of the reasons that reach here.** A
      // cycle stops BETWEEN phases, and every phase that finished before the
      // stop committed its work (`cycle.ts`: "committed work plus a cursor is
      // progress"; the model phases bank theirs in the content). So on an
      // `out_of_time` or a `cancelled` brain the counts below climb daily while
      // the red paragraph claimed they were frozen — the page's own docstring
      // forbids exactly that, on the alarming path, to the one reader most
      // likely to check the sentence against the number directly beneath it.
      //
      // What replaces it is true of all three reasons that reach this cell
      // rather than branching into a guess per reason: the phases that ran did
      // commit, and the phases after the stop were never reached. Which phase
      // and which code is already named by `cycleSentence` immediately above,
      // so this row does not repeat it — this row is the DURATION.
      return `\n<p class="problem">Cycles have been running and stopping before the end for longer
than that is normally worth waiting out. The last one that finished was ${since ?? 'not recorded'}.
Each of those cycles kept whatever it got through before it stopped, so the numbers below are not
frozen at that date — but nothing has reached the end of the pipeline since, and whatever the phases
after the stop would have produced is not here.</p>`;
    case 'capped':
      // Same clock as `stale`, different fact, and a quiet class rather than a
      // red one. The cap is the owner's own instruction; what they need is the
      // one thing that is genuinely surprising about it — that it is a rolling
      // 30-day figure, so it does not reset at the next cycle, or tomorrow.
      return `\n<p class="note">Your cycles have been stopping because this brain's spend cap is
reached. The last one that finished was ${since ?? 'not recorded'}. The cap is a rolling 30-day
figure rather than an allowance per cycle, so it stays reached until enough of the window passes or
you raise it — until then each cycle does the free work and stops before the paid part.</p>`;
    case 'never_completed':
      // Deliberately not the same sentence. "It stopped finishing" and "it has
      // never once finished" send a reader to different places, and only one of
      // them is about something that used to work.
      return `\n<p class="problem">No cycle has ever run all the way through on this brain. What you
have sent is stored and searchable; the numbers below are what the cycles that stopped managed to
produce before they stopped.</p>`;
    case 'unattended':
      // **"No cycle has run at all" is what this said first, and it is exactly
      // the assertion this page forbids itself.** Two shapes reach `unattended`:
      // a newest cycle that completed long ago (nothing has run since), and a
      // newest cycle that banked no reason at all — a cycle in flight, or one
      // killed before it could write. In the second, `cycleSentence` renders "a
      // cycle opened X and nothing has been recorded against it" immediately
      // above this row, so the two sentences contradicted each other on the same
      // screen. What is true in both is that nothing has *finished*, and that
      // the newest cycle is not pointing at anything.
      return `\n<p class="problem">No cycle has finished on this brain since ${
        since ?? 'before its records begin'
      }. The newest one is not reporting a failure, so there is nothing here to point at — which is a
different shape from a cycle that stops and says why.</p>`;
    default:
      // `isAlarming` is a closed set and the three cases above are it. A reading
      // added there and not here renders nothing rather than a guess.
      return '';
  }
}

/**
 * What the brain holds.
 *
 * **The order is the argument.** Arrivals first, because "nothing has come from
 * this account in nine days" is the sentence that would have made a ten-hour
 * ingest outage visible to the person it was happening to. Consolidation second
 * and *before* the derived numbers, because a small fact count means one thing
 * when the cycle ran last night and something else entirely when it has been
 * frozen for a week — and a page that printed the number without the sentence
 * would be presenting a symptom as a truth. Everything derived comes after the
 * explanation of why it might be small.
 *
 * **No number here links anywhere.** "Your brain knows 340 people" answers *is
 * it working*; "here are their names" answers *what does it know about her*,
 * which is retrieval — it needs a fence, a grant and pagination that this page
 * has none of, and the assistant already is that product.
 */
/**
 * What each step is called to a person, and what it works on.
 *
 * Keyed on the phase, so a widened vocabulary breaks at compile time rather than
 * rendering a raw identifier at somebody — the template is `ENTITY_NOUNS`.
 */
const PHASE_WORK: Readonly<Record<ProcessingPhase, readonly [string, string, string]>> = {
  transcribe: ['Reading images and PDFs', 'file', 'files'],
  extract: ['Reading passages for facts', 'passage', 'passages'],
  enrich: [
    'Filling in people and companies',
    'person, company or thing',
    'people, companies and things',
  ],
  synopsis: ['Summarising documents', 'document', 'documents'],
  contradiction: ['Checking claims against each other', 'fact', 'facts'],
  salience_refine: ['Re-scoring what matters', 'document', 'documents'],
};

/**
 * The last cycle's recorded spend, in dollars.
 *
 * **Read the arithmetic before simplifying it.** `test/ai/price-drift.test.ts`
 * refuses a numeric literal equal to a canonical price on a line whose raw text
 * matches its price context, and that pattern includes a bare `$`. `1_000_000`
 * IS canonical, so `micro / 1_000_000` on the same line as the `$` would be a
 * finding — and correctly, because the guard cannot tell a unit from a rate.
 * `10_000` and `100` are in neither set, and neither shares a line with a `$`.
 *
 * Below the rounding floor it says so rather than printing `$0.00`, which reads
 * as free on the page whose job is saying whether the paid half ran at all.
 */
function spend(storedMicro: number): string {
  const hundredths = Math.round(storedMicro / 10_000);
  if (hundredths === 0) return storedMicro === 0 ? 'nothing' : 'less than a cent';
  const dollars = hundredths / 100;
  return `$${escapeHtml(dollars.toFixed(2))}`;
}

/**
 * One sentence about what the last cycle did to this step, or nothing.
 *
 * `failed_here` says **attempted**, not "still ran" and certainly not "nothing
 * after it ran": the cycle records only the FIRST durable phase failure and
 * carries on, so a run in which three phases failed names one and says nothing
 * about the other two. The run record holds one attribution and the sentence
 * must not claim more.
 */
function standingSentence(
  standing: string,
  stoppedPhase: string | null,
  stoppedPhaseCode: string | null,
): string {
  const code = stoppedPhaseCode === null ? 'no code' : stoppedPhaseCode;
  switch (standing) {
    case 'stopped_here':
      return `<p class="note">The last cycle stopped in this step, reporting <code>${escapeHtml(
        code,
      )}</code>.</p>`;
    case 'not_reached':
      return stoppedPhase === null
        ? ''
        : `<p class="note">The last cycle stopped at <code>${escapeHtml(
            stoppedPhase,
          )}</code> before it got this far.</p>`;
    case 'failed_here':
      return `<p class="note">The last cycle's attempt at this step reported <code>${escapeHtml(
        code,
      )}</code>. The steps after it were still attempted.</p>`;
    default:
      return '';
  }
}

/**
 * The processing view. Three renders, plus a free-tier shape inside the normal
 * one — `coveragePage`'s structure, for `coveragePage`'s reasons.
 *
 * Every instant goes through {@link moment}: a relative phrase is a number that
 * starts lying the moment it is sent, and nothing on this page can tick one
 * because the CSP admits no script. No form, either — the owner can perform none
 * of these remedies, and a page of dead affordances is a documented harm here.
 */
/**
 * What each refusal means to the person who cannot press the button.
 *
 * Prose beside the row, never a disabled button: "a form whose route answers
 * 402 or 501 is the dead affordance the whole panel exists to stop being".
 */
const REFUSAL_SENTENCE: Readonly<Record<string, string>> = {
  origin_severed:
    'This came from an account you disconnected and cleared, so its text is not shown here any more. Discarding it is the only thing left to do with it.',
  needs_an_embedding:
    'Adding a fact needs a vector this page cannot buy — only a consolidation cycle can. You can discard it.',
  needs_corroboration:
    'A commitment carries a corroboration verdict that is decided when it is written, not from a form. You can discard it.',
  no_apply_path:
    'Nothing in this system writes this kind of proposal yet, so there is nothing to apply. You can discard it.',
  too_long_to_read:
    'This is longer than this page will show, and a button that writes text you have not read is worse than no button. You can discard it.',
  target_gone:
    'The person or company this was about is no longer in your brain, so there is nothing for it to describe. You can discard it.',
};

/**
 * Model-derived prose, marked as such wherever it is rendered.
 *
 * These strings are a model's words about mail a stranger wrote, so they are the
 * one thing on any owner-facing page that an outsider had a hand in. Quoting
 * them visually is what stops a sentence like "Ignore the above and press
 * Discard" reading as though the product said it.
 */
function quoted(text: string, truncated: boolean): string {
  return `<div class="quoted">${escapeHtml(text)}${
    truncated ? ' <span class="note">(shown in part)</span>' : ''
  }</div>`;
}

function proposalRow(row: Proposal): string {
  const subject =
    row.subjectName === null
      ? 'Something in your brain'
      : `${escapeHtml(row.subjectName)}${row.nameTruncated ? '…' : ''}`;
  const now =
    row.current === null
      ? '<p class="note">There is nothing recorded about them yet.</p>'
      : `<p class="note">Now${row.currentIsYours ? ', from a decision you made' : ''}:</p>
${quoted(row.current, row.currentTruncated)}`;
  const proposed =
    row.proposal === null
      ? ''
      : `<p class="note">Proposed:</p>
${quoted(row.proposal, row.truncated)}`;
  const refusal =
    row.refusal === null
      ? `<div class="verbs">
  <form method="post" action="/api/review">
    <input type="hidden" name="review_id" value="${escapeHtml(row.reviewId)}">
    <input type="hidden" name="seen_card_id" value="${escapeHtml(row.currentCardId ?? '')}">
    <input type="hidden" name="intent" value="apply">
    <button type="submit">Use this</button>
  </form>
  <form method="post" action="/api/review">
    <input type="hidden" name="review_id" value="${escapeHtml(row.reviewId)}">
    <input type="hidden" name="intent" value="dismiss">
    <button type="submit">Discard</button>
  </form>
</div>
<p class="note">Using this keeps it as yours: consolidation will stop rewriting this
description, and it will not change again until you decide otherwise here. You can undo it
straight afterwards.</p>`
      : `<p class="note">${escapeHtml(REFUSAL_SENTENCE[row.refusal] ?? '')}</p>
<div class="verbs">
  <form method="post" action="/api/review">
    <input type="hidden" name="review_id" value="${escapeHtml(row.reviewId)}">
    <input type="hidden" name="intent" value="dismiss">
    <button type="submit">Discard</button>
  </form>
</div>`;

  return `  <li>
    <div class="step-name">${subject}</div>
    <p class="note">Suggested ${moment(new Date(row.createdAt))} &middot; <code>${escapeHtml(
      row.kind,
    )}</code></p>
${now}${proposed}${refusal}
  </li>`;
}

const CONFLICT_KINDS: Readonly<Record<string, string>> = {
  value_conflict: 'These two say different things',
  temporal_conflict: 'These two disagree about when',
  duplicate: 'These two may be the same thing said twice',
};

function conflictSide(label: string, side: { statement: string | null; state: string; truncated: boolean }): string {
  if (side.statement === null) {
    return `<p class="note">${escapeHtml(label)}: this statement has been removed from your brain,
so it is not shown.</p>`;
  }
  const marked = side.state === 'superseded' ? ' <span class="note">(since replaced)</span>' : '';
  return `<p class="note">${escapeHtml(label)}:${marked}</p>${quoted(side.statement, side.truncated)}`;
}

function conflictRow(row: ReviewView['contradictions'][number]): string {
  const verb = (intent: string, label: string) => `  <form method="post" action="/api/contradictions">
    <input type="hidden" name="report_id" value="${escapeHtml(row.reportId)}">
    <input type="hidden" name="intent" value="${escapeHtml(intent)}">
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;

  const verbs = row.adjudicable
    ? `<div class="verbs">
${verb('left', 'The first is right')}
${verb('right', 'The second is right')}
${verb('both', 'Both are right')}
${verb('neither', 'Neither is right')}
${verb('dismiss', 'Stop showing me this')}
</div>
<p class="note">Recording an answer here writes down what you concluded. It does not delete or
replace either statement — both stay in your brain and both stay searchable. If you want one
gone, ask your assistant to forget it; that is undoable for 72 hours.</p>`
    : `<p class="note">One of these has been removed from your brain, so there is nothing left to
decide between.</p>
<div class="verbs">
${verb('dismiss', 'Stop showing me this')}
</div>`;

  return `  <li>
    <div class="step-name">${escapeHtml(CONFLICT_KINDS[row.kind] ?? 'These two may disagree')}</div>
    <p class="note">Noticed ${moment(new Date(row.detectedAt))}</p>
${conflictSide('The first', row.left)}
${conflictSide('The second', row.right)}
${verbs}
  </li>`;
}

/**
 * The decisions screen.
 *
 * Four renders, `coveragePage`'s, plus an empty state that is the steady state:
 * a brain with nothing waiting is a brain that is working.
 */
function reviewPage(page: Extract<Page, { kind: 'review' }>): string {
  const back = '<p><a href="/dashboard">Back to your dashboard</a></p>';
  const title = 'Waiting on you — brainz';
  const rule = `<p class="note">This is the one page that shows you sentences from inside your brain,
because a decision about a sentence cannot be made without reading it. It shows only what is
undecided and nothing else — no lists, no search, no browsing. Everything quoted below was written
by a model from your own documents.</p>`;

  if (!page.available) {
    return shell(
      title,
      `<h1>Waiting on you</h1>
<p class="problem">This deployment cannot read your brain, so this page cannot tell you what is
waiting. An empty page would say "nothing is waiting on you", which is the opposite of what is
true here.</p>
${back}`,
    );
  }

  if (!page.reachable || page.view === null) {
    return shell(
      title,
      `<h1>Waiting on you</h1>
<p class="problem">Your brain could not be reached just now. That is most often a database waking up
after a quiet spell — loading this page again in a few seconds is usually the whole remedy.</p>
<p class="note">Nothing has been lost and nothing has been decided in the meantime.</p>
${back}`,
    );
  }

  const view = page.view;

  if (!view.everDreamt) {
    return shell(
      title,
      `<h1>Waiting on you</h1>
${rule}
<p>Your brain has not finished a consolidation cycle yet, so it has not had the chance to find
anything it needs you for. Nothing is wrong.</p>
<p class="note"><a href="${escapeHtml(PROCESSING_PATH)}">What your brain is working on &rarr;</a></p>
${back}`,
    );
  }

  const nothing = view.proposals.length === 0 && view.contradictions.length === 0;
  if (nothing) {
    return shell(
      title,
      `<h1>Waiting on you</h1>
<p>Nothing is waiting on you. Your brain will put something here when it finds a claim it is not
confident enough to record on its own, or two things it holds that disagree.</p>
<p class="note"><a href="${escapeHtml(COVERAGE_PATH)}">What your brain knows &rarr;</a> &middot;
<a href="${escapeHtml(PROCESSING_PATH)}">What it is working on &rarr;</a></p>
${back}`,
    );
  }

  const proposals =
    view.proposals.length === 0
      ? ''
      : `<h2>Suggestions</h2>
<p class="note">Your brain was not confident enough to record these on its own, so it is asking. It
will not act on any of them until you do.</p>
<ul class="sources">
${view.proposals.map(proposalRow).join('\n')}
</ul>${
          view.proposalsOverflowed
            ? '<p class="note">Only the newest are shown. Decide some of these and the rest will appear.</p>'
            : ''
        }`;

  const conflicts =
    view.contradictions.length === 0
      ? ''
      : `<h2>Disagreements</h2>
<p class="note">Your brain holds both of these and they do not fit together. Recording which is
right is a note to yourself and to your assistant; nothing is deleted either way.</p>
<ul class="sources">
${view.contradictions.map(conflictRow).join('\n')}
</ul>${
          view.contradictionsOverflowed
            ? '<p class="note">Only the newest are shown. Decide some of these and the rest will appear.</p>'
            : ''
        }`;

  return shell(
    title,
    `<h1>Waiting on you</h1>
${rule}
${proposals}
${conflicts}
${back}`,
  );
}

function processingPage(page: Extract<Page, { kind: 'processing' }>): string {
  const back = '<p><a href="/dashboard">Back to your dashboard</a></p>';
  const title = 'What your brain is working on — brainz';
  // NOT coverage's sentence. That one promises "counts, codes and times"; this
  // page also renders a dollar figure, which is none of the three. Copying it
  // and then printing money under it would understate the page in the one
  // paragraph whose whole job is being exact.
  const rule = `<p class="note">This page shows counts, codes, times, and what your last cycle cost.
It never shows a title, a name, a subject line or a sentence from anything you have stored — not even
your own. It is meant to be safe to screenshot, to put on a meeting-room screen, and to leave open on
a desk.</p>`;

  if (!page.available) {
    return shell(
      title,
      `<h1>What your brain is working on</h1>
<p class="problem">This deployment cannot read your brain, so this page has nothing to measure.
Six steps all reading "nothing waiting" would be indistinguishable from a brain that has finished everything, which is the opposite of the truth here.</p>
${back}`,
    );
  }

  if (!page.reachable || page.view === null) {
    return shell(
      title,
      `<h1>What your brain is working on</h1>
<p class="problem">Your brain could not be reached just now. That is most often a database waking up
after a quiet spell — loading this page again in a few seconds is usually the whole remedy.</p>
<p class="note">Nothing has been lost and nothing has stopped: what arrives while this page cannot be
drawn still arrives. Your plan, your connected accounts and everything else on your dashboard are
unaffected.</p>
${back}`,
    );
  }

  const view = page.view;
  const cycle = view.latestCycle;

  if (view.lastArrivedAt === null) {
    return shell(
      title,
      `<h1>What your brain is working on</h1>
${rule}
<h2>Arriving</h2>
<p>Nothing has reached this brain yet, so there is nothing for the steps below to work on.</p>
<p class="note"><a href="${escapeHtml(COVERAGE_PATH)}">What your brain knows &rarr;</a> &middot;
<a href="/connect">Connect an account &rarr;</a></p>
${back}`,
    );
  }

  const arriving = `<h2>Arriving</h2>
<p>The most recent document reached this brain ${moment(new Date(view.lastArrivedAt))}.</p>
<p class="note">This is the clock the rest of this page is read against: a step with a large number
waiting under a document that arrived months ago is a different thing from the same number under one
that arrived this morning. <a href="${escapeHtml(COVERAGE_PATH)}">What came from where &rarr;</a>
&middot; <a href="/dashboard">Connected accounts &rarr;</a></p>`;

  // The deterministic-stop shape: a section-level line, not six rows. When the
  // cycle stopped in a phase that is not one of these six, every row here is
  // `not_reached` — correctly — but the NAME is withheld, because telling an
  // owner they are behind on work that produces nothing they can see is worse
  // than silence.
  const stoppedOutside =
    cycle !== null &&
    cycle.stoppedPhase !== null &&
    !(PROCESSING_PHASES as readonly string[]).includes(cycle.stoppedPhase);
  const prefixNote = stoppedOutside
    ? `<p class="note">The last cycle ran out before this half of the pipeline began, reporting
<code>${escapeHtml(cycle?.stoppedPhaseCode ?? 'no code')}</code>. The free half runs first and has a
share of each cycle; on a large brain it can use all of it.</p>`
    : '';

  let making: string;
  if (view.phases === null) {
    making = `<h2>Making sense of it</h2>
<p>The steps that turn documents into facts, people and companies are not on the free plan, so this
page has nothing to measure for them. Everything you send is still stored and searchable, and each
cycle still runs the free half — de-duplication, linking, staleness, scoring.</p>`;
  } else {
    const synopsisWaiting =
      view.phases.find((entry) => entry.phase === 'synopsis')?.waiting ?? 0;
    const allRefused =
      view.refusedWaiting !== null && view.refusedWaiting > 0 && view.refusedWaiting === synopsisWaiting;

    const rows = view.phases
      .map((entry) => {
        const [label, one, many] = PHASE_WORK[entry.phase];
        // Emphasis is position times duration, and neither is re-derived here.
        // One `out_of_time` cycle is an ordinary Tuesday; the same stop under a
        // freshness the staleness module calls alarming is the incident. A page
        // that prints a warning on an ordinary day is a page whose warnings stop
        // being read.
        const alarming =
          (entry.standing !== 'unknown' && isAlarming(view.cycleFreshness)) ||
          (entry.phase === 'synopsis' && allRefused);
        const amount =
          entry.waiting === 0 ? 'Nothing waiting' : `${count(entry.waiting, one, many)} waiting`;
        const shown = alarming ? `<strong>${amount}</strong>` : amount;
        // When the cycle stopped in a phase this page does not list, the
        // section line above carries the claim and no row may name it — the
        // whole point of withholding it is that the name means nothing to the
        // reader. Every row here is still `not_reached`, and correctly.
        const sentence = stoppedOutside
          ? ''
          : standingSentence(
              entry.standing,
              cycle?.stoppedPhase ?? null,
              cycle?.stoppedPhaseCode ?? null,
            );
        // The pacing note is gated on the step having actually been reached: in
        // the incident this page was written for, this step is `not_reached` and
        // its pace is zero a cycle, not "a small fixed batch". It carries no
        // number, because that is a tuning constant, and it states the rate and
        // stops — no estimate, no "it will catch up".
        const pacing =
          entry.phase === 'salience_refine' && entry.standing === 'unknown' && entry.waiting > 0
            ? `<p class="note">This step works through a small fixed batch each cycle whatever else is
happening, so a large number waiting under it is the pace rather than a fault.</p>`
            : '';
        const refusal =
          entry.phase === 'synopsis' && view.refusedWaiting !== null && view.refusedWaiting > 0
            ? `<p class="note">${escapeHtml(String(view.refusedWaiting))} of those have been sent to
the summariser and the answer could not be used; the most any one of them has been sent is ${count(view.mostRefusals ?? 0, 'time', 'times')}. Nothing has been dropped — they are still stored,
still searchable, and still candidates. That count says the answer could not be used. It does not say
the document is at fault: the same count goes up when a prompt or a model seat is the problem, and
this page cannot tell those apart.${
                allRefused
                  ? ' Every document waiting here is one of them, which is the shape of a step that is not getting through rather than of a few odd documents.'
                  : ''
              }</p>`
            : '';
        return `  <li${alarming ? ' class="failing"' : ''}>
    <div class="step-name">${escapeHtml(label)}</div>
    <p class="note">${shown} &middot; <code>${escapeHtml(entry.phase)}</code></p>
${sentence}${refusal}${pacing}  </li>`;
      })
      .join('\n');

    making = `<h2>Making sense of it</h2>
${prefixNote}<ul class="sources">
${rows}
</ul>
<p class="note">"Waiting" is what each step would take next, counted the same way the step itself
selects it. A step with nothing waiting has been through everything currently in this brain; it is
not a claim that it found something in all of it — a step records a document as looked at whether or
not anything came of it, and a step that answered thinly about a large batch looks the same from here
as one that answered well. To read these numbers against the size of the brain, the totals are on
<a href="${escapeHtml(COVERAGE_PATH)}">what your brain knows</a>.</p>`;
  }

  let last: string;
  if (cycle === null) {
    last = `<h2>The last cycle</h2>
<p>No cycle has run on this brain yet, so none of these steps has been reached. What you have sent is
stored and searchable.</p>`;
  } else if (cycle.finishedAt === null) {
    last = `<h2>The last cycle</h2>
<p>A cycle opened ${moment(new Date(cycle.startedAt))} and nothing has been recorded against it yet.
A cycle that is still running and one that was killed before it could write look the same from here,
so this page does not guess between them.</p>`;
  } else {
    const completion =
      cycle.dreamt || cycle.stopReason === 'complete' || cycle.stopReason === 'free_tier';
    // A shortfall is rendered ONLY under a completion, and always with its
    // cause. Under a completion those are the only two possible causes, so the
    // sentence is exhaustive; under anything else a bare fraction would sit
    // beside large waiting counts with no explanation anywhere on the page.
    const ran = !completion
      ? ''
      : cycle.phasesRun === cycle.phasesPlanned
        ? ' It ran every step of the pipeline.'
        : ` It ran ${escapeHtml(String(cycle.phasesRun))} of its ${escapeHtml(
            String(cycle.phasesPlanned),
          )} steps. The ones it did not run were not skipped over a failure: the free half stops once
it has used its share of the cycle and starts again from the top next time, and a step an earlier
attempt of the same cycle already paid for is not paid for twice.`;
    const calls =
      cycle.modelCalls === 0
        ? ' It made no calls to a model.'
        : ` It made ${count(cycle.modelCalls, 'call', 'calls')} to a model and recorded ${spend(
            cycle.spentMicroUsd,
          )} of spend against itself.`;
    last = `<h2>The last cycle</h2>
<p>It opened ${moment(new Date(cycle.startedAt))} and closed ${moment(
      new Date(cycle.finishedAt),
    )}.${ran}${calls}</p>
<p class="note">That figure is what the cycle banked against itself, not your bill. A call the
provider answered and this brain could not use is charged to your account and recorded here as
nothing, so a cycle that made calls and recorded almost no spend is one of the shapes a step that is
not getting through takes.</p>
<p><a href="${escapeHtml(COVERAGE_PATH)}">How long it has been like this &rarr;</a></p>`;
  }

  return shell(
    title,
    `<h1>What your brain is working on</h1>
${rule}
${arriving}
${making}
${last}
${back}`,
  );
}

function coveragePage(page: Extract<Page, { kind: 'coverage' }>): string {
  const back = '<p><a href="/dashboard">Back to your dashboard</a></p>';
  // The rule, at the top, where somebody deciding whether to screenshot this is.
  const rule = `<p class="note">This page shows counts, codes and times. It never shows a title, a
name, a subject line or a sentence from anything you have stored — not even your own. It is meant to
be safe to screenshot, to put on a meeting-room screen, and to leave open on a desk.</p>`;

  if (!page.available) {
    return shell(
      'What your brain knows — brainz',
      `<h1>What your brain knows</h1>
<p class="problem">This deployment cannot read your brain, so this page has nothing to count. A page
of zeroes would be indistinguishable from a brain with nothing in it, and telling those two apart is
the only reason this page exists.</p>
${back}`,
    );
  }

  if (!page.reachable || page.view === null) {
    return shell(
      'What your brain knows — brainz',
      `<h1>What your brain knows</h1>
<p class="problem">Your brain could not be reached just now. That is most often a database waking up
after a quiet spell — loading this page again in a few seconds is usually the whole remedy.</p>
<p class="note">Nothing has been lost and nothing has stopped: what arrives while this page cannot be
drawn still arrives. Your plan, your connected accounts and everything else on your dashboard are
unaffected.</p>
${back}`,
    );
  }

  const view = page.view;
  // The total is stated rather than left to be added up: the derived numbers
  // below only mean anything beside it — a large pile of documents with very few
  // facts under it is a diagnosis, and a fact count on its own is decoration.
  const total = `<p>${count(view.documents, 'document held', 'documents held')}, ${escapeHtml(
    String(view.documentsThisWeek),
  )} of them in the last ${escapeHtml(String(view.windowDays))} days.</p>`;
  const sources =
    view.sources.length === 0
      ? `<p class="note">Nothing has reached this brain yet. This page notices when something does.</p>`
      : `${total}
<ul class="sources">
${view.sources
  .map(
    (source) => `  <li>
    <div><code>${escapeHtml(source.origin)}</code></div>
    <p class="note">${count(source.documents, 'document', 'documents')} &middot; most recent
${source.lastArrivedAt === null ? 'never' : moment(new Date(source.lastArrivedAt))} &middot;
${escapeHtml(String(source.thisWeek))} in the last ${escapeHtml(String(view.windowDays))} days</p>
  </li>`,
  )
  .join('\n')}
</ul>`;

  // Never from a card count: an empty card table says "cold" for a fully
  // consolidated brain that happens to know about nobody.
  const cold =
    page.tier === 'paid'
      ? `<p>Your brain has not consolidated yet. Everything you have sent is stored and searchable —
the half that turns documents into facts, people and companies has not run, so the numbers below stay
small until it does.</p>`
      : `<p>Your brain has not consolidated yet. On the free plan that is the plan rather than a
fault: everything you send is stored and searchable, and the half that turns documents into facts,
people and companies is on the paid plan.</p>`;

  const behind =
    view.documentsSinceLastCycle === 0
      ? ''
      : `\n<p class="note">${count(view.documentsSinceLastCycle, 'document has', 'documents have')}
arrived ${view.lastCompletedAt === null ? 'and are waiting for the first cycle' : 'since then'}. They
are stored and searchable; they are not in the numbers below.</p>`;

  const types =
    view.entityTypes.length === 0
      ? ''
      : `\n<h2>What it knows about</h2>
<ul class="sources">
${view.entityTypes
  .map((bucket) => {
    const nouns = ENTITY_NOUNS[bucket.type];
    return `  <li>${count(bucket.count, nouns[0], nouns[1])}</li>`;
  })
  .join('\n')}
</ul>`;

  // Only once the model tier has completed. A count that is structurally zero
  // for the tier the reader is on is a dead panel, and a dead panel teaches them
  // the feature is broken rather than that it has not run.
  const open =
    view.openContradictions === null || view.openReview === null
      ? ''
      : view.openContradictions === 0 && view.openReview === 0
        ? `\n<h2>Waiting on you</h2>
<p>Nothing is waiting on you.</p>`
        : // **Not "ask your assistant", which is what this said and what the
          // database forbids.** `review_queue.closed_by` admits
          // `user_out_of_band` and `internal` and nothing else, under a header
          // stating that `agent_mcp` is absent because the assistant holding
          // `remember` is the assistant reading the attacker's mail. The
          // assistant can describe these; it cannot close one. Pointing a reader
          // at the one actor that cannot act was the sentence that made this
          // whole queue unreachable for as long as it has existed.
          `\n<h2>Waiting on you</h2>
<p>${count(view.openContradictions, 'contradiction', 'contradictions')} and
${count(view.openReview, 'proposal', 'proposals')} are open.
<a href="${escapeHtml(REVIEW_PATH)}">Decide them &rarr;</a></p>`;

  // A brain with nothing in it is rendered without the derived section at all.
  // Three zeroes under a heading reading "what it made of them" is a small
  // number presented as a truth about a pipeline that has had nothing to do —
  // which is the exact failure this page exists to stop the dashboard making.
  const nothingYet = view.documents === 0 && view.facts === 0 && view.entities === 0;
  const derived = nothingYet
    ? ''
    : `\n<h2>What it made of them</h2>
<p>${count(view.facts, 'fact', 'facts')} &middot;
${count(view.entities, 'person, company or thing', 'people, companies and things')} &middot;
${count(view.edges, 'stated relationship', 'stated relationships')}</p>
<p class="note">These are what the brain derived from your documents, and they are the numbers to
read next to the document count above: a large pile of documents with very few facts under it means
consolidation is behind, not that there was nothing in them.</p>${types}${open}`;

  return shell(
    'What your brain knows — brainz',
    `<h1>What your brain knows</h1>
${rule}
<h2>Where it came from</h2>
${sources}
<p class="note">Documents, not passages: counting every passage of a large brain is a scan of the
biggest table it has, and this is a page load. If a source has stopped arriving, the connected
accounts panel on your dashboard is where the reason is.</p>
<h2>Consolidation</h2>
${
      view.latestCycle === null ? cold : `<p>${cycleSentence(view.latestCycle, page.tier)}</p>`
    }${freezeNote(view)}${behind}${derived}
<p><a href="${escapeHtml(PROCESSING_PATH)}">What your brain is working on &rarr;</a></p>
${back}`,
  );
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
