/**
 * Which secret store a fleet composes, and what it refuses.
 *
 * **The decision under test is a default.** The file backend cannot serve a
 * deployment whose containers share no volume — the web fleet banks a tenant's
 * credentials into its own temporary copy and the MCP fleet answers
 * `invalid_grant` for a brain that exists. So the durable store has to be what a
 * process gets when nobody chose, and the file backend has to be something an
 * operator asks for by name. A default of `file` would put that failure back
 * into production for everyone who did not read a release note, and no
 * end-to-end test catches it if every test names its backend explicitly.
 *
 * **And every wrong configuration must refuse rather than downgrade.** The
 * shape to fear is a fleet that finds no sealing key, quietly falls back to a
 * per-container file, starts green and serves nothing — which is the original
 * incident wearing a fallback's clothes.
 *
 * These cases are in-process: `openSecretStore` refuses before it touches the
 * database, so the handle below is never dialled.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import { DEFAULT_SECRET_BACKEND, openSecretStore } from '../../src/fleet/compose.ts';
import { FleetConfigError } from '../../src/fleet/env.ts';
import { FAKE_SEALING_KEY } from './fixture.ts';

/** Never connected to: every case below refuses before the first query. */
const unusedSql = new SQL('postgres://nobody@127.0.0.1:1/unreachable', { max: 1 });

afterAll(async () => {
  await unusedSql.close().catch(() => undefined);
});

async function refusal(env: Record<string, string>): Promise<FleetConfigError> {
  try {
    await openSecretStore(env, unusedSql);
  } catch (error) {
    if (error instanceof FleetConfigError) return error;
    throw error;
  }
  throw new Error('composed a secret store where a refusal was required');
}

describe('the deployed default is the durable store', () => {
  test('the constant says so', () => {
    expect(DEFAULT_SECRET_BACKEND).toBe('postgres');
  });

  test('an unnamed backend asks for a sealing key, not for a file', async () => {
    // The tell that the default routed to Postgres: the variable it names. A
    // default of `file` would name `BRAINZ_SECRETS_FILE` here instead, which is
    // the mutation this case exists to kill.
    const error = await refusal({});
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
  });

  test('a secrets file present in the environment does not select the file backend', async () => {
    // The subtler version of the same mutation: "fall back to the file when one
    // is configured" reads as helpful and is how a deployment silently keeps
    // using a per-container store after this change lands.
    const error = await refusal({ BRAINZ_SECRETS_FILE: '/tmp/does-not-matter.json' });
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
  });
});

describe('every wrong configuration refuses by name', () => {
  test('an unknown backend names the variable and the backends that exist', async () => {
    const error = await refusal({ BRAINZ_SECRET_BACKEND: 'kv' });
    expect(error.variable).toBe('BRAINZ_SECRET_BACKEND');
    expect(error.message).toContain('postgres');
    expect(error.message).toContain('file');
  });

  test('the file backend still requires its path', async () => {
    const error = await refusal({ BRAINZ_SECRET_BACKEND: 'file' });
    expect(error.variable).toBe('BRAINZ_SECRETS_FILE');
  });

  test('a key of the wrong length is refused rather than stretched into one', async () => {
    // Not hashed into shape: a truncated paste would become a *different working
    // key*, and every tenant sealed under the old one would be unopenable with
    // no error anyone could read.
    const error = await refusal({ BRAINZ_SECRET_ENCRYPTION_KEY: 'AAAA' });
    expect(error.variable).toBe('BRAINZ_SECRET_ENCRYPTION_KEY');
    expect(error.message).toContain('32 bytes');
  });

  test('a key of the right length gets past the key check', async () => {
    // The negative cases above prove a refusal; this proves they were refusing
    // the key rather than refusing everything. It goes on to reach the database
    // and fail there, which is a different error entirely.
    expect(openSecretStore({ BRAINZ_SECRET_ENCRYPTION_KEY: FAKE_SEALING_KEY }, unusedSql)).rejects
      .not.toBeInstanceOf(FleetConfigError);
  });
});
