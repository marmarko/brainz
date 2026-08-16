/**
 * Which transport a deployed process actually gets.
 *
 * `compose.ts` composes and does not decide, but *which implementation of a
 * port a process receives* is exactly what it decides — and it had been
 * deciding `createDirectTransport({})` for everything, including the five seats
 * that now have no direct endpoint at all. A `@cf/` model id sent to
 * `PROVIDER_DIRECT_BASES.cloudflare` (which is `null`) is a `TransportError` at
 * first call, per tenant, at consolidation time.
 *
 * Two properties are worth a test rather than a read-through:
 *
 *  1. **Self-host never touches Cloudflare.** KTD13's open-source promise is
 *     that an AGPL operator with no Cloudflare account can run the whole table.
 *     A selector that reached for the unified transport on any path the
 *     self-host profile takes would make that promise nominal, and the failure
 *     would only appear on a machine nobody testing this has.
 *  2. **The account id is configuration.** The repo is public and gitleaks runs
 *     on every push; the id lives in `BRAINZ_CF_ACCOUNT_ID` and a literal
 *     anywhere is the incident. A missing one fails at startup rather than at
 *     the first consolidation cycle of the first tenant.
 */

import { describe, expect, test } from 'bun:test';

import { selectFleetTransport } from '../../src/fleet/compose.ts';
import { FleetConfigError } from '../../src/fleet/env.ts';
import { PROFILES } from '../../src/ai/routing.ts';

/** A fake account id: 32 hex characters, and not anybody's. */
const FAKE_ACCOUNT = 'a'.repeat(32);

const hostedEnv = { BRAINZ_CF_ACCOUNT_ID: FAKE_ACCOUNT } as const;

describe('the hosted profile gets the Unified Billing transport for Cloudflare', () => {
  test('cloudflare resolves to the unified transport', () => {
    const select = selectFleetTransport(hostedEnv, PROFILES.hosted);
    expect(select('cloudflare').id).toBe('cloudflare-unified');
  });

  test('every other provider keeps the direct transport', () => {
    const select = selectFleetTransport(hostedEnv, PROFILES.hosted);
    for (const provider of ['openai', 'google', 'self-host'] as const) {
      expect(select(provider).id).toBe('direct');
    }
  });

  test('a hosted profile with no account id refuses at startup, not at first call', () => {
    // The alternative is a fleet that boots green and fails inside the first
    // paid cycle of the first tenant, which is where this would be found.
    expect(() => selectFleetTransport({}, PROFILES.hosted)).toThrow(FleetConfigError);
  });

  test('the refusal names the variable an operator has to set', () => {
    try {
      selectFleetTransport({}, PROFILES.hosted);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as FleetConfigError).variable).toBe('BRAINZ_CF_ACCOUNT_ID');
    }
  });
});

describe('the self-host profile needs no Cloudflare account at all', () => {
  test('it composes with an empty environment', () => {
    // The open-source promise, as a test: no account id, no Cloudflare key, and
    // the process still builds a working transport for every seat.
    const select = selectFleetTransport({}, PROFILES['self-host']);
    for (const provider of ['openai', 'google', 'self-host'] as const) {
      expect(select(provider).id).toBe('direct');
    }
  });

  test('it routes nothing to cloudflare, so the unified branch is unreachable', () => {
    const providers = new Set(
      Object.values(PROFILES['self-host'].routes).map((route) => route.provider),
    );
    expect(providers.has('cloudflare')).toBe(false);
  });
});
