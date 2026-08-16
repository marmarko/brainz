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

export type Page =
  | { readonly kind: 'login' }
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

export function renderPage(page: Page): string {
  switch (page.kind) {
    case 'login':
      return shell(
        'Sign in — brainz',
        `<h1>brainz</h1>
<p class="note">Your brain, wherever your assistant is.</p>
<form method="post" action="/api/login">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
<p class="note"><a href="/password/reset">Forgotten your password?</a> &middot; <a href="/signup">Create an account</a></p>`,
      );

    case 'signup': {
      // KTD9's choice, made by the person it is about. The API refuses a signup
      // without it rather than defaulting to English, so a page with no field
      // for it would make the product unusable through its own front door.
      const options = page.languages
        .map(
          (language) =>
            `<option value="${escapeHtml(language.value)}">${escapeHtml(language.label)}</option>`,
        )
        .join('');
      return shell(
        'Create an account — brainz',
        `<h1>Create your brain</h1>
<form method="post" action="/api/signup">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>
  <p class="note">Twelve characters or more. A phrase is easier to remember and harder to guess than a
  short password with punctuation in it.</p>
  <label for="fts_language">What language is most of your mail and your notes in?</label>
  <select id="fts_language" name="fts_language" required>${options}</select>
  <p class="note">This decides how your brain indexes words, and it is set once when the brain is built.
  We do not guess it, because guessing wrong is invisible — everything would still work, and search
  would quietly be worse forever.</p>
  <button type="submit">Create account</button>
</form>
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
