/**
 * The width a returned vector is checked against is the **routed model's**, not
 * a global.
 *
 * `EMBEDDING_PIN.dimensions` was one number because one model was ever routed to
 * the `embedding` op. With two seats registered it is right for one of them and
 * wrong for the other, and wrong in the direction that looks like an outage: a
 * profile routing `embedding` to the 1024 seat gets `embedding_dimension_mismatch`
 * on every call, from a model that answered correctly, with the check naming a
 * width nothing in that profile ever asked for.
 *
 * The reverse is what the check is FOR, and it must survive: a 1024 vector
 * arriving under the 1536 seat is still a typed failure, because storing it
 * would be a quiet recall loss. `gateway.test.ts` owns that case; this file owns
 * the case where the two seats disagree, which is the one a global cannot
 * express.
 */

import { describe, expect, test } from 'bun:test';

import {
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
} from '../../src/ai/gateway.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../src/ai/keys.ts';
import { CANONICAL_PRICE_BOOK } from '../../src/ai/pricing.ts';
import {
  HOSTED_PROFILE,
  embeddingSeatFor,
  findRoutingFaults,
  type NamedProfile,
  type ProviderId,
} from '../../src/ai/routing.ts';
import { fleetIdentity } from '../../src/control/secrets.ts';
import { requireSeatById } from '../../src/schema/embedding-seat.ts';
import { CANARY, createFakeTransport } from './fixture.ts';

const ALICE = 'alice';

const HOSTED_KEYS = createHostedKeyPool({
  google: 'hosted-google',
  openai: 'hosted-openai',
  cloudflare: 'hosted-cloudflare',
  'self-host': 'hosted-self-host',
} satisfies Readonly<Record<ProviderId, string>>);

const emptyKeyStore = () =>
  createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() });

const UNCAPPED = () => createBudget({ label: 'test', capMicroUsd: null });

const EMBEDDING_INPUT = { kind: 'embedding', texts: [CANARY] } as const;

const QWEN_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const QWEN = requireSeatById('cf-qwen3-embedding-0.6b-1024');

/**
 * The shipped hosted profile with only its `embedding` row moved.
 *
 * Constructed here rather than shipped, because the seat is not routable yet —
 * `fact.embedding` is `vector(1536) NOT NULL` and no 1024-dimension model can
 * fill it. What is being asserted is the gateway's half: that when a profile
 * DOES route there, the width check reads the route rather than a constant.
 */
const QWEN_EMBEDDING_PROFILE: NamedProfile = {
  name: 'qwen-embedding-fixture',
  routes: {
    ...HOSTED_PROFILE.routes,
    embedding: {
      op: 'embedding',
      alias: QWEN_MODEL,
      id: QWEN_MODEL,
      provider: 'cloudflare',
      pinnedOn: '2026-08-16',
      maxOutputTokens: 0,
    },
  },
};

describe('the embedding width check is per route', () => {
  test('the fixture profile is a servable routing table, so the test is about width', () => {
    expect(findRoutingFaults(QWEN_EMBEDDING_PROFILE, CANONICAL_PRICE_BOOK)).toEqual([]);
    expect(embeddingSeatFor(QWEN_MODEL)).toBe(QWEN);
  });

  test('an embedding model with no registered seat is refused at construction', () => {
    // The fault that keeps the width check total: an unseated model has no
    // column, so its vectors are paid for and unusable. Refused with the
    // profile rather than discovered on the first read.
    const unseated: NamedProfile = {
      name: 'unseated',
      routes: {
        ...HOSTED_PROFILE.routes,
        embedding: { ...HOSTED_PROFILE.routes.embedding, alias: 'text-embedding-3-small', id: 'text-embedding-3-small' },
      },
    };
    expect(findRoutingFaults(unseated, CANONICAL_PRICE_BOOK).join(' ')).toContain(
      'no registered embedding seat',
    );
  });

  test('a 1024 vector under the 1024 seat is accepted', async () => {
    const gateway = createModelGateway({
      profile: QWEN_EMBEDDING_PROFILE,
      transport: createFakeTransport({ embeddingDimensions: QWEN.dimensions }),
      meter: createInMemorySpendMeter(),
      keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    });

    const result = await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: EMBEDDING_INPUT,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.kind).toBe('embedding');
      expect(result.metering.modelId).toBe(QWEN_MODEL);
    }
  });

  test('a 1536 vector under the 1024 seat is still refused', async () => {
    // The check has to be able to go red under the new seat too, or it has
    // merely been moved rather than made per-route.
    const gateway = createModelGateway({
      profile: QWEN_EMBEDDING_PROFILE,
      transport: createFakeTransport({ embeddingDimensions: 1536 }),
      meter: createInMemorySpendMeter(),
      keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    });

    const result = await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: EMBEDDING_INPUT,
    });

    expect(result).toMatchObject({ ok: false, reason: 'embedding_dimension_mismatch' });
  });

  test('the width asked of the provider is the routed seat’s', async () => {
    const transport = createFakeTransport({ embeddingDimensions: QWEN.dimensions });
    const gateway = createModelGateway({
      profile: QWEN_EMBEDDING_PROFILE,
      transport,
      meter: createInMemorySpendMeter(),
      keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    });

    await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: EMBEDDING_INPUT,
    });

    expect(transport.calls[0]?.embeddingDimensions).toBe(QWEN.dimensions);
  });
});
