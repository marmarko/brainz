# What the OCR phase costs — U21, 2026-08-13

Every number below is derived from `src/ai/pricing.ts` through
`src/ai/routing.ts`, not quoted from a vendor page. Reproduce them with the
snippet at the bottom; if the canonical table moves, the snippet moves with it
and this document is the thing that goes stale, which is the intended direction.

**Nothing here was measured against a live provider.** No paid call was made in
this unit. These are projections from the table, and the assumptions they rest on
are named rather than buried.

## The seat

KTD13's "Image / PDF → text" row, which `routing.ts` files as the `vision` op:

| | |
|---|---|
| Model (pinned) | `@cf/meta/llama-3.2-11b-vision-instruct` |
| Price | $0.049 / $0.676 per million in / out |
| Output ceiling | 4,096 tokens |
| Residency | Cloudflare-hosted — no new R10 register entry, no new U15 subprocessor |

## Assumption 1 — an image is worth 1,600 input tokens

`IMAGE_INPUT_TOKENS` in `src/ai/routing.ts`. It is the single-tile encoding
figure for a vision-language model of this class, rounded flat, and it stands in
for a number only a live call can confirm: **the provider's own usage block is
what settles it**, and metering already reconciles to that, so this figure bounds
the *reservation* and never the bill.

Being wrong is asymmetric. Too high wastes a little budget headroom. Too low —
and zero is what the character-counting estimator would use without it — means a
vision call reserves almost nothing, the cap does not fire, and the first place
the overrun surfaces is an invoice. That is the failure U20 exists to prevent, so
the figure is deliberately generous.

The prompt adds 95 tokens (`TRANSCRIBE_SYSTEM_PROMPT` + `TRANSCRIBE_USER_PROMPT`,
at the gateway's four-characters-per-token estimate), for **1,695 input tokens per
image**.

## Assumption 2 — 10 attachments a day per active user

An active alpha user on Gmail + Drive: mail attachments, screenshots dropped into
Drive, the occasional PDF. Ten a day is ~300 a month. It is a guess at a volume
nobody has measured yet; the founder's own alpha corpus is what will replace it,
and the per-image figures below are the part that does not move when it does.

## Two figures per image, and they are far apart

| | Input | Output | Cost |
|---|---|---|---|
| **Reserved** (what the cap sees) | 1,695 | 4,096 (the route ceiling) | **2,852 µUSD** |
| Actual, ~200-token transcript | 1,695 | 200 | 219 µUSD |
| Actual, ~400-token transcript | 1,695 | 400 | 354 µUSD |
| Actual, ~800-token transcript | 1,695 | 800 | 624 µUSD |

The gap is the estimator's pessimism about output, and it is deliberate in the
same direction everywhere else in this codebase: an estimate that assumed a short
answer would produce a cap that fires after the money is gone. A screenshot of a
router page transcribes to a few hundred tokens; the 4,096 ceiling is a page of
dense text.

Each transcript also pays for its own embedding out of the same phase budget —
about **33 µUSD** for a 250-token transcript on KTD8's seat. Chunk embeddings are
deferred to the ordinary backlog, exactly as for any other document, so they are
not this phase's line item.

## Per user, per month

At 300 attachments a month, with the embedding included:

| | Monthly |
|---|---|
| Actual, ~200-token transcripts | **$0.076** |
| Actual, ~400-token transcripts | $0.116 |
| Reserved (every transcript hits the ceiling) | $0.866 |

Against KTD13's ~$10–11/user/month model-phase COGS, transcription is **under one
percent of the paid tier at the realistic figure and under ten percent at the
pessimistic one**. It does not move the tier decision.

**The first import is where a cap actually bites.** A year of mail backfilled at
2,000 attachments costs ~$0.50 at the realistic figure and ~$5.70 at the
reservation ceiling — and the ceiling is what U9's first-import gate would show a
user, because that is what the budget reserves. Worth knowing before someone
reads the estimate and assumes it is the bill.

**The text-layer PDF path costs nothing at all.** Every PDF produced by software
rather than a scanner — invoices, statements, contracts, manuals — is extracted
by `pdf-text.ts` with no model call. The figures above assume every attachment is
an image. If half the attachments are text-layer PDFs, halve them.

## What is not in these numbers

- **A live call.** No paid provider call was made. Whether Cloudflare's
  OpenAI-compatible endpoint accepts `image_url` content parts for a `@cf/`
  vision model is unverified — the transport builds that shape and a scripted
  transport asserts it, which proves the body brainz sends and not the body the
  vendor accepts.
- **The `image_to_text` canary-floor receipt.** KTD13's exit gate for the
  consolidation ops is U11's, and grading transcription accuracy needs live paid
  calls against U7's harness.
- **`moondream3.1-9B-A2B`.** KTD13's screenshot-specialist challenger, deferred
  in the ledger (`oos.moondream-screenshot-specialist`) because it has no
  published price, and R14 hard-fails an unpriced model under a cap. A price plus
  a same-fixture A/B settles it; the swap is then one row in `routing.ts`.

## Reproducing

```ts
import { CANONICAL_PRICE_BOOK, costMicroUsd } from './src/ai/pricing.ts';
import { HOSTED_PROFILE, IMAGE_INPUT_TOKENS, routeFor } from './src/ai/routing.ts';
import { TRANSCRIBE_SYSTEM_PROMPT, TRANSCRIBE_USER_PROMPT } from './src/core/media/ocr-phase.ts';

const route = routeFor(HOSTED_PROFILE, 'vision');
const price = CANONICAL_PRICE_BOOK.lookup(route.id)!;
const input =
  Math.ceil((TRANSCRIBE_SYSTEM_PROMPT + TRANSCRIBE_USER_PROMPT).length / 4) + IMAGE_INPUT_TOKENS;

costMicroUsd({ inputTokens: input, outputTokens: route.maxOutputTokens }, price); // reserved
costMicroUsd({ inputTokens: input, outputTokens: 200 }, price); // a screenshot
```
