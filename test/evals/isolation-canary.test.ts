/**
 * The canary, and the one way it could pass while meaning nothing.
 *
 * **`deferred` counted as `pass` is the whole failure mode.** Every check here
 * needs something a `bun test` run does not have — a deployed endpoint, a
 * tenant database, a published verification key — so the tempting shape is a
 * suite that reports green because nothing ran. The rule this file pins:
 * `ok` requires `fail === 0` **and** `pass > 0`, and a bare invocation with no
 * endpoint is not a pass.
 *
 * The probe halves are driven through injected `call` and `query`, so the
 * *logic* — what counts as a pass, what counts as an over-claim, what a missing
 * marker means — is exercised without a network and without a deployment. What
 * stays deferred in the real world is the deployment itself, and the report says
 * so in its own words rather than in a comment here.
 */

import { describe, expect, test } from 'bun:test';

import {
  CANARY_CHECKS,
  CANARY_KNOWN_RECORD,
  renderReport,
  runCanary,
  type CanaryOptions,
} from '../../evals/isolation-canary.ts';
import {
  attestationPayload,
  createInProcessSigner,
  sealAttestation,
  type SignedAttestation,
} from '../../src/mcp/attestation.ts';
import { EMBEDDING_SEATS } from '../../src/schema/embedding-seat.ts';

const SIGNER = createInProcessSigner({ key: 'canary-probe-key', keyId: 'canary-2026-08' });

async function receiptFor(
  overrides: Partial<SignedAttestation> = {},
): Promise<SignedAttestation> {
  const sealed = await sealAttestation(
    attestationPayload({
      tenantId: 't-canary',
      issuedAt: new Date('2026-08-13T09:00:00.000Z'),
      boundary: {
        projectId: null,
        projectIdSource: 'unresolved',
        endpointHost: 'ep-canary-000000.eu-central-1.aws.neon.tech',
        databaseName: 'brainz_tenant',
        storagePrefix: 't-canary/',
        storagePrefixSource: 'derived',
      },
      definitionsDigest: 'digest-abc',
      instructionsRelease: '2026-08-01',
    }),
    SIGNER,
  );
  return { ...sealed, ...overrides };
}

/** A deployment that answers correctly. Everything else is a mutation of it. */
async function healthyCall(
  receipt: SignedAttestation,
  marker: string = CANARY_KNOWN_RECORD.marker,
): Promise<NonNullable<CanaryOptions['call']>> {
  return (_endpoint, _token, tool) => {
    if (tool === 'brain') {
      return Promise.resolve({
        content: { definitions_digest: receipt.definitions_digest },
        meta: { 'brainz.app/brain': receipt },
      });
    }
    return Promise.resolve({ content: { records: [{ body: marker }] }, meta: {} });
  };
}

const HEALTHY_CONTROL: NonNullable<CanaryOptions['controlQuery']> = () =>
  Promise.resolve([{ wedged: 0, total: 3 }]);

const HEALTHY_DB: NonNullable<CanaryOptions['query']> = (sql) => {
  if (sql.includes('pg_extension')) return Promise.resolve([{ extname: 'vector' }]);
  if (sql.includes('pg_settings')) return Promise.resolve([{ setting: '40', boot_val: '40' }]);
  if (sql.includes("amname = 'hnsw'")) {
    return Promise.resolve([
      // One row per registered embedding seat per embedding-bearing table,
      // because that is what a healthy tenant reports: the seat registry
      // (`src/schema/embedding-seat.ts`) is what decides how many vector
      // columns exist, and rung 13 gave every one of them its own index.
      // Derived rather than listed so a third seat cannot make this fixture a
      // description of a deployment nobody runs — the check it feeds compares
      // against the same registry, and a hardcoded list would quietly become
      // the reason it passes.
      ...EMBEDDING_SEATS.flatMap((seat) => [
        { table_name: 'chunk', column_name: seat.column },
        { table_name: 'fact', column_name: seat.column },
      ]),
      { table_name: 'entity', column_name: 'embedding' },
      { table_name: 'entity_card', column_name: 'embedding' },
    ]);
  }
  // The search-path guard's two catalog reads.
  if (sql.includes('prorettype')) {
    return Promise.resolve([{ function_name: 'refuse_origin_change_pinned', pinned: true }]);
  }
  return Promise.resolve([]);
};

describe('nothing graded is not a pass', () => {
  test('a bare invocation defers everything and is not ok', async () => {
    const report = await runCanary();
    expect(report.counts.pass).toBe(0);
    expect(report.counts.fail).toBe(0);
    expect(report.counts.deferred).toBe(CANARY_CHECKS.length);
    // The assertion this whole file exists for. Zero failures is not success
    // when zero checks ran.
    expect(report.ok).toBe(false);
  });

  test('the report says so in words, not only in an exit code', async () => {
    const rendered = renderReport(await runCanary());
    expect(rendered).toContain('Nothing was graded');
    expect(rendered).toContain('defer');
  });

  test('every deferral names what it needed', async () => {
    for (const result of (await runCanary()).results) {
      expect({ id: result.id, outcome: result.outcome }).toEqual({
        id: result.id,
        outcome: 'deferred',
      });
      expect(result.detail.length).toBeGreaterThan(30);
    }
  });

  test('every declared check has an id, an assertion and a reason to exist', () => {
    expect(CANARY_CHECKS.length).toBeGreaterThan(6);
    for (const check of CANARY_CHECKS) {
      expect(check.id).toMatch(/^[a-z_.]+$/);
      expect(check.asserts.length).toBeGreaterThan(20);
      expect(check.why.length).toBeGreaterThan(60);
    }
    expect(new Set(CANARY_CHECKS.map((check) => check.id)).size).toBe(CANARY_CHECKS.length);
  });
});

describe('a healthy deployment passes, and the pass is earned', () => {
  test('the read half grades and is ok', async () => {
    const receipt = await receiptFor();
    const report = await runCanary({
      endpoint: 'https://canary.example/mcp',
      token: 'a-caller-supplied-bearer',
      tenantId: 't-canary',
      call: await healthyCall(receipt),
    });

    expect(report.counts.fail).toBe(0);
    expect(report.counts.pass).toBeGreaterThan(4);
    expect(report.ok).toBe(true);
    // The database half stays deferred without a database, and does not become
    // a pass by being skipped.
    expect(report.results.filter((r) => r.outcome === 'deferred').map((r) => r.id)).toContain(
      'path.extensions',
    );
  });

  test('both halves grade when a database is supplied', async () => {
    const receipt = await receiptFor();
    const report = await runCanary({
      endpoint: 'https://canary.example/mcp',
      token: 'a-caller-supplied-bearer',
      tenantId: 't-canary',
      call: await healthyCall(receipt),
      query: HEALTHY_DB,
      controlQuery: HEALTHY_CONTROL,
    });
    expect(report.counts.fail).toBe(0);
    expect(report.counts.deferred).toBe(1); // only the unpublished verification key
    expect(report.ok).toBe(true);
  });
});

describe('each check fails for its own reason', () => {
  const probe = async (
    options: Omit<CanaryOptions, 'endpoint' | 'token'>,
  ): Promise<Map<string, string>> => {
    const report = await runCanary({
      endpoint: 'https://canary.example/mcp',
      token: 'a-caller-supplied-bearer',
      tenantId: 't-canary',
      ...options,
    });
    return new Map(report.results.map((result) => [result.id, result.outcome]));
  };

  test('a missing stamp fails, and takes the claims that depend on it with it', async () => {
    const outcomes = await probe({
      call: () => Promise.resolve({ content: {}, meta: {} }),
    });
    expect(outcomes.get('attestation.present')).toBe('fail');
    expect(outcomes.get('boundary.database')).toBe('fail');
  });

  test('a receipt naming another tenant fails', async () => {
    const receipt = await receiptFor({ tenant_id: 't-somebody-else' });
    const outcomes = await probe({ call: await healthyCall(receipt) });
    expect(outcomes.get('attestation.tenant')).toBe('fail');
  });

  test('an OVER-claimed storage boundary fails — the under-claim is the honest one', async () => {
    // R9 measured the object store matching prefixes literally. A deploy that
    // began reporting plain `structural` would be a receipt that keeps
    // verifying after the property stops holding, so this direction is the one
    // that must be caught.
    const receipt = await receiptFor({
      boundaries: { database: 'structural', storage: 'structural' as never },
    });
    const outcomes = await probe({ call: await healthyCall(receipt) });
    expect(outcomes.get('boundary.storage.not_overclaimed')).toBe('fail');
  });

  test('a missing known record fails rather than passing on an empty answer', async () => {
    const receipt = await receiptFor();
    const outcomes = await probe({ call: await healthyCall(receipt, 'some other content') });
    expect(outcomes.get('known_record.readable')).toBe('fail');
  });

  test('a definitions digest that disagrees with the receipt fails', async () => {
    const receipt = await receiptFor();
    const outcomes = await probe({
      call: (_e, _t, tool) =>
        tool === 'brain'
          ? Promise.resolve({
              content: { definitions_digest: 'a-different-digest' },
              meta: { 'brainz.app/brain': receipt },
            })
          : Promise.resolve({ content: { body: CANARY_KNOWN_RECORD.marker }, meta: {} }),
    });
    expect(outcomes.get('definitions.digest')).toBe('fail');
  });

  test('an unreachable endpoint fails rather than throwing out of the run', async () => {
    const outcomes = await probe({ call: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect(outcomes.get('attestation.present')).toBe('fail');
    expect(outcomes.get('known_record.readable')).toBe('fail');
  });

  test('an unregistered hnsw.ef_search fails — H1, and it is registration that matters', async () => {
    // Not "the default is 40": brainz raises it per scan with SET LOCAL, so the
    // default is expected to be 40 and checking it would measure the wrong
    // thing. What can silently be wrong is whether the setting exists at all —
    // Postgres accepts any prefixed custom GUC, so on a database where pgvector
    // is not loaded the SET succeeds, changes nothing, and reads truncate.
    const receipt = await receiptFor();
    const outcomes = await probe({
      call: await healthyCall(receipt),
      query: (sql) => (sql.includes('pg_settings') ? Promise.resolve([]) : HEALTHY_DB(sql)),
    });
    expect(outcomes.get('path.guc.ef_search')).toBe('fail');
  });

  test('a registered ef_search passes even though its default is 40', async () => {
    const receipt = await receiptFor();
    const outcomes = await probe({ call: await healthyCall(receipt), query: HEALTHY_DB });
    expect(outcomes.get('path.guc.ef_search')).toBe('pass');
  });

  test('a missing HNSW index fails — H2, which nothing else would notice', async () => {
    const receipt = await receiptFor();
    const outcomes = await probe({
      call: await healthyCall(receipt),
      query: (sql) => (sql.includes("amname = 'hnsw'") ? Promise.resolve([]) : HEALTHY_DB(sql)),
    });
    expect(outcomes.get('path.indexes')).toBe('fail');
  });

  test('a wedged queue fails — a brain that answers while it has stopped learning', async () => {
    const receipt = await receiptFor();
    const outcomes = await probe({
      call: await healthyCall(receipt),
      query: HEALTHY_DB,
      controlQuery: () => Promise.resolve([{ wedged: 2, total: 5 }]),
    });
    expect(outcomes.get('path.queue')).toBe('fail');
  });

  test('the queue is asked of the CONTROL plane, not of a tenant', async () => {
    // KTD1: one database per tenant, and the queue is fleet-wide. Running this
    // probe for real is what found the first version asking a tenant database
    // for a `job` table and reporting a failure that meant nothing.
    let asked = '';
    await probe({
      call: await healthyCall(await receiptFor()),
      query: HEALTHY_DB,
      controlQuery: (sql) => {
        asked = sql;
        return Promise.resolve([{ wedged: 0, total: 1 }]);
      },
    });
    expect(asked).toContain('control.job');
  });

  test('without a control database the queue check defers rather than passing', async () => {
    const outcomes = await probe({ call: await healthyCall(await receiptFor()), query: HEALTHY_DB });
    expect(outcomes.get('path.queue')).toBe('deferred');
  });

  test('an unpinned trigger function fails — H6', async () => {
    const receipt = await receiptFor();
    const outcomes = await probe({
      call: await healthyCall(receipt),
      query: (sql) =>
        sql.includes('prorettype')
          ? Promise.resolve([{ function_name: 'a_ninth_check', pinned: false }])
          : HEALTHY_DB(sql),
    });
    expect(outcomes.get('path.search_path_pinned')).toBe('fail');
  });

  test('a database that refuses fails rather than aborting the whole run', async () => {
    const receipt = await receiptFor();
    const report = await runCanary({
      endpoint: 'https://canary.example/mcp',
      token: 'x',
      tenantId: 't-canary',
      call: await healthyCall(receipt),
      query: () => Promise.reject(new Error('too many connections')),
      controlQuery: HEALTHY_CONTROL,
    });
    // The read half still graded. A canary that lost its results because one
    // half could not connect would report nothing on the day it mattered most.
    expect(report.counts.pass).toBeGreaterThan(3);
    expect(report.counts.fail).toBeGreaterThan(0);
  });
});

/**
 * `attestation.signed` — the one check the whole R10 trust story rests on.
 *
 * **A key id is not a signature.** The check declares that the receipt "is
 * signed, and verifies against the published verification key"; comparing
 * `signature.key_id` to a published string checks that the receipt *names* the
 * key, which anybody who has ever seen one receipt can do. A fleet that had
 * stopped signing — or an attacker who had reached the endpoint — would keep
 * this green while every claim under it became unverifiable, which is precisely
 * the "a receipt that outlives its property" failure `attestation.ts` is built
 * against.
 *
 * The shipped signer is symmetric and publishes a *digest* rather than a key, so
 * an outside party holding only the published value cannot verify at all. That
 * is a `deferred`, not a `pass`: this file's first rule.
 */
describe('a receipt is verified, not recognised', () => {
  const FORGED = { alg: 'HMAC-SHA256', key_id: 'canary-2026-08', value: '00'.repeat(32) } as const;

  const probeSigned = async (options: Omit<CanaryOptions, 'endpoint' | 'token'>): Promise<string> => {
    const report = await runCanary({
      endpoint: 'https://canary.example/mcp',
      token: 'a-caller-supplied-bearer',
      tenantId: 't-canary',
      ...options,
    });
    return report.results.find((result) => result.id === 'attestation.signed')?.outcome ?? 'missing';
  };

  test('a receipt signed by nothing, naming the right key, does not pass', async () => {
    const receipt = await receiptFor({ signature: FORGED });
    expect(await probeSigned({
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
    })).not.toBe('pass');
  });

  test('and with a verifier in hand it is a failure, stated as one', async () => {
    const receipt = await receiptFor({ signature: FORGED });
    expect(await probeSigned({
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
      verifier: SIGNER,
    })).toBe('fail');
  });

  test('a genuine receipt verifies, so the check is not refusing everything', async () => {
    const receipt = await receiptFor();
    expect(await probeSigned({
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
      verifier: SIGNER,
    })).toBe('pass');
  });

  test('a receipt edited after signing fails, because the payload is re-split from the body', async () => {
    // The tenant id is inside what was signed. A receipt whose body was changed
    // and whose signature was kept must not verify, or the signature covers a
    // document nobody sent.
    const receipt = await receiptFor({ tenant_id: 't-somebody-else' });
    expect(await probeSigned({
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
      verifier: SIGNER,
    })).toBe('fail');
  });

  test('a signature under some other key fails without needing a verifier', async () => {
    const receipt = await receiptFor({
      signature: { alg: 'HMAC-SHA256', key_id: 'not-the-published-key', value: '00'.repeat(32) },
    });
    expect(await probeSigned({
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
    })).toBe('fail');
  });

  test('a published value that cannot verify defers, and says why', async () => {
    // The shipped signer is symmetric: what it publishes is a digest of the key,
    // not the key. A holder can tell WHICH key signed and cannot check that it
    // did. `deferred` is the honest answer and `pass` is the dangerous one.
    const receipt = await receiptFor();
    const report = await runCanary({
      endpoint: 'https://canary.example/mcp',
      token: 'x',
      tenantId: 't-canary',
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
    });
    const result = report.results.find((entry) => entry.id === 'attestation.signed');
    expect(result?.outcome).toBe('deferred');
    expect(result?.detail).toContain('verif');
  });

  test('an unsigned receipt still fails outright', async () => {
    const receipt = await receiptFor({
      signature: { status: 'unsigned', reason: 'this fleet is wired to no attestation signer' },
    });
    expect(await probeSigned({
      call: await healthyCall(receipt),
      verificationKey: 'canary-2026-08',
      verifier: SIGNER,
    })).toBe('fail');
  });
});

describe('an outside party can run it from the published docs', () => {
  test('the known record is published in the source, not hidden in a fixture', () => {
    // A canary whose expected answer is private is a canary only we can read.
    expect(CANARY_KNOWN_RECORD.marker).toContain('BRAINZ-CANARY-0001');
    expect(CANARY_KNOWN_RECORD.query.length).toBeGreaterThan(0);
  });

  test('the register documents the invocation this file implements', async () => {
    const register = await Bun.file('docs/register.md').text();
    expect(register).toContain('bun evals/isolation-canary.ts');
    expect(register).toContain('--endpoint');
    expect(register).toContain('deferred');
  });

  test('nothing here embeds a credential of ours', async () => {
    const source = await Bun.file('evals/isolation-canary.ts').text();
    // The token is the caller's own. A canary carrying a secret is one only its
    // author can run, and one whose secret is now published.
    expect(source).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
  });
});
