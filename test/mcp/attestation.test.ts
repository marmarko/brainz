/**
 * U16 — the receipt, and the key that must not be the fleet's to read.
 *
 * **Three of these tests are trivially passable, and each is written against
 * that.** They are the reason the file is long:
 *
 *   1. *"No fleet container can export the key"* is an **absence** property, and
 *      an absence property passes when nothing tries. So {@link attemptExport}
 *      genuinely walks every value reachable from the objects a handler is
 *      handed — `DispatchDeps`, `ToolContext`, the signer itself — invoking
 *      every zero-argument method it finds, and collecting anything that
 *      contains the key. Its **negative control** is the load-bearing test: a
 *      deliberately leaky signer must be caught, or the walker proves nothing.
 *   2. *"The attestation verifies"* passes trivially if the verifier accepts
 *      anything. So the suite verifies a signature against a **different
 *      payload** and requires `false`, field by field, over every field in the
 *      body.
 *   3. *"The signing key is not in the secret store"* passes trivially if the
 *      test reads the same type it is asserting about. So the shape of what
 *      `resolve` actually returns is read off a real store with a real entry.
 *
 * The residual is stated here rather than left for a reader to infer: this
 * proves the *code* offers no export path. A deployed fleet denied a real KMS
 * key is an IAM property, and no test in this repository can assert it.
 */

import { describe, expect, test } from 'bun:test';

import { controlPlaneIdentity, fleetIdentity, createInMemorySecretBackend, createTenantSecretStore } from '../../src/control/secrets.ts';
import {
  ATTESTATION_DOMAIN,
  attestationPayload,
  boundaryFromConnectionString,
  canonicalAttestationBytes,
  createInProcessSigner,
  isSigned,
  sealAttestation,
  verifyAttestation,
  type AttestationPayload,
  type AttestationSignature,
  type AttestationSigner,
  type SignedAttestation,
  type TenantBoundaryFacts,
} from '../../src/mcp/attestation.ts';
import { createMcpFixture } from './fixture.ts';

const KEY = 'a-signing-key-no-fleet-container-may-export';
const KEY_ID = 'attestation-2026-08';

const FACTS: TenantBoundaryFacts = {
  projectId: null,
  projectIdSource: 'unresolved',
  endpointHost: 'ep-probe-000000.eu-central-1.aws.neon.tech',
  databaseName: 'brainz_tenant',
  storagePrefix: 't-probe/',
  storagePrefixSource: 'derived',
};

function payloadFor(overrides: Partial<TenantBoundaryFacts> = {}): AttestationPayload {
  return attestationPayload({
    tenantId: 't-probe',
    issuedAt: new Date('2026-08-13T09:00:00.000Z'),
    boundary: { ...FACTS, ...overrides },
    definitionsDigest: 'deadbeef',
    instructionsRelease: '2026-08-01',
  });
}

/**
 * Every string reachable from `root` that contains `secret`.
 *
 * Follows own and inherited enumerable properties, indexes arrays and Maps, and
 * **calls every zero-argument function it meets** — because "the key is not a
 * property" and "the key cannot be obtained" are different claims, and an
 * accessor that returns it is exactly how the second fails while the first
 * holds. Depth- and visit-bounded so a cyclic object graph terminates.
 */
function attemptExport(root: unknown, secret: string): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const queue: { value: unknown; path: string; depth: number }[] = [
    { value: root, path: '<root>', depth: 0 },
  ];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) continue;
    const { value, path, depth } = item;
    if (depth > 6 || value === null || value === undefined) continue;

    if (typeof value === 'string') {
      if (value.includes(secret)) found.push(path);
      continue;
    }

    if (typeof value === 'function') {
      // Only nullary functions: anything needing arguments is not an export
      // path a handler could stumble into, and calling it with guesses would
      // make this walker a fuzzer rather than an assertion.
      if (value.length === 0) {
        try {
          const returned = (value as () => unknown).call(root);
          queue.push({ value: returned, path: `${path}()`, depth: depth + 1 });
        } catch {
          // A method that throws without its receiver has exported nothing.
        }
      }
      // Fall through: a function is also an object and can carry properties.
    }

    if (typeof value !== 'object' && typeof value !== 'function') continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (value instanceof Map) {
      for (const [k, v] of value) {
        queue.push({ value: v, path: `${path}.get(${String(k)})`, depth: depth + 1 });
      }
    }

    // `for…in` rather than `Object.keys`, so a value parked on a prototype is
    // not a hiding place this walker politely declines to look in.
    for (const key in value as Record<string, unknown>) {
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      queue.push({ value: child, path: `${path}.${key}`, depth: depth + 1 });
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      queue.push({ value: child, path: `${path}.${key}`, depth: depth + 1 });
    }
  }

  return found;
}

describe('the walker finds a key when there is one to find', () => {
  test('a leaky signer is caught — the negative control this whole file rests on', () => {
    // Without this, every "no key was found" assertion below is satisfied by a
    // walker that looks in the wrong place, or does not look at all.
    const leaky = {
      ...createInProcessSigner({ key: KEY, keyId: KEY_ID }),
      exportKey: () => KEY,
    };
    expect(attemptExport(leaky, KEY).length).toBeGreaterThan(0);
  });

  test('a key parked on a prototype is caught too', () => {
    const hidden = Object.create({ inheritedKey: KEY }) as Record<string, unknown>;
    hidden['harmless'] = 'nothing here';
    expect(attemptExport(hidden, KEY).length).toBeGreaterThan(0);
  });

  test('a key behind a nullary accessor is caught', () => {
    expect(attemptExport({ material: () => ({ nested: KEY }) }, KEY).length).toBeGreaterThan(0);
  });
});

describe('the signing key is outside the fleet’s readable scope', () => {
  test('the signer itself exports nothing, through any accessor a caller has', () => {
    const signer = createInProcessSigner({ key: KEY, keyId: KEY_ID });
    expect(attemptExport(signer, KEY)).toEqual([]);
  });

  test('the published verification key is not the signing key', () => {
    const signer = createInProcessSigner({ key: KEY, keyId: KEY_ID });
    const published = signer.verificationKey();
    // An HMAC key IS its own verification key, so a signer that published it
    // would hand every reader the ability to forge. The digest identifies the
    // key without being it.
    expect(published.published).not.toContain(KEY);
    expect(published.published).toStartWith('sha256:');
    expect(published.key_id).toBe(KEY_ID);
  });

  test('the store the request path can read holds no attestation key', async () => {
    // Read off a real store with a real entry rather than off the type: the
    // claim is about what a fleet identity can obtain, and a type is not that.
    const secrets = createTenantSecretStore({ backend: createInMemorySecretBackend() });
    await secrets.put(controlPlaneIdentity(), 't-probe', {
      connectionString: 'postgres://u:p@ep-probe-000000.eu-central-1.aws.neon.tech/brainz_tenant',
      bearerGrant: 'bearer-value',
    });

    const resolved = await secrets.resolve(fleetIdentity('t-probe'), 't-probe');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('unreachable');

    // Exactly two fields. Adding the signing key beside them is the default this
    // design exists to refuse, and this is what makes doing it a red test.
    expect(Object.keys(resolved.secret).sort()).toEqual(['bearerGrant', 'connectionString']);
    expect(attemptExport(resolved.secret, KEY)).toEqual([]);
  });

  test('nothing a handler is handed reaches the key, on a live dispatch', async () => {
    const signer = createInProcessSigner({ key: KEY, keyId: KEY_ID });
    const fixture = await createMcpFixture('attestkey', { signer });
    try {
      const result = await fixture.call('brain');
      expect(result.ok).toBe(true);

      // The two objects the request path assembles and hands down. If the key
      // were reachable from either, a handler parsing attacker-controlled mail
      // could mint a receipt for a brain whose isolation had already failed.
      expect(attemptExport(fixture.deps, KEY)).toEqual([]);
      expect(attemptExport(result, KEY)).toEqual([]);

      // And it is not in what goes on the wire.
      expect(JSON.stringify(result).includes(KEY)).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});

describe('the signature is over this payload and no other', () => {
  const signer = createInProcessSigner({ key: KEY, keyId: KEY_ID });

  test('a well-formed receipt verifies', async () => {
    const sealed = await sealAttestation(payloadFor(), signer);
    expect(isSigned(sealed.signature)).toBe(true);
    expect(await verifyAttestation(sealed, signer)).toBe(true);
  });

  test('a signature over a different payload is rejected — every field', async () => {
    const genuine = await signer.sign(payloadFor());

    // Field by field, because a verifier that folded only `tenant_id` into the
    // signed bytes would pass a single-field check and still let a receipt for
    // one boundary be presented for another.
    const forgeries: SignedAttestation[] = [
      { ...payloadFor(), tenant_id: 't-someone-else', signature: genuine },
      { ...payloadFor(), issued_at: '2020-01-01T00:00:00.000Z', signature: genuine },
      {
        ...payloadFor(),
        project: { ...payloadFor().project, endpoint_host: 'ep-other.neon.tech' },
        signature: genuine,
      },
      {
        ...payloadFor(),
        project: { ...payloadFor().project, id: 'invented-project', id_source: 'control_plane' },
        signature: genuine,
      },
      { ...payloadFor(), database: { name: 'someone_elses_db' }, signature: genuine },
      {
        ...payloadFor(),
        storage: { prefix: 't-someone-else/', prefix_source: 'derived' },
        signature: genuine,
      },
      { ...payloadFor(), definitions_digest: 'f00dface', signature: genuine },
      { ...payloadFor(), instructions_release: '1999-01-01', signature: genuine },
    ];

    for (const forged of forgeries) {
      expect({ forged: forged.tenant_id, verified: await verifyAttestation(forged, signer) }).toEqual(
        { forged: forged.tenant_id, verified: false },
      );
    }

    // And the honest one still verifies, so the loop above is not passing
    // because the verifier says `false` to everything.
    expect(await verifyAttestation({ ...payloadFor(), signature: genuine }, signer)).toBe(true);
  });

  test('a signature from a different key is rejected', async () => {
    const sealed = await sealAttestation(payloadFor(), signer);
    const other = createInProcessSigner({ key: 'a-different-key-entirely', keyId: KEY_ID });
    expect(await verifyAttestation(sealed, other)).toBe(false);
  });

  test('a mangled signature value is rejected rather than throwing', async () => {
    const sealed = await sealAttestation(payloadFor(), signer);
    const mangled: AttestationSignature = { alg: 'HMAC-SHA256', key_id: KEY_ID, value: 'not-hex' };
    expect(await verifyAttestation({ ...payloadFor(), signature: mangled }, signer)).toBe(false);
    expect(await verifyAttestation({ ...sealed, signature: { ...sealed.signature as AttestationSignature, value: '' } }, signer)).toBe(false);
  });

  test('the signed bytes are domain-separated, so this signer signs nothing else', () => {
    expect(canonicalAttestationBytes(payloadFor())).toContain(ATTESTATION_DOMAIN);
  });

  test('an empty key is refused rather than signing worthlessly', () => {
    expect(() => createInProcessSigner({ key: '', keyId: KEY_ID })).toThrow(/empty key/);
  });
});

describe('an absent signer is a named absence, never a self-signed receipt', () => {
  test('no signer means unsigned, with a reason', async () => {
    const sealed = await sealAttestation(payloadFor(), undefined);
    expect(isSigned(sealed.signature)).toBe(false);
    expect(await verifyAttestation(sealed, createInProcessSigner({ key: KEY, keyId: KEY_ID }))).toBe(
      false,
    );
    if (isSigned(sealed.signature)) throw new Error('unreachable');
    expect(sealed.signature.reason).toContain('claim rather than a proof');
  });

  test('a signer that throws degrades to unsigned rather than to a forged value', async () => {
    const broken: AttestationSigner = {
      sign: () => Promise.reject(new Error('kms unreachable')),
      verify: () => Promise.resolve(false),
      verificationKey: () => ({ alg: 'none', key_id: 'none', published: 'none' }),
    };
    const sealed = await sealAttestation(payloadFor(), broken);
    expect(isSigned(sealed.signature)).toBe(false);
  });
});

describe('what the payload may claim is what was verified', () => {
  test('the two boundaries carry their own strengths', () => {
    const payload = payloadFor();
    expect(payload.boundaries.database).toBe('structural');
    // R9's condition rides in the value, not in a footnote a renderer can drop.
    expect(payload.boundaries.storage).toBe('structural_conditional_on_prefix_derivation');
  });

  test('an unresolvable project id is absent, never guessed from the host', () => {
    const payload = payloadFor();
    expect(payload.project.id).toBeNull();
    expect(payload.project.id_source).toBe('unresolved');
    // The specific temptation: a Neon endpoint host and a project id look alike.
    expect(payload.project.endpoint_host).toContain('ep-');
  });

  test('a connection string yields a host and a database and no credential', () => {
    const parsed = boundaryFromConnectionString(
      'postgres://tenant_role:sup3rs3cret@ep-probe-000000.eu-central-1.aws.neon.tech/brainz_tenant?sslmode=require',
    );
    expect(parsed.endpointHost).toBe('ep-probe-000000.eu-central-1.aws.neon.tech');
    expect(parsed.databaseName).toBe('brainz_tenant');
    expect(JSON.stringify(parsed)).not.toContain('sup3rs3cret');
    expect(JSON.stringify(parsed)).not.toContain('tenant_role');
  });

  test('an unparseable connection string is unknown, not a throw', () => {
    // A malformed DSN is operational. Turning it into an exception would let an
    // attestation field fail a tool call.
    expect(boundaryFromConnectionString('not a url')).toEqual({
      endpointHost: 'unknown',
      databaseName: 'unknown',
    });
  });
});

describe('the receipt rides every response, and `brain` renders the same one', () => {
  test('every response carries the stamp, and brain returns counts beside it', async () => {
    const signer = createInProcessSigner({ key: KEY, keyId: KEY_ID });
    const fixture = await createMcpFixture('attestwire', { signer });
    try {
      const brain = await fixture.call('brain');
      expect(brain.ok).toBe(true);

      const stamped = brain.meta['brainz.app/brain'] as SignedAttestation;
      expect(stamped.tenant_id).toBe(fixture.tenantId);
      expect(await verifyAttestation(stamped, signer)).toBe(true);

      const content = brain.content as {
        counts: Record<string, number>;
        attestation: SignedAttestation;
      };
      // Counts, which the roadmap asks `brain` for and which are deliberately
      // NOT inside the signed body — a signature over a value that changes on
      // every write is one nobody can compare between two responses.
      expect(Object.keys(content.counts).length).toBeGreaterThan(0);
      expect(content.attestation).toEqual(stamped);

      // A read, so the stamp is a property of the connection rather than
      // something a caller has to remember to ask for.
      const recalled = await fixture.call('recall', { query: 'anything' });
      const onRead = recalled.meta['brainz.app/brain'] as SignedAttestation;
      expect(await verifyAttestation(onRead, signer)).toBe(true);
      expect(onRead.database.name).toBe(stamped.database.name);
    } finally {
      await fixture.close();
    }
  });

  test('a fleet with no signer stamps an unsigned receipt rather than none', async () => {
    const fixture = await createMcpFixture('attestnosig');
    try {
      const brain = await fixture.call('brain');
      const stamped = brain.meta['brainz.app/brain'] as SignedAttestation;
      expect(stamped.tenant_id).toBe(fixture.tenantId);
      expect(isSigned(stamped.signature)).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  test('the stamped host and database are the tenant’s own, and carry no secret', async () => {
    const signer = createInProcessSigner({ key: KEY, keyId: KEY_ID });
    const fixture = await createMcpFixture('attestfacts', { signer });
    try {
      const brain = await fixture.call('brain');
      const stamped = brain.meta['brainz.app/brain'] as SignedAttestation;
      const dsn = new URL(fixture.schema.dsn);
      expect(stamped.database.name).toBe(dsn.pathname.replace(/^\/+/, ''));
      expect(stamped.project.endpoint_host).toBe(dsn.hostname);
      expect(JSON.stringify(stamped)).not.toContain(fixture.bearer);
    } finally {
      await fixture.close();
    }
  });
});
