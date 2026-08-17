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
      readonly sources: readonly string[];
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
      const sources = page.sources
        .map((source) => `<li>${escapeHtml(source)}</li>`)
        .join('');
      const providers = page.providers
        .map((provider) => `<option value="${escapeHtml(provider)}">${escapeHtml(provider)}</option>`)
        .join('');
      // The gate's copy names the actual reason. "Upgrade for more" tells a user
      // nothing they can act on; a monthly per-connection vendor fee is a fact
      // they can weigh.
      const connectors = page.connectorsAvailable
        ? `<ul>${sources}</ul>
<p class="note">Connecting opens a consent screen at the connector vendor. The link it gives you is a
capability — anyone who has it can attach their account to this brain — so it expires in ten minutes
and works once.</p>`
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
  }
}
