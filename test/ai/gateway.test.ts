/**
 * The seam. Every model call in the system passes through `call()`, and the
 * unit is judged on one sentence: **no model call anywhere escapes metering.**
 *
 * The tests below are organised around the ways that sentence goes quietly
 * false. Every one of them is a guard that fails *open* — it does not raise, it
 * does not log, it produces a plausible-looking result, and the first symptom
 * is an invoice:
 *
 *  - A cap checked **after** the provider answered. The money is spent; the
 *    error is decoration. So every pre-call refusal asserts the transport was
 *    never reached, which is the only observation that separates the two.
 *  - A provider that reports **no usage**, read as zero tokens. Free calls, in
 *    unlimited quantity. Missing usage is a typed failure here, never a zero.
 *  - A **metering write that throws** and is swallowed so the caller still gets
 *    its answer. That is the definition of an unmetered path. The answer is
 *    dropped instead: losing one completion is cheaper than losing the count.
 *  - An **unpriced model** billed at zero. Cost is `null` and the record says
 *    `price: unknown`; under an active cap the call does not happen at all.
 *  - A **content leak** through the metering record, the observer, or —
 *    easiest to miss — a provider error message echoed into a log line.
 *
 * The fake transport is a real implementation of the shipped interface, so
 * none of these assertions depend on the gateway knowing it is under test.
 */

import { describe, expect, test } from 'bun:test';

import { controlPlaneIdentity, fleetIdentity } from '../../src/control/secrets.ts';
import { CANONICAL_PRICING, createPriceBook } from '../../src/ai/pricing.ts';
import {
  HOSTED_PROFILE,
  MODEL_OPS,
  OP_KINDS,
  PROFILES,
  SELF_HOST_PROFILE,
  routeFor,
  type ModelOp,
  type ProviderId,
} from '../../src/ai/routing.ts';
import { createHostedKeyPool, createInMemoryProviderKeyBackend, createTenantProviderKeyStore } from '../../src/ai/keys.ts';
import {
  GatewayConfigError,
  TransportError,
  createBudget,
  createCloudflareGatewayTransport,
  createDirectTransport,
  createInMemorySpendMeter,
  createModelGateway,
  type MeteringRecord,
  type ModelInput,
  type ModelGatewayOptions,
} from '../../src/ai/gateway.ts';
import { CANARY, createFakeTransport } from './fixture.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';

const ALICE = 'alice';
const BOB = 'bob';

/** The pooled credentials, per provider, so a test can name one by route. */
const HOSTED_KEYS_BY_PROVIDER: Readonly<Record<ProviderId, string>> = {
  google: 'hosted-google',
  openai: 'hosted-openai',
  cloudflare: 'hosted-cloudflare',
  'self-host': 'hosted-self-host',
};

const HOSTED_KEYS = createHostedKeyPool(HOSTED_KEYS_BY_PROVIDER);

function emptyKeyStore() {
  return createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() });
}

function gatewayWith(overrides: Partial<ModelGatewayOptions> = {}) {
  const meter = createInMemorySpendMeter();
  const transport = createFakeTransport();
  const gateway = createModelGateway({
    profile: HOSTED_PROFILE,
    transport,
    meter,
    keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    ...overrides,
  });
  return { gateway, meter, transport };
}

function inputFor(op: ModelOp): ModelInput {
  switch (OP_KINDS[op]) {
    case 'embedding':
      return { kind: 'embedding', texts: [CANARY] };
    case 'rerank':
      return { kind: 'rerank', query: CANARY, candidates: [CANARY, `${CANARY} 2`] };
    default:
      return { kind: 'chat', system: 'You extract facts.', user: CANARY };
  }
}

const UNCAPPED = () => createBudget({ label: 'test', capMicroUsd: null });

describe('the happy path meters', () => {
  test('a call routes by op, sends the pinned id, and records the cost', async () => {
    const { gateway, meter, transport } = gatewayWith();
    const budget = UNCAPPED();

    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget,
      input: inputFor('extract'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const route = routeFor(HOSTED_PROFILE, 'extract');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.modelId).toBe(route.id);
    // The extraction seat is billed by Cloudflare now, so the pooled key it
    // resolves is the Cloudflare one — reading the route's own provider rather
    // than naming a vendor, so this keeps asserting key routing and not a seat.
    expect(transport.calls[0]?.apiKey).toBe(HOSTED_KEYS_BY_PROVIDER[route.provider]);

    const price = CANONICAL_PRICING.get(route.id);
    const expected =
      (1_000 * (price?.inputMicroUsdPerMillion ?? 0) + 200 * (price?.outputMicroUsdPerMillion ?? 0)) /
      1_000_000;
    expect(result.metering.costMicroUsd).toBe(Math.ceil(expected));
    expect(result.metering.price).toBe('known');
    expect(result.metering.tenantId).toBe(ALICE);
    expect(meter.totalFor(ALICE)).toBe(Math.ceil(expected));
    expect(budget.spentMicroUsd()).toBe(Math.ceil(expected));
  });

  test('the caller asks for an op and never for a model', async () => {
    // The whole point of KTD13: retuning a phase is a config change. If a call
    // site could name a model, this property would be unenforceable.
    const { gateway } = gatewayWith();
    const call = gateway.call as unknown as (request: Record<string, unknown>) => Promise<unknown>;
    const result = (await call({
      op: 'extract',
      modelId: '@cf/zai-org/glm-5.2',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('extract'),
    })) as { ok: boolean; metering?: MeteringRecord };
    expect(result.ok).toBe(true);
    expect(result.metering?.modelId).toBe(routeFor(HOSTED_PROFILE, 'extract').id);
  });

  test('only the fleet identity serving this tenant may spend its budget', async () => {
    const { gateway, transport } = gatewayWith();
    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(BOB),
      budget: UNCAPPED(),
      input: inputFor('extract'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'scope_denied' });
    expect(transport.calls).toHaveLength(0);
  });

  test('an input of the wrong shape for the op is refused before the call', async () => {
    const { gateway, transport } = gatewayWith();
    const result = await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: { kind: 'chat', user: 'hello' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'op_kind_mismatch' });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('the unpriced-model rule (R14)', () => {
  function selfHostGateway() {
    const meter = createInMemorySpendMeter();
    const transport = createFakeTransport();
    const gateway = createModelGateway({
      profile: SELF_HOST_PROFILE,
      transport,
      meter,
      keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    });
    return { gateway, meter, transport };
  }

  test('with an active cap it hard-fails, and the provider is never reached', async () => {
    const { gateway, meter, transport } = selfHostGateway();
    const result = await gateway.call({
      op: 'salience',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: createBudget({ label: 'consolidation', capMicroUsd: 1_000_000 }),
      input: inputFor('salience'),
    });

    expect(result).toMatchObject({ ok: false, reason: 'model_not_priced' });
    // The assertion that separates a real cap from a decorative one.
    expect(transport.calls).toHaveLength(0);
    expect(meter.records()).toHaveLength(0);
  });

  test('with no cap it proceeds and records price: unknown, never a zero cost', async () => {
    const { gateway, meter } = selfHostGateway();
    const budget = UNCAPPED();
    const result = await gateway.call({
      op: 'salience',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget,
      input: inputFor('salience'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metering.price).toBe('unknown');
    expect(result.metering.costMicroUsd).toBeNull();
    expect(meter.records()).toHaveLength(1);
    // An unknown cost is not a free cost: nothing was added to the budget, and
    // nothing pretended to know what it was.
    expect(budget.spentMicroUsd()).toBe(0);
  });

  test('a self-hoster who supplies a price basis gets caps back', async () => {
    const meter = createInMemorySpendMeter();
    const overlay = new Map(
      Object.values(SELF_HOST_PROFILE.routes)
        .filter((route) => route.provider === 'self-host')
        .map((route) => [
          route.id,
          {
            inputMicroUsdPerMillion: 10_000,
            outputMicroUsdPerMillion: OP_KINDS[route.op] === 'chat' ? 10_000 : null,
          },
        ]),
    );
    const gateway = createModelGateway({
      profile: SELF_HOST_PROFILE,
      transport: createFakeTransport(),
      meter,
      keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
      priceOverlay: overlay,
    });

    const result = await gateway.call({
      op: 'salience',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: createBudget({ label: 'consolidation', capMicroUsd: 1_000_000 }),
      input: inputFor('salience'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metering.price).toBe('known');
    expect(result.metering.costMicroUsd).toBe(12);
    // Overlaid, not canonical: a self-hoster's hardware is not hosted COGS.
    expect(result.metering.countsTowardHostedCogs).toBe(false);
  });

  test('a self-host route never resolves the Cloudflare price for the same weights', async () => {
    const { gateway } = selfHostGateway();
    const result = await gateway.call({
      op: 'salience',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('salience'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metering.modelId.startsWith('self-host/')).toBe(true);
    expect(result.metering.price).toBe('unknown');
  });
});

describe('budgets are passed in, and they bite before the call', () => {
  test('a per-phase cap exhausts mid-phase and raises the typed budget error', async () => {
    const { gateway, transport } = gatewayWith();
    // Deliberately not a multiple of the per-call cost: a cap that divides
    // evenly is a cap an optimistic estimator can hit exactly and still look
    // correct, which would let the assertion below pass for the wrong reason.
    const budget = createBudget({ label: 'consolidation.salience', capMicroUsd: 20_500 });

    // Run the phase until the cap bites. The number of calls it takes is the
    // estimator's business; that it stops, before spending, is this unit's.
    let answered = 0;
    let failure: Awaited<ReturnType<typeof gateway.call>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await gateway.call({
        op: 'extract',
        tenantId: ALICE,
        caller: fleetIdentity(ALICE),
        budget,
        input: inputFor('extract'),
      });
      if (!result.ok) {
        failure = result;
        break;
      }
      answered += 1;
    }

    expect(failure).toBeDefined();
    if (failure === undefined || failure.ok || failure.reason !== 'budget_exhausted') {
      throw new Error(`expected budget_exhausted, got ${JSON.stringify(failure)}`);
    }
    expect(answered).toBeGreaterThan(0);
    expect(failure.budgetLabel).toBe('consolidation.salience');
    expect(failure.capMicroUsd).toBe(20_500);
    expect(failure.spentMicroUsd).toBeGreaterThan(0);
    // The property the whole pre-call check exists for: the phase never spends
    // past its cap. An estimate that assumes a short answer passes every other
    // assertion here and still overshoots on the last call.
    expect(budget.spentMicroUsd()).toBeLessThanOrEqual(20_500);
    // U11 checkpoints on this, and it must arrive before the money does: the
    // refused call reached no provider.
    expect(transport.calls).toHaveLength(answered);
  });

  test('two phases carry independent budgets in one process', async () => {
    const { gateway } = gatewayWith();
    const consolidation = createBudget({ label: 'consolidation', capMicroUsd: 1_000_000 });
    const requestPath = createBudget({ label: 'request', capMicroUsd: 1_000_000 });

    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: consolidation,
      input: inputFor('extract'),
    });

    expect(result.ok).toBe(true);
    expect(consolidation.spentMicroUsd()).toBeGreaterThan(0);
    expect(requestPath.spentMicroUsd()).toBe(0);
  });
});

describe('metering is the point, so it cannot fail quietly', () => {
  test('cost accrues to the right tenant under concurrent calls', async () => {
    const { gateway, meter } = gatewayWith();
    const budgets = { alice: UNCAPPED(), bob: UNCAPPED() };

    const calls = Array.from({ length: 12 }, (_, index) => {
      const tenantId = index % 2 === 0 ? ALICE : BOB;
      return gateway.call({
        op: 'extract',
        tenantId,
        caller: fleetIdentity(tenantId),
        budget: tenantId === ALICE ? budgets.alice : budgets.bob,
        input: inputFor('extract'),
      });
    });
    const results = await Promise.all(calls);
    expect(results.every((result) => result.ok)).toBe(true);

    const perCall = meter.records()[0]?.costMicroUsd ?? 0;
    expect(perCall).toBeGreaterThan(0);
    expect(meter.totalFor(ALICE)).toBe(perCall * 6);
    expect(meter.totalFor(BOB)).toBe(perCall * 6);
  });

  test('a metering failure drops the answer rather than the count', async () => {
    const failing = {
      record() {
        return Promise.reject(new Error('control plane unreachable'));
      },
    };
    const { gateway } = gatewayWith({ meter: failing });
    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('extract'),
    });
    if (result.ok || result.reason !== 'metering_unavailable') {
      throw new Error(`expected metering_unavailable, got ${JSON.stringify(result)}`);
    }
    // The money was spent, so the local accounting still knows about it.
    expect(result.spentMicroUsd).toBeGreaterThan(0);
  });

  test('a provider that reports no usage is a failure, not a free call', async () => {
    const transport = createFakeTransport({ usage: null });
    const meter = createInMemorySpendMeter();
    const { gateway } = gatewayWith({ transport, meter });
    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('extract'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'usage_unreported' });
    // The call happened, so it is on the record — as unknown, never as zero.
    expect(meter.records()).toHaveLength(1);
    expect(meter.records()[0]?.price).toBe('unknown');
    expect(meter.records()[0]?.costMicroUsd).toBeNull();
  });

  test('a BYOK call meters against the tenant but not against hosted COGS', async () => {
    const store = emptyKeyStore();
    // Stored against the provider the extraction seat routes to, read from the
    // table rather than named: a BYOK key is a fact about a provider, and which
    // provider serves a seat is exactly what the routing table is allowed to
    // change without a call site noticing.
    const provider = routeFor(HOSTED_PROFILE, 'extract').provider;
    await store.put(controlPlaneIdentity(), ALICE, provider, 'alice-tenant-key');
    const { gateway, meter, transport } = gatewayWith({
      keys: { store, hosted: HOSTED_KEYS },
    });

    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('extract'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(transport.calls[0]?.apiKey).toBe('alice-tenant-key');
    expect(result.metering.keySource).toBe('byok');
    expect(result.metering.countsTowardHostedCogs).toBe(false);
    // Still metered: R22 wants the user's own cap and visibility intact.
    expect(meter.totalFor(ALICE)).toBeGreaterThan(0);
  });

  test('two tenants with different stored keys do not cross-resolve in one process', async () => {
    const store = emptyKeyStore();
    // Stored against the provider the extraction seat actually routes to.
    const provider = routeFor(HOSTED_PROFILE, 'extract').provider;
    await store.put(controlPlaneIdentity(), ALICE, provider, 'alice-tenant-key');
    await store.put(controlPlaneIdentity(), BOB, provider, 'bob-tenant-key');
    const { gateway, transport } = gatewayWith({ keys: { store, hosted: HOSTED_KEYS } });

    for (const tenantId of [ALICE, BOB, ALICE]) {
      await gateway.call({
        op: 'extract',
        tenantId,
        caller: fleetIdentity(tenantId),
        budget: UNCAPPED(),
        input: inputFor('extract'),
      });
    }
    expect(transport.calls.map((call) => call.apiKey)).toEqual([
      'alice-tenant-key',
      'bob-tenant-key',
      'alice-tenant-key',
    ]);
  });
});

describe('no user content leaves this module', () => {
  test('a seeded call puts no chunk text in any record, on either profile', async () => {
    for (const profile of Object.values(PROFILES)) {
      const meter = createInMemorySpendMeter();
      const observed: MeteringRecord[] = [];
      const gateway = createModelGateway({
        profile,
        transport: createFakeTransport(),
        meter,
        keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
        observer: (record) => observed.push(record),
      });

      for (const op of MODEL_OPS) {
        const result = await gateway.call({
          op,
          tenantId: ALICE,
          caller: fleetIdentity(ALICE),
          budget: UNCAPPED(),
          input: inputFor(op),
        });
        expect(result.ok, `${profile.name}/${op}`).toBe(true);
      }

      // All nine ops answered on both profiles — the `@cf/` five included.
      expect(meter.records()).toHaveLength(MODEL_OPS.length);
      expect(observed).toHaveLength(MODEL_OPS.length);
      const serialized = JSON.stringify({ metered: meter.records(), observed });
      expect(serialized).not.toContain(CANARY);
      // No pooled credential of any provider reaches a metering record.
      for (const key of Object.values(HOSTED_KEYS_BY_PROVIDER)) {
        expect(serialized).not.toContain(key);
      }
    }
  });

  test('a provider error never carries the request body outward', async () => {
    // The leak that survives every review: the provider echoes the prompt in
    // its error body, the client throws it as a message, and it lands in a log.
    const { gateway } = gatewayWith({
      transport: createFakeTransport({
        failWith: new Error(`400 invalid request: {"input":"${CANARY}"}`),
      }),
    });
    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('extract'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'transport_failed' });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  test('the metering record carries only metadata KTD13 named', () => {
    const record: MeteringRecord = {
      tenantId: ALICE,
      op: 'extract',
      profile: 'hosted',
      modelId: 'x',
      provider: 'google',
      inputTokens: 1,
      outputTokens: 1,
      price: 'known',
      costMicroUsd: 1,
      keySource: 'hosted',
      countsTowardHostedCogs: true,
      budgetLabel: 'phase',
      atMs: 0,
    };
    // Op name, model, token counts, cost, tenant id — and nothing else. A new
    // field that could hold a prompt breaks this line, which is the point.
    expect(Object.keys(record).sort()).toEqual(
      [
        'atMs',
        'budgetLabel',
        'costMicroUsd',
        'countsTowardHostedCogs',
        'inputTokens',
        'keySource',
        'modelId',
        'op',
        'outputTokens',
        'price',
        'profile',
        'provider',
        'tenantId',
      ].sort(),
    );
  });
});

describe('the shipped transports', () => {
  interface Sent {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
  }

  function recordingFetch(payload: unknown, status = 200) {
    const sent: Sent[] = [];
    const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
      sent.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }),
      );
    };
    return { sent, fetchImpl };
  }

  const chatRequest = {
    modelId: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google' as const,
    op: 'extract' as const,
    kind: 'chat' as const,
    input: { kind: 'chat' as const, user: CANARY },
    apiKey: 'secret-key',
    maxOutputTokens: 256,
    embeddingDimensions: null,
    metadata: { op: 'extract' as const, tenantId: ALICE, profile: 'hosted', budgetLabel: 'phase' },
  };

  test('the hosted transport turns body logging off on every request', async () => {
    // AI Gateway retains request and response bodies when logging is on. An
    // unstated default here turns the transport into a content store sitting
    // outside every erasure leg — so the header is asserted, not assumed.
    const { sent, fetchImpl } = recordingFetch({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const transport = createCloudflareGatewayTransport({
      accountId: 'acct',
      gatewayId: 'gw',
      fetchImpl,
    });

    const response = await transport.invoke(chatRequest);
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(sent[0]?.headers['cf-aig-collect-log']).toBe('false');
    // Metadata is metadata: op, tenant, profile, budget, model — no content.
    expect(sent[0]?.headers['cf-aig-metadata']).toBeDefined();
    expect(sent[0]?.headers['cf-aig-metadata']).not.toContain(CANARY);
  });

  test('an embedding call sends the dimensions parameter, never a client-side slice', async () => {
    // KTD8: the parameter re-normalizes the returned vector. A hand-sliced
    // vector is not unit-length, which changes distance semantics silently.
    const { sent, fetchImpl } = recordingFetch({
      data: [{ embedding: [0, 1] }],
      usage: { prompt_tokens: 5 },
    });
    const transport = createDirectTransport({ fetchImpl });
    await transport.invoke({
      ...chatRequest,
      provider: 'openai',
      op: 'embedding',
      kind: 'embedding',
      input: { kind: 'embedding', texts: [CANARY] },
      maxOutputTokens: 0,
      embeddingDimensions: 1536,
    });
    expect(sent[0]?.body['dimensions']).toBe(1536);
  });

  test('a response with no usage block reports no usage, rather than zero', async () => {
    const { fetchImpl } = recordingFetch({ choices: [{ message: { content: 'ok' } }] });
    const transport = createDirectTransport({ fetchImpl });
    const response = await transport.invoke(chatRequest);
    expect(response.usage).toBeUndefined();
  });

  test('a provider error carries a status and never a body', async () => {
    const { fetchImpl } = recordingFetch({ error: { message: `bad input: ${CANARY}` } }, 400);
    const transport = createDirectTransport({ fetchImpl });
    try {
      await transport.invoke(chatRequest);
      throw new Error('expected the transport to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).status).toBe(400);
      expect(String(error)).not.toContain(CANARY);
    }
  });

  test('a provider with no configured endpoint fails rather than guessing one', () => {
    const transport = createDirectTransport({});
    expect(() => transport.invoke({ ...chatRequest, provider: 'self-host' })).toThrow(TransportError);
  });

  test('a vector of the wrong width is a typed failure, not a quiet recall loss', async () => {
    const meter = createInMemorySpendMeter();
    const gateway = createModelGateway({
      profile: HOSTED_PROFILE,
      transport: createFakeTransport({ embeddingDimensions: EMBEDDING_DIMENSIONS + 512 }),
      meter,
      keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    });
    const result = await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget: UNCAPPED(),
      input: inputFor('embedding'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'embedding_dimension_mismatch' });
    // The call still happened, so it is still on the meter.
    expect(meter.records()).toHaveLength(1);
  });
});

describe('construction validates what it is handed', () => {
  test('a custom profile is validated at construction, not at first call', () => {
    const broken = {
      name: 'custom',
      routes: { ...HOSTED_PROFILE.routes,
        judge: { ...HOSTED_PROFILE.routes.judge, id: '@cf/zai-org/glm-99' } },
    };
    expect(() =>
      createModelGateway({
        profile: broken,
        transport: createFakeTransport(),
        meter: createInMemorySpendMeter(),
        keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
      }),
    ).toThrow(GatewayConfigError);
  });

  test('an overlay that shadows a canonical price is refused at construction', () => {
    expect(() =>
      createModelGateway({
        profile: HOSTED_PROFILE,
        transport: createFakeTransport(),
        meter: createInMemorySpendMeter(),
        keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
        priceOverlay: new Map([
          ['@cf/zai-org/glm-5.2', { inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1 }],
        ]),
      }),
    ).toThrow(GatewayConfigError);
  });

  test('a price book handed a non-canonical hosted model is still refused', () => {
    // The overlay cannot be used to make an unpriced hosted row look priced
    // either — the startup rule is about the canonical table, not any table.
    expect(() =>
      createPriceBook(
        new Map([['@cf/zai-org/glm-5.2', { inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1 }]]),
      ),
    ).toThrow();
  });
});

/**
 * **The money a throw walked away with.**
 *
 * The reservation is taken as the last synchronous statement before the first
 * `await`, and every *typed* exit below it gives the reservation back. A
 * backend fault in the key store is not a typed exit: `src/control/secrets.ts`
 * is explicit that "the store is down" must never be flattened into "this
 * tenant does not exist", so it propagates as an exception — straight past the
 * `reservation.release()` that only the `!key.ok` branch runs.
 *
 * What that cost was not the throw, which the caller sees and handles. It was
 * the next call on the same budget: the run's cap had a hole in it the size of
 * the estimate, and a later call was refused `budget_exhausted` against a cap
 * with room to spare — a refusal that named the wrong cause and sent whoever
 * read it looking at spend limits.
 */
describe('a key store that throws does not keep the reservation', () => {
  function throwingKeyStore() {
    return {
      resolve: async () => {
        throw new Error('control plane is unreachable');
      },
      write: async () => ({ ok: true as const }),
      revokeAll: async () => ({ ok: true as const }),
    };
  }

  test('the throw still propagates — it is not flattened into a typed refusal', async () => {
    const { gateway } = gatewayWith({
      keys: { store: throwingKeyStore() as never, hosted: HOSTED_KEYS },
    });
    await expect(
      gateway.call({
        op: 'embedding',
        tenantId: ALICE,
        caller: fleetIdentity(ALICE),
        budget: createBudget({ label: 'run', capMicroUsd: 1_000_000 }),
        input: inputFor('embedding'),
      }),
    ).rejects.toThrow('control plane is unreachable');
  });

  test('the reservation is returned, so the next call is not refused against a cap with room', async () => {
    const { gateway } = gatewayWith({
      keys: { store: throwingKeyStore() as never, hosted: HOSTED_KEYS },
    });
    // One cap, many calls — the per-run shape `src/ingest/pipedream/pull.ts`
    // uses, which is what made the leak survive long enough to mislead.
    const budget = createBudget({ label: 'run', capMicroUsd: 1_000_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await gateway
        .call({
          op: 'embedding',
          tenantId: ALICE,
          caller: fleetIdentity(ALICE),
          budget,
          input: inputFor('embedding'),
        })
        .catch(() => undefined);
    }

    // The discriminating numbers. Before the fix `reservedMicroUsd()` grew by
    // the estimate on every throw and never came back down; `spentMicroUsd()`
    // stays zero either way, because nothing was ever bought.
    expect(budget.reservedMicroUsd()).toBe(0);
    expect(budget.spentMicroUsd()).toBe(0);
  });
});
