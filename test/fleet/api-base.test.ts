/**
 * `apiBase` — the second URL shape a fleet process reads, and why it is not
 * `origin`.
 *
 * `origin` guards a value that gets **published**: an OAuth issuer a connector
 * binds to, where a stray path segment surfaces days later at somebody else's
 * token endpoint as a mismatch. A vendor API base is the opposite — consumed,
 * never published, and the real ones carry a version path (`…/api/v2`). Loosening
 * `origin` to accept a path would have weakened the check on the value that
 * needs it; refusing a path here would have made the shipped Neon base
 * unexpressible and pushed every operator pointing at a proxy or a local double
 * out of validation entirely.
 *
 * So the two exist side by side, and this file is the reason that is a decision
 * rather than a duplicate: it asserts the pair of properties `origin` does not
 * have (a path survives, a trailing slash is normalised) alongside the ones it
 * shares (absent refuses, a non-URL refuses, a non-HTTP scheme refuses).
 */

import { describe, expect, test } from 'bun:test';

import { apiBase, FleetConfigError } from '../../src/fleet/env.ts';

const NAME = 'BRAINZ_NEON_API_BASE';

function read(value: string | undefined): string {
  return apiBase(value === undefined ? {} : { [NAME]: value }, NAME);
}

describe('a vendor API base is an origin plus a path', () => {
  test('keeps the version path, which is the whole reason this is not `origin`', () => {
    expect(read('https://console.neon.tech/api/v2')).toBe('https://console.neon.tech/api/v2');
  });

  test('accepts a bare origin, which is what a local double is', () => {
    expect(read('http://127.0.0.1:8123')).toBe('http://127.0.0.1:8123');
  });

  test('strips one trailing slash rather than refusing it', () => {
    // Every call site appends a rooted path, so the alternative is `…/v2//projects`
    // — a 404 an operator cannot see by reading their own configuration.
    expect(read('https://console.neon.tech/api/v2/')).toBe('https://console.neon.tech/api/v2');
    expect(read('http://127.0.0.1:8123/')).toBe('http://127.0.0.1:8123');
  });
});

describe('and it refuses the shapes that would build a URL nobody asked for', () => {
  test('absent and empty are the same refusal, and it names the variable', () => {
    for (const value of [undefined, '', '   ']) {
      expect(() => read(value)).toThrow(FleetConfigError);
      expect(() => read(value)).toThrow(NAME);
    }
  });

  test('a relative path is not an API base', () => {
    expect(() => read('console.neon.tech/api/v2')).toThrow('absolute URL');
  });

  test('a non-HTTP scheme is not an API base', () => {
    expect(() => read('ftp://console.neon.tech/api/v2')).toThrow('http or https');
  });

  test('a query string or a fragment cannot survive concatenation, so it refuses', () => {
    expect(() => read('https://console.neon.tech/api/v2?key=leaked')).toThrow('query string');
    expect(() => read('https://console.neon.tech/api/v2#frag')).toThrow('fragment');
  });
});
