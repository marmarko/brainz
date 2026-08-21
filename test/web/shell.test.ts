/**
 * The app shell, and the four things it must never get wrong.
 *
 * ============================================================================
 * WHY A RAIL NEEDS TESTS AT ALL
 * ============================================================================
 *
 * A sidebar looks like decoration and is not. It puts seven links and a button
 * in front of every `<h1>` in the app, on every signed-in page, which makes it
 * the single highest-traffic piece of markup in `src/web/` — and four of the
 * ways it can be wrong are silent:
 *
 *   * **A rail on `/brain`.** That page serves an account with no brain, and
 *     every other signed-in render sends such an account straight back to it. A
 *     rail there is seven rows that all `303` to the page you are already on —
 *     and the link crawler in `app.test.ts` would pass it, because a 303 is not
 *     a 404. Only `PAGE_CHROME` can catch this, so it is asserted directly.
 *   * **A rail on a logged-out page.** `/login` renders before a session
 *     exists; a menu there advertises pages the reader cannot reach.
 *   * **A GET that signs you out.** A link would be fired by a prefetcher, a
 *     link scanner, or a chat client unfurling a pasted URL. The rule is
 *     already written down for connector disconnect one page over.
 *   * **A row that says it is the current page when it is not.** The five
 *     POST-outcome notices are outcomes, not destinations, so no row is marked
 *     on them.
 *
 * The fifth is not silent but is worth pinning anyway: the rail replaced five
 * in-body links on the dashboard, and two crawler assertions elsewhere depend
 * on the exact bytes of two of those hrefs.
 */

import { describe, expect, test } from 'bun:test';

import { COVERAGE_PATH, PROCESSING_PATH, REVIEW_PATH, SETTINGS_PATH, renderPage } from '../../src/web/pages.ts';

const RAILED = '<nav class="rail"';

/**
 * Just the rail's markup.
 *
 * Assertions about `aria-current` must be scoped: the attribute also appears
 * twice inside `STYLE`, as the selector that styles the active row, so a
 * document-wide count is off by two before a single row is marked.
 */
function rail(page: string): string {
  const open = page.indexOf(RAILED);
  return open < 0 ? '' : page.slice(open, page.indexOf('</nav>', open));
}

function dashboard(): string {
  return renderPage({
    kind: 'dashboard',
    tier: 'paid',
    status: 'active',
    tenantId: 't-abc',
    connectorsAvailable: true,
    connectors: [],
  });
}

describe('the rail appears on signed-in destinations and nowhere else', () => {
  test('a signed-in page carries the rail and a skip link', () => {
    const page = dashboard();
    expect(page).toContain(RAILED);
    expect(page).toContain('<body class="app">');
    // First focusable thing in the document, before seven links and a button.
    expect(page.indexOf('class="skip"')).toBeLessThan(page.indexOf(RAILED));
    expect(page).toContain('<main id="main" tabindex="-1">');
  });

  test('logged-out pages get no rail and the byte-identical old shell', () => {
    for (const page of [
      renderPage({ kind: 'login' }),
      renderPage({ kind: 'signup', languages: [] }),
    ]) {
      expect(page).not.toContain(RAILED);
      expect(page).toContain('<body><main>');
    }
  });

  test('the brain-setup page gets no rail, because every row would 303 back to it', () => {
    const page = renderPage({ kind: 'brain_setup', languages: [] });
    expect(page).not.toContain(RAILED);
  });

  test('a POST outcome gets the rail but marks no row as current', () => {
    const page = renderPage({
      kind: 'connector_notice',
      heading: 'Something happened',
      message: 'It did.',
    });
    expect(page).toContain(RAILED);
    expect(rail(page)).not.toContain('aria-current');
  });
});

describe('the current row is marked, and only one of them', () => {
  test('the dashboard marks Dashboard', () => {
    const page = dashboard();
    expect(page).toContain('href="/dashboard" aria-current="page"');
    expect((rail(page).match(/aria-current="page"/g) ?? []).length).toBe(1);
  });

  test('each view marks its own row', () => {
    const cases: Array<[string, string]> = [
      [renderPage({ kind: 'coverage', available: false, reachable: false, tier: 'paid', view: null }), COVERAGE_PATH],
      [renderPage({ kind: 'processing', available: false, reachable: false, tier: 'paid', view: null }), PROCESSING_PATH],
      [renderPage({ kind: 'review', available: false, reachable: false, tier: 'paid', view: null }), REVIEW_PATH],
      [renderPage({ kind: 'settings', providers: [], spend: null }), SETTINGS_PATH],
    ];
    for (const [page, path] of cases) {
      expect(page).toContain(`href="${path}" aria-current="page"`);
      expect((rail(page).match(/aria-current="page"/g) ?? []).length).toBe(1);
    }
  });
});

describe('sign out is a form, never a link', () => {
  test('no page carries a logout href', () => {
    const page = dashboard();
    // A GET that changes state is fired by a prefetcher, a link scanner, or a
    // chat client unfurling a pasted URL — and `GET /api/logout` is not even
    // dispatched.
    expect(page).not.toContain('href="/api/logout"');
    expect(page).toContain('<form class="acct" method="post" action="/api/logout">');
  });
});

describe('the rail emits the exact hrefs the crawler and the copy depend on', () => {
  test('it replaces the five deleted in-body links byte for byte', () => {
    const page = dashboard();
    // `app.test.ts` requires these two literals in the `/dashboard` document,
    // and they survived the deletion of the in-body menu only because the rail
    // emits the same bytes. No rail href may ever carry two query parameters:
    // `escapeHtml` would correctly emit `&amp;`, and the crawler fetches the
    // captured string literally.
    expect(page).toContain('href="/retractions"');
    expect(page).toContain('href="/dashboard?view=coverage"');
    expect(page).not.toContain('&amp;');
  });

  test('the dashboard no longer prints its own menu beneath the rail', () => {
    const page = dashboard();
    // The rail IS that menu. Rendering both would be the same seven links twice.
    expect(page).not.toContain('What your brain knows &rarr;');
    expect(page).not.toContain('What you can still undo &rarr;');
  });

  test('one destination, one name', () => {
    const page = dashboard();
    // Nine strings in `pages.ts` call this page "your dashboard", four of them
    // the argument for keeping Connected accounts on it. The row label, the
    // `<h1>` and that copy all have to agree.
    expect(page).toContain('<span>Dashboard</span>');
    expect(page).toContain('<h1>Your dashboard</h1>');
  });
});

describe('settings carries what the dashboard shed, and repairs one of it', () => {
  test('the key form, the spend window and the export note all moved', () => {
    const page = renderPage({
      kind: 'settings',
      providers: ['openai'],
      spend: {
        windowStartedAt: '2026-08-01T00:00:00.000Z',
        spentMicroUsd: 1_240_000,
        capMicroUsd: 10_000_000,
      },
    });
    expect(page).toContain('action="/api/byok"');
    expect(page).toContain('$1.24');
    expect(page).toContain('$10.00');
    // The dead prose is gone: nothing could ever have loaded it under a policy
    // with no script-src.
    expect(page).not.toContain('Loaded from');
  });

  test('no spend record is not the same as having spent nothing', () => {
    const page = renderPage({ kind: 'settings', providers: [], spend: null });
    expect(page).toContain('not the same as having');
    expect(page).not.toContain('$');
  });

  test('a brain with no cap is told so rather than shown a blank', () => {
    const page = renderPage({
      kind: 'settings',
      providers: [],
      spend: { windowStartedAt: '2026-08-01T00:00:00.000Z', spentMicroUsd: 0, capMicroUsd: null },
    });
    expect(page).toContain('No cap is set');
    // `spend()`'s rounding floor: zero reads as a word, not as $0.00, which
    // would read as free on the page whose job is saying what things cost.
    expect(page).toContain('nothing');
  });

  test('connected accounts moved to their own page, and the copy moved with them', () => {
    // The sidebar design had kept this on the dashboard, on the argument that
    // four other sentences named the dashboard as its location. Moving it means
    // moving those too — otherwise the argument's own warning comes true.
    expect(dashboard()).not.toContain('<h2>Connected accounts</h2>');
    expect(dashboard()).toContain('Where your mail and files come from');
    const page = renderPage({ kind: 'connectors', connectorsAvailable: true, connectors: [] });
    expect(page).toContain('<h1>Connected accounts</h1>');
    expect(page).toContain('aria-current="page"');
  });
});
