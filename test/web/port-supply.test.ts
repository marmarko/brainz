/**
 * Every port the web app declares is supplied by the process that serves it.
 *
 * ============================================================================
 * THE DEFECT THIS CLOSES, WHICH THIS REPOSITORY HAS NOW MADE THREE TIMES
 * ============================================================================
 *
 * `src/web/app.ts` fails closed on an absent port: the route answers
 * `501 unavailable` rather than pretending. That is the right shape and it is
 * exactly what made the failure invisible. Twice, a port was declared on
 * `WebAppDeps`, a complete and tested executor sat behind it, and **no
 * composition root supplied one** — so the route answered `501` in every
 * deployment while every test that constructed its own app with its own fake
 * passed:
 *
 *   * `SeverancePort` — `severOrigin` was imported by nothing outside its own
 *     test, so `/api/severance` could not sever;
 *   * `SubjectErasurePort` — `eraseSubject` likewise, so a correspondent could
 *     ask for erasure and the only way to answer was a test harness;
 *   * and `RetractionPort` would have been the third, on the surface that makes
 *     the 72-hour recovery window reachable at all.
 *
 * Both were closed by hand, and `grep -rln "severancePort\\|subjectErasurePort"
 * test/` returned nothing: the defect class had no test. This is that test, and
 * it covers the first two retroactively.
 *
 * ============================================================================
 * WHY A SOURCE SCAN RATHER THAN A BOOT
 * ============================================================================
 *
 * The alternative is to start `startWebApp` against a composed environment and
 * probe the routes. That needs an identity store, a control plane, a secret
 * store and a substrate credential, and it would fail for a dozen reasons that
 * are not this one — which is how a guard becomes a test somebody skips. The
 * property here is structural: a name declared in one file must appear as a
 * supplied key in the other. `test/mcp/guards.test.ts` reads handler sources for
 * the same reason.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const APP = `${import.meta.dir}/../../src/web/app.ts`;
const SERVE = `${import.meta.dir}/../../src/web/serve.ts`;

/**
 * Executable text only. A port named in a docstring is documentation, and a
 * guard that counted it would pass on a comment promising a supply.
 */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The `WebAppDeps` body, so a `Port` field on some other interface is out. */
function webAppDepsBody(): string {
  const source = code(readFileSync(APP, 'utf8'));
  const start = source.indexOf('export interface WebAppDeps {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Optional dependencies whose type is a port — the shape that can go unsupplied. */
function declaredPorts(): string[] {
  return [...webAppDepsBody().matchAll(/readonly\s+(\w+)\?:\s*(\w*Port)\s*;/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('a port declared on WebAppDeps is supplied by the composition root', () => {
  test('the scan finds the ports that exist, so it cannot pass vacuously', () => {
    const ports = declaredPorts();
    // Not an exhaustive list — a new port must not have to be added here — but a
    // floor, so a regex that stopped matching cannot report a clean sheet.
    expect(ports).toContain('severance');
    expect(ports).toContain('subjectErasure');
    expect(ports).toContain('retractions');
    expect(ports.length).toBeGreaterThanOrEqual(3);
  });

  test('every one of them appears as a supplied key in serve.ts', () => {
    const composition = code(readFileSync(SERVE, 'utf8'));
    const missing = declaredPorts().filter(
      // "Supplied" is "appears as an object-literal property", not "appears in
      // the `createWebApp({…})` call": `checkout` is supplied through a spread
      // of a helper that builds `{ checkout: … }`, and a guard that demanded a
      // literal key at the call site would fail on a port that is legitimately
      // environment-conditional.
      (port) => !new RegExp(`(^|[\\s{,(])${port}\\s*:`, 'm').test(composition),
    );
    expect(missing).toEqual([]);
  });

  test('the check can go red — a name nothing supplies is caught', () => {
    // A guard nobody has ever seen fail is a guard that has never run. This is
    // the same assertion above, against a name invented here.
    const composition = code(readFileSync(SERVE, 'utf8'));
    expect(new RegExp(`(^|[\\s{,(])aPortNobodySupplies\\s*:`, 'm').test(composition)).toBe(false);
  });
});
