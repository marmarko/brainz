/**
 * The image seam through the gateway (KTD13, U20).
 *
 * An image is content, and content reaches a provider through exactly one
 * module. Two properties follow, and the second is the one that would rot
 * silently:
 *
 *  1. **An image is only sent to an op that takes images.** `OP_KINDS` already
 *     refuses an embedding input handed to a chat op; images need the same
 *     refusal, because `extract` and `synopsis` route to text models that would
 *     answer *something* about a prompt whose picture they never saw. A wrong
 *     answer from a real model is the expensive kind of bug: it is priced,
 *     metered, plausible and wrong.
 *  2. **An image is reserved for before it is sent.** The gateway's first rule
 *     is that the estimate leaves the budget before the provider is called. Its
 *     estimator counts characters, and an image has almost none — so without an
 *     explicit per-image token count a vision call reserves nearly nothing and
 *     the cap fires after the money is gone.
 */

import { describe, expect, test } from 'bun:test';

import { createBudget } from '../../src/ai/gateway.ts';
import { CANONICAL_PRICE_BOOK, costMicroUsd } from '../../src/ai/pricing.ts';
import {
  HOSTED_PROFILE,
  IMAGE_INPUT_TOKENS,
  OP_ACCEPTS_IMAGES,
  routeFor,
} from '../../src/ai/routing.ts';
import { CALLER, TENANT, createGateway, screenshotBytes, uncappedBudget } from './fixture.ts';

const IMAGE = { mediaType: 'image/png', bytes: screenshotBytes() } as const;

describe('only the vision op takes images', () => {
  test('the routing table says so once, rather than at every call site', () => {
    expect(OP_ACCEPTS_IMAGES.vision).toBe(true);
    for (const op of ['extract', 'enrich', 'contradiction', 'salience', 'synopsis', 'judge'] as const) {
      expect(OP_ACCEPTS_IMAGES[op]).toBe(false);
    }
  });

  test('an image handed to a text op is refused before the transport is reached', async () => {
    const harness = createGateway({ vision: () => 'unused' });
    const result = await harness.gateway.call({
      op: 'extract',
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      input: { kind: 'chat', user: 'what does this say?', images: [IMAGE] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a text op must not accept an image');
    expect(result.reason).toBe('image_not_accepted');
    // Refused, not merely unanswered: nothing was sent, so nothing was billed.
    expect(harness.transport.calls).toEqual([]);
  });

  test('the same call to the vision op goes through', async () => {
    const harness = createGateway({ vision: () => 'the text in the picture' });
    const result = await harness.gateway.call({
      op: 'vision',
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      input: { kind: 'chat', user: 'what does this say?', images: [IMAGE] },
    });

    expect(result.ok).toBe(true);
    expect(harness.transport.callsFor('vision').length).toBe(1);
  });

  test('a text-only chat on the vision op is still a chat', async () => {
    const harness = createGateway({ vision: () => 'nothing to see' });
    const result = await harness.gateway.call({
      op: 'vision',
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      input: { kind: 'chat', user: 'no picture attached' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('an image costs tokens before it costs money', () => {
  const PROMPT = 'read this';
  const route = routeFor(HOSTED_PROFILE, 'vision');
  const price = CANONICAL_PRICE_BOOK.lookup(route.id);
  if (price === undefined) throw new Error('the vision seat has no canonical price');

  const promptTokens = Math.ceil(PROMPT.length / 4);
  const withoutImage = costMicroUsd(
    { inputTokens: promptTokens, outputTokens: route.maxOutputTokens },
    price,
  );
  const withImage = costMicroUsd(
    { inputTokens: promptTokens + IMAGE_INPUT_TOKENS, outputTokens: route.maxOutputTokens },
    price,
  );

  test('the per-image token count is a stated number, not zero', () => {
    expect(IMAGE_INPUT_TOKENS).toBeGreaterThan(0);
    // The discriminator the two cases below stand on. If an image reserved
    // nothing, these would be equal and the cap could not tell them apart.
    expect(withImage).toBeGreaterThan(withoutImage);
  });

  test('a cap one unit under the image call refuses it, and nothing is sent', async () => {
    const harness = createGateway({ vision: () => 'never reached' });
    const budget = createBudget({ label: 'exact', capMicroUsd: withImage - 1 });

    const result = await harness.gateway.call({
      op: 'vision',
      tenantId: TENANT,
      caller: CALLER,
      budget,
      input: { kind: 'chat', user: PROMPT, images: [IMAGE] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the cap must refuse');
    expect(result.reason).toBe('budget_exhausted');
    expect(harness.transport.calls).toEqual([]);
  });

  test('the very same cap admits the very same prompt without the image', async () => {
    const harness = createGateway({ vision: () => 'cheap' });
    const budget = createBudget({ label: 'exact', capMicroUsd: withImage - 1 });

    const result = await harness.gateway.call({
      op: 'vision',
      tenantId: TENANT,
      caller: CALLER,
      budget,
      input: { kind: 'chat', user: PROMPT },
    });

    // So the refusal above was the image's doing, not a cap that refuses
    // everything — which is what that test would silently become if the
    // per-image token count were ever set to zero.
    expect(result.ok).toBe(true);
    expect(harness.transport.callsFor('vision').length).toBe(1);
  });
});
