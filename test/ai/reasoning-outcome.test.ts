/**
 * What the gateway *does* with an answer that isn't one.
 *
 * `cloudflare-seats.test.ts` proves the transport reads the recorded bodies
 * correctly. This file is the consequence: three of the five Cloudflare seats
 * are reasoning models, and the shape they return when they spend their whole
 * output ceiling thinking is an empty `content` with billed completion tokens.
 *
 * There are exactly three wrong answers to that, and the repo could have shipped
 * any of them:
 *
 *  - **`ok: true` with `text: ''`.** The default before this change. The
 *    transcription phase reads an empty string as "this image contains no
 *    legible text", writes an empty `ocr_text`, and never queues the attachment
 *    again — a permanent, silent data loss, paid for.
 *  - **`transport_failed`.** Wrong in the other direction: it means the provider
 *    refused, so a reader diagnosing it goes looking for an outage. Worse, the
 *    reason carries a `providerStatus`, and there isn't one — the call was a
 *    200.
 *  - **Releasing the reservation.** The model ran and the tokens are billed. A
 *    failure that gives the money back is a call that can be repeated forever
 *    under a live cap (rule 2a), which is the 53× overrun's exact shape.
 *
 * So it is its own outcome, the money still settles, and the metering row is
 * still written. Every assertion below runs against a body recorded from the
 * live endpoint.
 */

import { describe, expect, test } from 'bun:test';

import {
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
  type ModelTransport,
  type TransportRequest,
  type TransportResponse,
} from '../../src/ai/gateway.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../src/ai/keys.ts';
import {
  HOSTED_PROFILE,
  MODEL_OPS,
  OP_ADMITS_EMPTY_ANSWER,
  routeFor,
} from '../../src/ai/routing.ts';
import { CANONICAL_PRICING } from '../../src/ai/pricing.ts';
import { fleetIdentity } from '../../src/control/secrets.ts';

const ALICE = 'alice';

/** A transport that answers with a fixed output — the shapes the real one parses. */
function transportReturning(response: TransportResponse): ModelTransport {
  return {
    id: 'scripted',
    invoke: (_request: TransportRequest) => Promise.resolve(response),
  };
}

function gatewayOver(response: TransportResponse) {
  const meter = createInMemorySpendMeter();
  const backend = createInMemoryProviderKeyBackend();
  const gateway = createModelGateway({
    profile: HOSTED_PROFILE,
    transport: transportReturning(response),
    meter,
    keys: {
      store: createTenantProviderKeyStore({ backend }),
      hosted: createHostedKeyPool({ cloudflare: 'hosted-key', openai: 'hosted-key' }),
    },
  });
  return { gateway, meter };
}

const caller = fleetIdentity(ALICE);

describe('an empty answer from a reasoning model is its own outcome', () => {
  test('reasoning beside an empty answer is `reasoning_only_output`', async () => {
    const { gateway } = gatewayOver({
      output: { kind: 'chat', text: '', reasoning: '1. **Analyze the Request:** The user wants' },
      usage: { inputTokens: 19, outputTokens: 16 },
    });
    const result = await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'grade this' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'reasoning_only_output' });
  });

  test('an empty answer with no reasoning at all is `empty_output`', async () => {
    // Distinct from the one above because the remedies differ: one is a ceiling
    // too low, the other is a model producing nothing at all.
    const { gateway } = gatewayOver({
      output: { kind: 'chat', text: '' },
      usage: { inputTokens: 1_600, outputTokens: 0 },
    });
    const result = await gateway.call({
      op: 'synopsis',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'summarise' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'empty_output' });
  });

  test('neither is a refusal — no providerStatus, because the provider returned 200', async () => {
    const { gateway } = gatewayOver({
      output: { kind: 'chat', text: '', reasoning: 'thinking' },
      usage: { inputTokens: 19, outputTokens: 16 },
    });
    const result = await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'grade this' },
    });
    expect(result).not.toMatchObject({ reason: 'transport_failed' });
    expect(result as Record<string, unknown>).not.toHaveProperty('providerStatus');
  });

  test('the tokens are still billed — a failure is not a refund', async () => {
    // Rule 2a. The model ran; releasing the reservation makes this repeatable
    // without limit under a live cap.
    const { gateway, meter } = gatewayOver({
      output: { kind: 'chat', text: '', reasoning: 'thinking' },
      usage: { inputTokens: 19, outputTokens: 16 },
    });
    const budget = createBudget({ label: 'phase', capMicroUsd: 10_000_000 });
    await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget,
      input: { kind: 'chat', user: 'grade this' },
    });

    const glm = CANONICAL_PRICING.get(routeFor(HOSTED_PROFILE, 'judge').id);
    const expected = Math.ceil(
      (19 * (glm?.inputMicroUsdPerMillion ?? 0) + 16 * (glm?.outputMicroUsdPerMillion ?? 0)) /
        1_000_000,
    );
    expect(meter.totalFor(ALICE)).toBe(expected);
    expect(budget.spentMicroUsd()).toBe(expected);
    expect(meter.records()).toHaveLength(1);
  });

  test('the reasoning text never reaches the metering record', async () => {
    const SECRET = 'CANARY-reasoning-trace-must-not-be-retained';
    const { gateway, meter } = gatewayOver({
      output: { kind: 'chat', text: '', reasoning: SECRET },
      usage: { inputTokens: 19, outputTokens: 16 },
    });
    await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'grade this' },
    });
    expect(JSON.stringify(meter.records())).not.toContain(SECRET);
  });

  test('a non-empty answer is still a success, reasoning or not', async () => {
    const { gateway } = gatewayOver({
      output: { kind: 'chat', text: 'ok', reasoning: 'thought about it' },
      usage: { inputTokens: 19, outputTokens: 16 },
    });
    const result = await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'grade this' },
    });
    expect(result.ok).toBe(true);
  });

  test('whitespace is not an answer', async () => {
    const { gateway } = gatewayOver({
      output: { kind: 'chat', text: '   \n  ' },
      usage: { inputTokens: 19, outputTokens: 16 },
    });
    const result = await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'grade this' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'empty_output' });
  });

  test('an unreported usage block still wins — it is the older, louder failure', async () => {
    // Ordering matters: a provider that reported nothing is `usage_unreported`
    // whatever else was wrong with the body, because that is the one that means
    // "this call is unmeterable".
    const { gateway } = gatewayOver({ output: { kind: 'chat', text: '', reasoning: 'thinking' } });
    const result = await gateway.call({
      op: 'judge',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'chat', user: 'grade this' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'usage_unreported' });
  });

  test('an embedding op is untouched by the chat emptiness rule', async () => {
    const { gateway } = gatewayOver({
      output: { kind: 'embedding', vectors: [Array.from({ length: 1536 }, () => 0)] },
      usage: { inputTokens: 10, outputTokens: 0 },
    });
    const result = await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: { kind: 'embedding', texts: ['hello'] },
    });
    expect(result.ok).toBe(true);
  });
});

describe('the vision op is the one seat allowed to answer nothing', () => {
  const transcribe = (response: TransportResponse) =>
    gatewayOver(response).gateway.call({
      op: 'vision',
      tenantId: ALICE,
      caller,
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: {
        kind: 'chat',
        user: 'transcribe',
        images: [{ mediaType: 'image/png', bytes: new Uint8Array([1]) }],
      },
    });

  test('a photograph of a cat transcribes to nothing, and that is an answer', async () => {
    // U21's protocol: the transcription prompt tells the model to return an
    // empty response when there is no legible text. Refusing that answer leaves
    // every text-free attachment queued and re-sent on every cycle for the life
    // of the brain — the standing charge an empty `ocr_text` exists to stop.
    const result = await transcribe({
      output: { kind: 'chat', text: '' },
      usage: { inputTokens: 1_600, outputTokens: 2 },
    });
    expect(result.ok).toBe(true);
  });

  test('but a vision model that thought and said nothing is still refused', async () => {
    // The exemption covers "the image is blank", not "the model never got to
    // the answer". A trace with no answer is the second one.
    const result = await transcribe({
      output: { kind: 'chat', text: '', reasoning: 'The image appears to contain' },
      usage: { inputTokens: 1_600, outputTokens: 64 },
    });
    expect(result).toMatchObject({ ok: false, reason: 'reasoning_only_output' });
  });

  test('and a vision model that reported no usage is refused before emptiness is considered', async () => {
    // The shape the seat returns today: `{"result":{}}`, success, no metrics.
    // It must not reach the exemption above, or every screenshot in every brain
    // records an empty transcription and is never queued again.
    const result = await transcribe({ output: { kind: 'chat', text: '' } });
    expect(result).toMatchObject({ ok: false, reason: 'usage_unreported' });
  });

  test('exactly one op carries the exemption', () => {
    // A tenth op cannot be added without deciding, and no existing op can drift
    // into the exemption without this failing.
    const admitting = MODEL_OPS.filter((op) => OP_ADMITS_EMPTY_ANSWER[op]);
    expect(admitting).toEqual(['vision']);
  });
});
