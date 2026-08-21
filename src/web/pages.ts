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
import type { EntityLookup, Roster, Subject } from './entity.ts';

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

/**
 * Where the rail's Settings row points.
 *
 * A query parameter for {@link COVERAGE_PATH}'s reason: `src/mcp/edge.ts`
 * enumerates web paths and `/settings` is not one of them.
 */
export const SETTINGS_PATH = '/dashboard?view=settings';

/** Where the rail's lookup row points. Idle by construction: it names no subject. */
export const ENTITY_PATH = '/dashboard?view=entity';

/** Where the rail's connected-accounts row points. Not `CONNECTORS_PATH`, which is the API. */
export const SOURCES_PATH = '/dashboard?view=connectors';

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
    }
  | {
      /**
       * One named subject, and the page the owner asked for instead of a
       * roster. `available: false` is a deployment with no port; a null lookup
       * with the port present is a brain that would not open.
       */
      readonly kind: 'entity';
      readonly available: boolean;
      readonly lookup: EntityLookup | null;
    }
  | {
      /**
       * Where mail and files come in from.
       *
       * Split off the dashboard on the owner's instruction. The sidebar design
       * had kept it there on the argument that four other sentences named the
       * dashboard as its location — so those four sentences moved in this same
       * change rather than being left pointing at a page that no longer holds
       * it, which is the failure that argument was warning about.
       */
      readonly kind: 'connectors';
      readonly connectorsAvailable: boolean;
      readonly connectors: readonly ConnectorStatus[];
    }
  | {
      /**
       * Account configuration, split off the dashboard.
       *
       * The three sections here — a write-only key form, the spend window and
       * the export note — are things you *set*, and none of them says anything
       * about what the brain holds. Connected accounts deliberately did NOT
       * come with them: that is the operational state of ingest, and four other
       * pieces of copy in this file point at the dashboard as its location.
       *
       * Reads `control.tenant` only, so this page opens no tenant database.
       */
      readonly kind: 'settings';
      readonly providers: readonly string[];
      /** Absent when no spend row exists — which is not the same as zero. */
      readonly spend: {
        readonly windowStartedAt: string;
        readonly spentMicroUsd: number;
        readonly capMicroUsd: number | null;
      } | null;
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

  /* The rail. Zero hex colours on purpose: everything is rgba(127,127,127,a),
     currentColor or a CSS system colour, which is the only reason
     'color-scheme: light dark' alone gives this app a dark mode. A literal
     colour here would read as a light-mode bug on a dark browser. */
  body.app { display: grid; grid-template-columns: 15rem minmax(0, 1fr); max-width: none; margin: 0; padding: 0; }
  /* 'width: 100%' and 'box-sizing' are load-bearing rather than belt-and-braces:
     auto inline margins on a grid item suppress 'justify-self: stretch', so
     without them 'main' is sized fit-content and a short page shrink-wraps and
     floats — measured, the h1's left edge moves 247px between two navigations.
     46.5rem rather than 44rem because under border-box a 44rem cap silently
     shaves the existing measure from 704px to 664px. */
  body.app > main { width: 100%; box-sizing: border-box; max-width: 46.5rem; margin: 3rem auto; padding: 0 1.25rem; }
  .skip { position: absolute; left: -9999px; top: 0; z-index: 1; padding: 0.5rem 0.75rem; background: Canvas; color: CanvasText; }
  /* Only 'left' changes. 'position: static' on focus would make it a grid item
     and displace the rail into column 2. */
  .skip:focus { left: 0; }
  a:focus-visible, button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  .rail { align-self: start; position: sticky; top: 0; height: 100vh; height: 100dvh; overflow-y: auto; scrollbar-width: thin;
    display: flex; flex-direction: column; padding: 1rem 0.75rem; box-sizing: border-box; border-right: 1px solid rgba(127,127,127,0.3); }
  .rail .brand { font-weight: 600; padding: 0 0.65rem 0.75rem; margin: 0; }
  .rail ul { list-style: none; margin: 0; padding: 0; }
  .rail li + li { margin-top: 0.15rem; }
  .rail a, .rail button { display: flex; align-items: center; gap: 0.65rem; padding: 0.4rem 0.65rem;
    border-radius: 0.4rem; font-size: 0.95rem; color: inherit; opacity: 0.75; }
  .rail a { text-decoration: none; border-left: 3px solid transparent; }
  .rail a:hover, .rail button:hover { background: rgba(127,127,127,0.12); opacity: 1; }
  .rail a[aria-current="page"] { background: rgba(127,127,127,0.18); opacity: 1; font-weight: 600; border-left-color: currentColor; }
  .rail svg { width: 1.125rem; height: 1.125rem; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .rail .grp { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0.9rem 0 0.25rem; padding: 0 0.65rem; }
  .rail .acct { margin-top: auto; padding-top: 0.75rem; border-top: 1px solid rgba(127,127,127,0.3); }
  /* Cancels the global 'button { margin-top: 1rem }', which would otherwise push
     sign-out a rem off the bottom of a 'margin-top: auto' group. */
  .rail button { margin: 0; width: 100%; text-align: left; background: none; border: 0; }
  @media (max-width: 43.75em) {
    body.app { grid-template-columns: minmax(0, 1fr); }
    body.app > main { margin-top: 1.5rem; }
    .rail { position: static; height: auto; overflow: visible; padding: 0.75rem; border-right: 0; border-bottom: 1px solid rgba(127,127,127,0.3); }
    .rail ul { display: flex; flex-wrap: wrap; gap: 0.25rem; }
    .rail li + li { margin-top: 0; }
    .rail a { border-left: 0; border-bottom: 2px solid transparent; }
    .rail a[aria-current="page"] { border-bottom-color: currentColor; }
    .rail .grp { display: none; }
    .rail .acct { margin-top: 0.5rem; padding-top: 0.5rem; }
    .rail button { width: auto; }
  }
  /* 'body.app { display: block }' is required rather than tidy: a 'display:none'
     child is not a grid item at all, so hiding the rail alone would leave 'main'
     the only in-flow item and auto-placement would drop it into COLUMN 1 — every
     railed page printing as a 335px strip on Letter, measured. That would defeat
     the reason this block exists, since coverage and processing both advertise
     themselves as safe to print and screenshot. */
  @media print { body.app { display: block; } .rail, .skip { display: none; } }
`;


// ---------------------------------------------------------------------------
// The rail.
// ---------------------------------------------------------------------------

/**
 * Icons, from lucide, with the node markup verbatim and the wrapper stripped.
 *
 * **Inline SVG is the only mechanism available.** The policy is
 * `default-src 'none'` with no `img-src` (`app.ts`), which blocks `<img>`, an
 * icon font, and a CSS `url(data:…)` background alike. Inline SVG is markup
 * rather than a fetch, so it is not governed by any of them.
 *
 * Every paint attribute lives in `STYLE`'s `.rail svg` rule instead of on each
 * node — they are SVG *presentation* attributes, so CSS may set them. That is
 * about 60 bytes saved per icon, and it is why an active row's `currentColor`
 * reaches its icon with no second rule.
 *
 * `aria-hidden` is required rather than tidy: the `<span>` beside it is the
 * link's accessible name, and without it a screen reader announces the svg as
 * an image and reads every row twice.
 */
const ICON_DASHBOARD =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_KNOWS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>';
const ICON_WORKING =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>';
const ICON_WAITING =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const ICON_SOURCES = // mailbox
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7 4 5 6.5 5H18c2.2 0 4 1.8 4 4v8Z"/><path d="M6 8h4"/><path d="M6 12h.01"/><path d="M16 19v-2a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>';
const ICON_ASSISTANT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/></svg>';
const ICON_UNDO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const ICON_LOOKUP = // search
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>';
const ICON_SETTINGS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/><path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>';
const ICON_SIGNOUT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/></svg>';

/** A rail row, as a closed set. Never a free string — see {@link shell}. */
type NavKey =
  | 'dashboard'
  | 'coverage'
  | 'processing'
  | 'review'
  | 'connect'
  | 'retractions'
  | 'settings'
  | 'entity'
  | 'connectors';

/**
 * What chrome a page gets: a rail with one row lit, a rail with none lit, or no
 * rail at all.
 *
 * `'blank'` is not laziness. The five connector and retraction notices are the
 * outcome of a POST rather than a destination, and marking a row
 * `aria-current="page"` on one of them would tell a screen reader that a link
 * points at the page the reader is already on, which is false.
 */
type Chrome = NavKey | 'blank' | 'none';

/**
 * Which row each page lights, and which pages get no rail at all.
 *
 * **A `Record` over `Page['kind']` rather than an optional argument**, and the
 * exhaustiveness is the point: a page added to the union does not compile until
 * somebody decides where it lives in the menu. An optional parameter would let
 * a new signed-in page ship chrome-less and silent.
 *
 * **`brain_setup` gets no rail, and that is the one place the dead-affordance
 * rule actually fires here.** It serves an account with no brain, and every
 * other signed-in render sends such an account straight back to it — so a rail
 * there is seven rows that all `303` to the page you are already on. A crawler
 * would not catch it either, because a 303 is not a 404. Only this table can.
 */
const PAGE_CHROME: Readonly<Record<Page['kind'], Chrome>> = {
  login: 'none',
  signup: 'none',
  reset_request: 'none',
  reset_sent: 'none',
  reset_complete: 'none',
  brain_setup: 'none',
  dashboard: 'dashboard',
  coverage: 'coverage',
  processing: 'processing',
  review: 'review',
  connect: 'connect',
  retractions: 'retractions',
  settings: 'settings',
  entity: 'entity',
  connectors: 'connectors',
  connector_claim: 'blank',
  connector_confirm_disconnect: 'blank',
  connector_disconnected: 'blank',
  connector_notice: 'blank',
  retraction_notice: 'blank',
};

/**
 * The rail's rows, in one table rather than seven hand-written blocks, because
 * the row shape is the thing that must not drift between rows.
 *
 * **Every row is badgeless, and the reason is cost rather than privacy.** The
 * privacy line permits a count on an ambient surface. What forbids it is
 * `app.ts`'s ruling that the default render opens no tenant database — *"waking
 * one because its owner asked is defensible where waking one because they
 * logged in is not."* Every number a badge could carry lives only in the tenant
 * database, so a badge on **Waiting on you** would wake a suspended brain on
 * every render of every page in the app, including the two that open no tenant
 * handle at all today.
 */
const RAIL_GROUPS: readonly {
  readonly caption: string | null;
  readonly rows: readonly {
    readonly key: NavKey;
    readonly href: string;
    readonly label: string;
    readonly icon: string;
  }[];
}[] = [
  {
    caption: null,
    // **`Dashboard`, not `Overview`.** Nine existing strings in this file call
    // this page "your dashboard", four of which are the argument for keeping
    // Connected accounts on it. A rail row named anything else renames the
    // destination out from under its own copy.
    rows: [{ key: 'dashboard', href: '/dashboard', label: 'Dashboard', icon: ICON_DASHBOARD }],
  },
  {
    caption: 'Your brain',
    rows: [
      { key: 'coverage', href: COVERAGE_PATH, label: 'What it knows', icon: ICON_KNOWS },
      { key: 'processing', href: PROCESSING_PATH, label: 'Working on it', icon: ICON_WORKING },
      { key: 'review', href: REVIEW_PATH, label: 'Waiting on you', icon: ICON_WAITING },
      { key: 'entity', href: ENTITY_PATH, label: 'Look someone up', icon: ICON_LOOKUP },
    ],
  },
  {
    caption: 'Your account',
    rows: [
      { key: 'connectors', href: SOURCES_PATH, label: 'Connected accounts', icon: ICON_SOURCES },
      { key: 'connect', href: '/connect', label: 'Your assistant', icon: ICON_ASSISTANT },
      { key: 'retractions', href: '/retractions', label: 'What you can undo', icon: ICON_UNDO },
      { key: 'settings', href: SETTINGS_PATH, label: 'Settings', icon: ICON_SETTINGS },
    ],
  },
];

/**
 * The rail, for a signed-in page.
 *
 * **Active is `aria-current="page"` and nothing else** — the accessibility
 * attribute is also the CSS selector, so there is no `class="active"` beside it
 * to drift out of step.
 *
 * **Sign out is a form, never a link.** `GET /api/logout` is not dispatched at
 * all, and a link that changes state is fired by a prefetcher, a link scanner
 * or a chat client unfurling a pasted URL — the rule already written down for
 * disconnect, one page over.
 *
 * **A group caption is a caption, not a row.** The reference makes it a
 * disclosure button; without script, a row that looks like a control and is not
 * is exactly the dead affordance this file forbids.
 */
function sidebar(active: NavKey | 'blank'): string {
  const groups = RAIL_GROUPS.map((group) => {
    const rows = group.rows
      .map(
        (row) =>
          `<li><a href="${escapeHtml(row.href)}"${
            row.key === active ? ' aria-current="page"' : ''
          }>${row.icon}<span>${escapeHtml(row.label)}</span></a></li>`,
      )
      .join('');
    const caption = group.caption === null ? '' : `<p class="grp">${escapeHtml(group.caption)}</p>`;
    return `${caption}<ul>${rows}</ul>`;
  }).join('');
  return `<nav class="rail" aria-label="Pages"><p class="brand">brainz</p>${groups}<form class="acct" method="post" action="/api/logout"><button type="submit">${ICON_SIGNOUT}<span>Sign out</span></button></form></nav>`;
}

/**
 * **The third parameter is a `Page['kind']`, not a string.** `main` is trusted
 * pre-escaped HTML and `title` is escaped; a free-string active key
 * interpolated into an `href` or a class would add a new injection point to the
 * one function every page in this app goes through. A literal from the union
 * cannot carry an angle bracket.
 */
function shell(title: string, main: string, kind: Page['kind']): string {
  const chrome = PAGE_CHROME[kind];
  const head = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`;
  // Byte-identical to what this emitted before the rail existed, so the six
  // chrome-less pages are untouched by the change.
  if (chrome === 'none') {
    return `${head}
<body><main>${main}</main></body></html>`;
  }
  // The skip link is first and is not optional: the rail puts seven links and a
  // button in front of every `<h1>` in the app. `tabindex="-1"` is what makes
  // the fragment MOVE focus rather than merely scroll to it.
  return `${head}
<body class="app"><a class="skip" href="#main">Skip past the menu</a>${sidebar(chrome)}<main id="main" tabindex="-1">${main}</main></body></html>`;
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
        page.kind,
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
        page.kind,
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
        page.kind,
      );

    case 'reset_sent':
      return shell(
        'Check your mail — brainz',
        `<h1>Check your mail</h1>
<p>If that address has an account, a reset link is on its way. It works once and expires in thirty
minutes.</p>
<p class="note">Resetting your password signs out every session on every device — including this one.</p>
<p><a href="/login">Back to sign in</a></p>`,
        page.kind,
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
        page.kind,
      );

    case 'dashboard': {
      // The gate's copy names the actual reason. "Upgrade for more" tells a user
      // nothing they can act on; a monthly per-connection vendor fee is a fact
      // they can weigh.
      //
      // **And the gated render carries no control at all.** Not a disabled one,
      // not a differently-worded one: a form whose route answers 402 or 501 is
      // the dead affordance the whole panel exists to stop being.
      // **The five in-body links are gone, and the rail is why.** They were this
      // page's menu; keeping both would be the same menu rendered twice, three
      // rows apart. The rail emits byte-identical hrefs, which is what keeps the
      // two crawler assertions that name `/retractions` and the coverage path
      // passing.
      //
      // **`<h1>Your dashboard</h1>`, not `brainz`.** The rail's brand already
      // says brainz an inch above, and nine strings in this file call this page
      // "your dashboard" — four of them the argument for keeping Connected
      // accounts here. One destination, one name.
      return shell(
        'Your dashboard — brainz',
        `<h1>Your dashboard</h1>
<p>Plan: <strong>${escapeHtml(page.tier)}</strong> (${escapeHtml(page.status)})${
          page.tenantId === null ? '' : ` &middot; brain <code>${escapeHtml(page.tenantId)}</code>`
        }</p>
<p class="note"><a href="${escapeHtml(SOURCES_PATH)}">Where your mail and files come from &rarr;</a></p>`,
        page.kind,
      );
    }

    /**
     * Account configuration. Three sections that were crowding the dashboard,
     * and one of them repaired on the way.
     */
    case 'connectors': {
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
        'Connected accounts — brainz',
        `<h1>Connected accounts</h1>
<p class="note">Where your mail and files come in from. This is the operational state of ingest —
whether each source is arriving — rather than a setting you change.</p>
${connectors}`,
        page.kind,
      );
    }

    case 'entity':
      return entityPage(page);

    case 'settings': {
      const providers = page.providers
        .map((provider) => `<option value="${escapeHtml(provider)}">${escapeHtml(provider)}</option>`)
        .join('');
      // **This block used to read "Loaded from /api/spend" and never loaded.**
      // The policy carries no `script-src`, so nothing on the page could have
      // fetched it and nothing ever did. `handleSpend` reads `control.tenant`
      // only, so the same figures server-render at no tenant-database cost.
      //
      // The dollar figures come from `spend()` and never from a literal:
      // `test/ai/price-drift.test.ts` refuses a numeric literal on a line whose
      // raw text matches its price context.
      const money =
        page.spend === null
          ? `<p class="note">There is no spend record for this brain yet. That is not the same as having
spent nothing; it means nothing has been counted here.</p>`
          : `<p>Since ${moment(new Date(page.spend.windowStartedAt))} this brain has spent
<strong>${spend(page.spend.spentMicroUsd)}</strong> on model calls.</p>
${
              page.spend.capMicroUsd === null
                ? `<p class="note">No cap is set on this brain, so nothing here stops on spend alone.</p>`
                : `<p class="note">Your cap for this window is ${spend(
                    page.spend.capMicroUsd,
                  )}. When spending reaches it the paid steps stop until the window rolls over. Nothing is
lost while they are stopped; what arrives still arrives, and waits.</p>`
            }
<p class="note">This is what this brain's own model calls cost. It is not your bill and it is not what
you are charged — the two are reconciled where you pay.</p>`;

      return shell(
        'Settings — brainz',
        `<h1>Settings</h1>
<h2>Your own model key</h2>
<p class="note">Inference runs on our keys by default. Bring your own and your calls are still metered for
your own spend cap, but billed to you rather than to us.</p>
<form method="post" action="/api/byok">
  <label for="provider">Provider</label><select id="provider" name="provider">${providers}</select>
  <label for="key">API key</label><input id="key" name="key" type="password" autocomplete="off">
  <button type="submit">Save key</button>
</form>
<h2>Spend</h2>
${money}
<h2>Export</h2>
<p class="note">Scheduled self-export lands with the lifecycle unit; the button is not wired to a store yet
and says so rather than pretending to save.</p>`,
        page.kind,
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
        page.kind,
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
        page.kind,
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
        page.kind,
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
        page.kind,
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
        page.kind,
      );
    }

    case 'connector_notice':
      return shell(
        `${page.heading} — brainz`,
        `<h1>${escapeHtml(page.heading)}</h1>
<p class="problem">${escapeHtml(page.message)}</p>
<p><a href="/dashboard">Back to your dashboard</a></p>`,
        page.kind,
      );

    case 'retraction_notice':
      return shell(
        `${page.heading} — brainz`,
        `<h1>${escapeHtml(page.heading)}</h1>
<p>${escapeHtml(page.message)}</p>
<p><a href="/retractions">Back to what you can undo</a></p>`,
        page.kind,
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
        page.kind,
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
const ALIAS_SOURCE: Readonly<Record<string, string>> = {
  user: 'you told it this',
  inferred: 'it worked this out',
};

/** Edge type codes, as a person would read them. Unknown codes render raw. */
const EDGE_VERB: Readonly<Record<string, string>> = {
  works_at: 'Works at',
  employs: 'people work here',
  part_of: 'Part of',
  has_part: 'things are part of this',
  mentions: 'Mentions',
  mentioned_by: 'things mention this one',
  related_to: 'Related to',
};

function subjectBody(subject: Subject): string {
  const card =
    subject.card === null
      ? `<p class="note">Your brain has not written a summary of this one yet.</p>`
      : `<p class="note">A model wrote this from your own documents, on ${moment(
          new Date(subject.card.writtenAt),
        )}. It was not checked by anyone. &middot; <code>${escapeHtml(
          subject.card.trustLevel,
        )}</code></p>
${quoted(subject.card.summary, subject.card.truncated)}`;

  const aliases =
    subject.aliases.length === 0
      ? `<p class="note">It knows them by one spelling only.</p>`
      : `<ul class="sources">
${subject.aliases
  .map(
    (entry) => `  <li>${quoted(entry.alias, entry.truncated)}
    <p class="note">${escapeHtml(ALIAS_SOURCE[entry.source] ?? entry.source)}</p>
  </li>`,
  )
  .join('\n')}
</ul>${
          subject.aliasesOverflowed
            ? `<p class="note">${escapeHtml(String(subject.aliases.length))} are shown; there are more.</p>`
            : ''
        }`;

  // Outbound names its neighbour; inbound is counted. See the module header for
  // why that split is the licence rather than a taste.
  const outbound =
    subject.outbound.length === 0
      ? `<p class="note">It has not connected this one to anything yet.</p>`
      : `<p>${subject.outbound
          .map(
            (edge) =>
              `${escapeHtml(EDGE_VERB[edge.type] ?? edge.type)} ${quoted(
                edge.otherName,
                edge.otherTruncated,
              )}`,
          )
          .join(' &middot; ')}</p>${
          subject.outboundOverflowed
            ? `<p class="note">${escapeHtml(
                String(subject.outbound.length),
              )} are shown; there are more.</p>`
            : ''
        }`;

  const inbound =
    subject.inbound.length === 0
      ? ''
      : `<p class="note">${subject.inbound
          .map(
            (entry) =>
              `${escapeHtml(String(entry.count))} ${escapeHtml(EDGE_VERB[entry.type] ?? entry.type)}`,
          )
          .join(' &middot; ')}</p>
<p class="note">Things pointing the other way are counted, not listed: showing them by name would
put most of the people your brain knows onto one screen, which is the page this dashboard does not
have.</p>`;

  let mentions: string;
  if (subject.mentions.kind === 'name_too_short') {
    mentions = `<p class="note">That name is too short to count sentences by — a two-letter name
matches most of them.</p>`;
  } else if (subject.mentions.kind === 'name_too_long') {
    mentions = `<p class="note">That name is too long to search by.</p>`;
  } else {
    const census = subject.mentions;
    mentions = `<p>${count(census.total, 'of your live sentences mentions', 'of your live sentences mention')}
this name${
      census.mostRecentAt === null ? '' : ` &middot; most recently ${moment(new Date(census.mostRecentAt))}`
    }</p>
${
      census.byTrust.length === 0
        ? ''
        : `<p class="note">${census.byTrust
            .map((row) => `${escapeHtml(String(row.count))} <code>${escapeHtml(row.level)}</code>`)
            .join(' &middot; ')}</p>`
    }
<p class="note">Your brain files sentences by document, not by person, so this counts the live
sentences whose text contains this name — not everything it knows about them, and, if the name is a
common one, possibly a sentence about somebody else. The sentences themselves are not shown here;
ask your assistant for those.</p>`;
  }

  return `<h1>What your brain holds about this name</h1>
${quoted(subject.name, subject.nameTruncated)}
<p class="note">Filed as ${escapeHtml(subject.type)}. First seen ${moment(
    new Date(subject.firstSeenAt),
  )}. Seen in: ${subject.origins.map((origin) => `<code>${escapeHtml(origin)}</code>`).join(', ')}.</p>
<h2>What your brain wrote about them</h2>
${card}
<h2>Other spellings it knows them by</h2>
${aliases}
<h2>What it says they are connected to</h2>
${outbound}
${inbound}
<h2>How often it comes up</h2>
${mentions}`;
}

/**
 * One named subject — the page built instead of the roster the owner asked for.
 *
 * `src/web/entity.ts`'s header carries the argument. What matters here is that
 * the **steady state renders nothing**: with no name submitted this is a form
 * and a refusal, and there is no branch anywhere that lists who the brain knows.
 */
/**
 * One page of the roster.
 *
 * **Each row is a form, not a link, and that is the one thing left protecting
 * the address book.** A link would carry the subject's name in the query
 * string, into browser history and URL-bar autocomplete — which sync across
 * devices and outlive the session. The page shows names to whoever is looking
 * at it; it does not write them somewhere the owner cannot clear. Paging is a
 * GET because a page number is not a name.
 */
function roster(view: Roster): string {
  if (view.total === 0) {
    return `<p>Your brain does not know about anybody yet.</p>
<p class="note">People and companies appear here once a consolidation cycle has read enough to name
them. <a href="${escapeHtml(PROCESSING_PATH)}">What your brain is working on &rarr;</a></p>`;
  }

  const rows = view.entries
    .map(
      (entry) => `  <li>
    <form method="post" action="/dashboard">
      <input type="hidden" name="view" value="entity">
      <input type="hidden" name="name" value="${escapeHtml(entry.name)}">
      <button type="submit">${escapeHtml(entry.name)}${entry.truncated ? '&hellip;' : ''}</button>
    </form>
    <p class="note">${escapeHtml(entry.type)}${
      entry.hasCard ? ' &middot; has a summary' : ' &middot; no summary yet'
    }</p>
  </li>`,
    )
    .join('\n');

  // Page numbers only: `?page=` carries nothing about anybody.
  const back =
    view.page > 0
      ? `<a href="${escapeHtml(ENTITY_PATH)}&amp;page=${escapeHtml(String(view.page - 1))}">&larr; Previous</a>`
      : '';
  const next =
    view.page < view.pages - 1
      ? `<a href="${escapeHtml(ENTITY_PATH)}&amp;page=${escapeHtml(String(view.page + 1))}">Next &rarr;</a>`
      : '';
  const paging =
    view.pages <= 1
      ? ''
      : `<p class="note">${back}${back !== '' && next !== '' ? ' &middot; ' : ''}${next}${
          back === '' && next === '' ? '' : ' &middot; '
        }page ${escapeHtml(String(view.page + 1))} of ${escapeHtml(String(view.pages))}</p>`;

  return `<p>${count(view.total, 'person or company', 'people and companies')}, in alphabetical order.</p>
<ul class="sources">
${rows}
</ul>
${paging}
<p class="note">This list is names and types only. What your brain actually says about somebody —
its summary, what it connects them to, how often they come up — is on their own page, one click
away.</p>`;
}

function entityPage(page: Extract<Page, { kind: 'entity' }>): string {
  const title = 'Look up a person or company — brainz';
  const back = '<p><a href="/dashboard">Back to your dashboard</a></p>';
  // Not coverage's pledge, and the last clause is the tell: this is the one page
  // in the product that is about somebody.
  const rule = `<p class="note">This page shows what your brain holds about <em>one</em> person or
company — the one you asked for. There is no page here that lists who your brain knows, and there is
not going to be. Everything below was written by a model from your own documents. Unlike the other
pages on this dashboard, this one is about somebody: it is not safe to screenshot.</p>`;

  const form = `<form method="post" action="/dashboard">
  <input type="hidden" name="view" value="entity">
  <label for="name">Their name, as you would say it</label>
  <input id="name" name="name" type="text" autocomplete="off" spellcheck="false">
  <button type="submit">Look them up</button>
</form>`;

  if (!page.available) {
    return shell(
      title,
      `<h1>Look up a person or company</h1>
<p class="problem">This deployment cannot read your brain, so there is nothing to look anything up
in. An empty answer would read as "nothing is known about this person", which is a different
sentence and not the true one here.</p>
${back}`,
      page.kind,
    );
  }

  if (page.lookup === null) {
    return shell(
      title,
      `<h1>Look up a person or company</h1>
<p class="problem">Your brain could not be reached just now. That is most often a database waking up
after a quiet spell — asking again in a few seconds is usually the whole remedy.</p>
${form}
${back}`,
      page.kind,
    );
  }

  const lookup = page.lookup;
  const answer =
    lookup.status === 'browsing'
      ? roster(lookup.roster)
      : lookup.status === 'not_found'
        ? `<p>Nothing in your brain answers to that name.</p>
<p class="note">This looks for an exact match and will not guess. Two things it could mean: your
brain has never seen this person, or it files them under a different spelling — try the name exactly
as it appears in your mail. There are no suggestions here, deliberately.</p>`
        : lookup.status === 'ambiguous'
          ? // No count, no types, no names, and no slug: nothing in the product
            // ever shows an owner a slug, so offering one is a dead affordance.
            `<p>More than one person or company in your brain answers to that name.</p>
<p class="note">Rather than guess which you meant, this page is asking. Try the fuller spelling, or
the name as it is written on their mail.</p>`
          : '';

  if (lookup.status === 'found') {
    return shell(
      title,
      `${subjectBody(lookup.subject)}
${rule}
<h2>Look up another</h2>
${form}
${back}`,
      page.kind,
    );
  }

  return shell(
    title,
    `<h1>Look up a person or company</h1>
${rule}
${form}
${answer}
${back}`,
    page.kind,
  );
}

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
      page.kind,
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
      page.kind,
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
      page.kind,
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
      page.kind,
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
    page.kind,
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
      page.kind,
    );
  }

  if (!page.reachable || page.view === null) {
    return shell(
      title,
      `<h1>What your brain is working on</h1>
<p class="problem">Your brain could not be reached just now. That is most often a database waking up
after a quiet spell — loading this page again in a few seconds is usually the whole remedy.</p>
<p class="note">Nothing has been lost and nothing has stopped: what arrives while this page cannot be
drawn still arrives. Your plan, your connected accounts and everything else on this
dashboard are unaffected.</p>
${back}`,
      page.kind,
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
      page.kind,
    );
  }

  const arriving = `<h2>Arriving</h2>
<p>The most recent document reached this brain ${moment(new Date(view.lastArrivedAt))}.</p>
<p class="note">This is the clock the rest of this page is read against: a step with a large number
waiting under a document that arrived months ago is a different thing from the same number under one
that arrived this morning. <a href="${escapeHtml(COVERAGE_PATH)}">What came from where &rarr;</a>
&middot; <a href="${escapeHtml(SOURCES_PATH)}">Connected accounts &rarr;</a></p>`;

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
    page.kind,
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
      page.kind,
    );
  }

  if (!page.reachable || page.view === null) {
    return shell(
      'What your brain knows — brainz',
      `<h1>What your brain knows</h1>
<p class="problem">Your brain could not be reached just now. That is most often a database waking up
after a quiet spell — loading this page again in a few seconds is usually the whole remedy.</p>
<p class="note">Nothing has been lost and nothing has stopped: what arrives while this page cannot be
drawn still arrives. Your plan, your connected accounts and everything else on this
dashboard are unaffected.</p>
${back}`,
      page.kind,
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

  // **The fence, made visible.** Your brain will not create a person called
  // `Here` because a sentence began with the word, and this is where it says how
  // often that happened. It is on the page rather than in a log for the reason
  // the rest of this page exists: a gate nobody can see is indistinguishable
  // from a brain that quietly stopped knowing things, and the one number that
  // tells them apart is the vocabulary's own hit count. If a rule here is firing
  // on names the reader recognises as real, that is the signal to loosen it.
  const declined =
    view.declinedNames.names === 0
      ? ''
      : `\n<p class="note">${count(
          view.declinedNames.names,
          'name was not made into an entity',
          'names were not made into entities',
        )} because it did not look like one &mdash; ${view.declinedNames.bySignal
          .map(
            (signal) =>
              `${escapeHtml(String(signal.count))} <code>${escapeHtml(signal.signal)}</code>`,
          )
          .join(' &middot; ')} &mdash; across the ${escapeHtml(
          String(view.declinedNames.sampled),
        )} most recent facts.</p>`;

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
${
      view.edgeKinds.length === 0
        ? ''
        : `<p class="note">${view.edgeKinds
            .map((kind) => `${escapeHtml(String(kind.count))} <code>${escapeHtml(kind.kind)}</code>`)
            .join(' &middot; ')}</p>`
    }
<p class="note">${count(
      view.entitiesWithCard,
      'of them has a summary your brain wrote',
      'of them have a summary your brain wrote',
    )}. <a href="${escapeHtml(ENTITY_PATH)}">Look one of them up &rarr;</a></p>
<p class="note">These are what the brain derived from your documents, and they are the numbers to
read next to the document count above: a large pile of documents with very few facts under it means
consolidation is behind, not that there was nothing in them.</p>${types}${declined}${open}`;

  return shell(
    'What your brain knows — brainz',
    `<h1>What your brain knows</h1>
${rule}
<h2>Where it came from</h2>
${sources}
<p class="note">Documents, not passages: counting every passage of a large brain is a scan of the
biggest table it has, and this is a page load. If a source has stopped arriving, the connected
accounts page is where the reason is.</p>
<h2>Consolidation</h2>
${
      view.latestCycle === null ? cold : `<p>${cycleSentence(view.latestCycle, page.tier)}</p>`
    }${freezeNote(view)}${behind}${derived}
<p><a href="${escapeHtml(PROCESSING_PATH)}">What your brain is working on &rarr;</a></p>
${back}`,
    page.kind,
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
