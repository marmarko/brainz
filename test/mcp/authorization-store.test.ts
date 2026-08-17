/**
 * Which authorization store a fleet composes, and what it refuses.
 *
 * **The case that matters most is the one about a process nobody configured.**
 * A mutation flipping `DEFAULT_AUTHORIZATION_BACKEND` to `memory` would restore
 * the reported incident exactly — a forgotten client, a dead refresh token, a
 * resurrected revocation — and it would survive every other test in this repo,
 * because every one of them names its backend explicitly. So the assertions
 * below are about an *empty environment*, and they read the tell a refusal
 * leaves: which variable it names.
 *
 * These cases are in-process. `openAuthorizationStore` refuses before it touches
 * the database, so the handle below is never dialled.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import {
  AUTHORIZATION_BACKENDS,
  DEFAULT_AUTHORIZATION_BACKEND,
  openAuthorizationStore,
} from '../../src/mcp/authorization-store.ts';
import { FleetConfigError } from '../../src/fleet/env.ts';
import { FAKE_SEALING_KEY } from '../fleet/fixture.ts';

/** Never connected to: every case below refuses before the first query. */
const unusedSql = new SQL('postgres://nobody@127.0.0.1:1/unreachable', { max: 1 });

afterAll(async () => {
  await unusedSql.close().catch(() => undefined);
});

async function refusal(env: Record<string, string>): Promise<FleetConfigError> {
  try {
    await openAuthorizationStore(env, unusedSql);
  } catch (error) {
    if (error instanceof FleetConfigError) return error;
    throw error;
  }
  throw new Error('composed an authorization store where a refusal was required');
}

describe('the deployed default is the durable store', () => {
  test('the constant says so', () => {
    expect(DEFAULT_AUTHORIZATION_BACKEND).toBe('postgres');
  });

  test('an unconfigured process asks for a sealing key, not for a Map', async () => {
    // The tell that the default routed to Postgres: the variable it names. A
    // default of `memory` would COMPOSE here rather than refuse, which is the
    // mutation this case exists to kill — and the one a suite that always names
    // its backend cannot see.
    const error = await refusal({});
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
  });

  test('an unconfigured process does not quietly hand back a working store', async () => {
    // Stated as the property rather than as the error, so a future refactor that
    // changes which variable is named still fails if it starts succeeding.
    expect(openAuthorizationStore({}, unusedSql)).rejects.toBeInstanceOf(FleetConfigError);
  });

  test('choosing the file SECRET backend does not choose an in-memory AUTHORIZATION store', async () => {
    // The two are independent, and coupling them would read as helpful: "this
    // is a self-hoster, give them the Map". It is not helpful. A file-backed
    // deployment still has a control plane — `openControlPlane` requires one —
    // so it can hold its clients, codes, refresh tokens and revocations durably,
    // and the only thing it needs is the key it is being asked for here. The
    // opt-out exists and has to be spoken.
    const error = await refusal({
      BRAINZ_SECRET_BACKEND: 'file',
      BRAINZ_SECRETS_FILE: '/tmp/does-not-matter.json',
    });
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
  });

  test('a missing sealing key is not a reason to fall back to memory', async () => {
    // The subtler version: "no key, so use the in-memory one" reads as helpful
    // and is how a deployment silently keeps forgetting connectors after this
    // change lands.
    const error = await refusal({ BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR: '5' });
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
  });
});

describe('every wrong configuration refuses by name', () => {
  test('an unknown backend names the variable and the backends that exist', async () => {
    const error = await refusal({ BRAINZ_AUTHORIZATION_BACKEND: 'kv' });
    expect(error.variable).toBe('BRAINZ_AUTHORIZATION_BACKEND');
    expect(error.message).toContain('postgres');
    expect(error.message).toContain('memory');
  });

  test('a key of the wrong length is refused rather than stretched into one', async () => {
    const error = await refusal({ BRAINZ_SECRET_ENCRYPTION_KEY: 'AAAA' });
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
    expect(error.message).toContain('32 bytes');
  });

  test('a key of the right length gets past the key check', async () => {
    // The negative cases above prove a refusal; this proves they were refusing
    // the key rather than refusing everything. It goes on to reach the database
    // and fail there, which is a different error entirely.
    expect(
      openAuthorizationStore({ BRAINZ_SECRET_ENCRYPTION_KEY: FAKE_SEALING_KEY }, unusedSql),
    ).rejects.not.toBeInstanceOf(FleetConfigError);
  });
});

describe('the in-memory store is reachable, by name only', () => {
  test('naming it composes one, with no key and no database', async () => {
    // KTD13's self-hoster: one container, one volume, no control plane worth
    // the name. The path has to work, and it has to be asked for.
    const store = await openAuthorizationStore({ BRAINZ_AUTHORIZATION_BACKEND: 'memory' }, unusedSql);
    await store.putClient({
      clientId: 'bzc_selfhoster000000000',
      clientName: 'a self-hosted client',
      redirectUris: ['http://localhost:3000/callback'],
      registeredAt: 0,
    });
    expect((await store.getClient('bzc_selfhoster000000000'))?.clientName).toBe(
      'a self-hosted client',
    );
  });

  test('the backend list is the two this file knows about, and nothing else', () => {
    expect([...AUTHORIZATION_BACKENDS]).toEqual(['postgres', 'memory']);
  });
});
