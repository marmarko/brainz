# Subprocessors

**Last reviewed:** 2026-08-13 · **Owner:** the control-plane operator on call.

R10 requires a published, machine-readable register of every component that touches more than
one user's data. That register is `docs/register.md` and it is about *components and
credentials*. **This list is the other half: every party user content is transmitted to.** The
two are kept apart deliberately, because they answer different questions and a reader of a
privacy policy is asking this one.

The list is short by design and stays short only while KTD13's remaining content-touching model
operations stay on Cloudflare's hosted plane. **Adding a third-party model row is a change to
this file and to the register, not a config edit** — which is what makes that cost visible
before it is paid.

| Subprocessor | What it does | What it receives | Where |
|---|---|---|---|
| **Cloudflare** | Fleet host, container platform, object storage, and the AI Gateway transport every model call passes through. The broadest single component: it is substrate for almost everything, and it carries an entry rather than being treated as invisible. | Brain content in transit for every model call; raw payloads and exported markdown at rest in object storage. | Global |
| **Neon** | One Postgres project per user — the brain itself. | All brain content at rest. | Per-project region |
| **Pipedream** | Connector credential vendor for Gmail, Calendar and Drive. Holds the OAuth grant. **Whether it also proxies message bodies is unresolved** — see below. | At minimum: the OAuth grant and the metadata of what is being fetched. Possibly message bodies. | US |
| **OpenAI** | Embeddings (`text-embedding-3-large`). | Every chunk of text that enters the brain. | US |
| **Google** | Fact and entity extraction, entity enrichment, contradiction detection. | Chunks selected for those consolidation phases. | US |
| **Stripe** | Subscription billing. | **Account and payment data only. Never brain content.** Email address, subscription state, payment details. | US |

## The unresolved entry, named rather than guessed

Pipedream's row says "credential vendor" *and* "possibly content processor" because the answer
is not in hand. The roadmap carries it as a deferred question: does Pipedream proxy message
bodies through its own infrastructure, or does brainz call Google directly with a
Pipedream-minted token? The two produce a materially different disclosure, and the draft that
would settle it is at `docs/vendor/2026-08-12-pipedream-compliance.md`, unsent.

A subprocessor list that guesses is worse than one that admits, so this one admits. The entry is
updated — not quietly, with a dated note in this file — when the answer arrives.

## Why Google and OpenAI, and not the models that scored better

KTD13 rejected three stronger models (Moonshot's `kimi-k3`, Alibaba's `qwen3.5-397b-a17b`,
xAI's `grok-4.5`) on exactly this test: each would have been a new content processor, and none
was a processor whose entry the highest-volume content operations could justify. Salience,
synopsis, vision, rerank and the evaluation judge all run on open weights on Cloudflare's own
GPUs and leave no additional row.

Google's row carries one further argument worth stating plainly: the dominant sources are Gmail,
Calendar and Drive, so most of what is sent to Gemini for extraction is text Google already
holds. That argument is real and it is **not unconditional** — chat exports and folder imports
flow there too, and consumer Google is a different contracting entity from Google-Cloud-the-
processor.

## What is *not* a subprocessor

- **A user's own model provider key (R22).** When a user brings their own key, their calls go to
  their own account at that provider under their own terms. It is their relationship, not ours,
  and it is named here so the distinction is explicit rather than assumed.
- **The control plane.** It holds ids, counters, timestamps, tier and secret references. There is
  no brain content in it, and that is enforced mechanically rather than promised
  (`test/control/schema.test.ts`).
