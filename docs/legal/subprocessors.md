# Subprocessors

**Last reviewed:** 2026-08-16 · **Owner:** the control-plane operator on call.

R10 requires a published, machine-readable register of every component that touches more than
one user's data. That register is `docs/register.md` and it is about *components and
credentials*. **This list is the other half: every outside party we send user data to.** The
two are kept apart deliberately, because they answer different questions and a reader of a
privacy policy is asking this one.

Most rows here receive brain content. One (Stripe) never does and is listed anyway, because a
party holding your email address and your payment relationship is a party you are entitled to
know about.

**Adding a row is a change to this file and to the register, not a config edit** — which is what
makes that cost visible before it is paid.

| Subprocessor | What it does | What it receives | Where |
|---|---|---|---|
| **Cloudflare** | Fleet host, container platform, object storage, and — since the seats moved — the billing and transport plane for **all nine** model operations. The broadest single component: it is substrate for almost everything, and it carries an entry rather than being treated as invisible. | Brain content in transit for every model call, embedding included; raw payloads and exported markdown at rest in object storage. | Global |
| **Neon** | One Postgres project per user — the brain itself. | All brain content at rest. | Per-project region |
| **Pipedream** | Connector credential vendor for Gmail, Calendar and Drive. Holds the OAuth grant. **Whether it also proxies message bodies is unresolved** — see below. | At minimum: the OAuth grant and the metadata of what is being fetched. Possibly message bodies. | US |
| **Google** | Fact and entity extraction, entity enrichment, contradiction detection. Reached **through Cloudflare**, not directly — see the next section. | Chunks selected for those consolidation phases. | US |
| **Stripe** | Subscription billing. | **Account and payment data only. Never brain content.** Email address, subscription state, payment details. | US |

Five parties. **OpenAI was the sixth and is no longer one:** the embedding seat, the one
operation still reached on an OpenAI credential, moved onto Cloudflare, and nothing in the
hosted service sends anything to OpenAI any more. If a row is added or removed here, the count
in `docs/legal/privacy-policy.md` moves in the same change.

## How a model call actually reaches a party

The seats moved onto one Cloudflare credential, and **the move changed the route without
shortening this list.** That distinction is the whole point of this section, because the obvious
reading of "everything is on Cloudflare now" is that Cloudflare became the only party — and it
did not.

| Model operation | Reached over | Parties that see the content |
|---|---|---|
| Fact/entity extraction, entity enrichment, contradiction detection | Cloudflare's Unified Billing endpoint, which **passes the call through to Google** under Cloudflare's own provider relationship | Cloudflare **and** Google |
| Salience refinement, synopsis wrap, image/PDF transcription, eval judge, rerank | Cloudflare's Unified Billing endpoint, open weights running on Cloudflare's own GPUs | Cloudflare only |
| Embedding | Cloudflare's Unified Billing endpoint, open weights running on Cloudflare's own GPUs | Cloudflare only |

Three consequences worth stating plainly, because each one is a thing a reader could otherwise
get wrong:

- **Passthrough is not hosting.** When Cloudflare bills a Google model and forwards the call,
  the text still crosses to Google's infrastructure. Google is a processor of that content
  exactly as it was before the move. What changed is that Cloudflare now sees it too, and that
  we hold no Google credential on the hosted plane — rotating the Cloudflare token is what cuts
  that path off.
- **Open weights on Cloudflare's GPUs add no party.** Nemotron, GLM, moondream and the
  cross-encoder are open-weight models Cloudflare runs itself. There is no proxy to the lab that
  originally published the weights, so no row is owed to NVIDIA, Z.ai, Moondream or BAAI.
  The register names `cloudflare-models` as a component for the same reason it names any other:
  a reader will look for "the rerank endpoint" by name.
- **The embedding seat moved, and dropping OpenAI is what that bought.** It was the one seat
  still on its own vendor credential, and it was the last one to move because it was never a
  routing row: the Cloudflare model returns vectors of a different width than the stored column
  and the `dimensions` parameter is ignored on that endpoint, so there was nothing to truncate
  with. Closing it took a second stored column beside the first, the removal of a `NOT NULL`
  that no 1024-dimension model could satisfy, and one selector deciding which column every
  statement touches — because two vectors of different models are not points in the same space
  whatever their widths. The reason it was cheap to do now is that no brain holds a corpus yet;
  the same move against a year of stored vectors is a re-encode of every chunk in every brain.
- **Google did not move, and no reading of the paragraph above should suggest it did.** Three
  operations still cross to Google. Cloudflare bills them and passes them through; the content
  reaches Google either way. "Everything runs on Cloudflare now" is true of the *credential* and
  false of the *data flow*, and this list is about the data flow.

The self-hosted deployment (AGPL) routes differently — Google directly on the operator's own
key, the open-weight seats on the operator's own endpoint — and its operator publishes their own
list. This document describes the hosted service.

## The unresolved entry, named rather than guessed

Pipedream's row says "credential vendor" *and* "possibly content processor" because the answer
is not in hand. The roadmap carries it as a deferred question: does Pipedream proxy message
bodies through its own infrastructure, or does brainz call Google directly with a
Pipedream-minted token? The two produce a materially different disclosure, and the draft that
would settle it is at `docs/vendor/2026-08-12-pipedream-compliance.md`, unsent.

A subprocessor list that guesses is worse than one that admits, so this one admits. The entry is
updated — not quietly, with a dated note in this file — when the answer arrives.

## Why Google, and not the models that scored better

KTD13 rejected three stronger models (Moonshot's `kimi-k3`, Alibaba's `qwen3.5-397b-a17b`,
xAI's `grok-4.5`) on exactly this test: each would have been a new content processor, and none
was a processor whose entry the highest-volume content operations could justify. Salience,
synopsis, transcription, rerank and the evaluation judge all run on open weights on Cloudflare's
own GPUs and leave no additional row.

That test is still the one being applied, and it has since declined two more candidates on the
same grounds — a newer judge model that Cloudflare does not host, which could only be reached by
opening a direct relationship with a third lab, and a challenger with no evidence relevant to
the seat. Both are recorded in `upstream/concepts.jsonl` rather than here, because a model that
was never routed is not a subprocessor.

**Two seats changed model since. One shortened this list and one did not, and the difference is
worth reading.** The embedding seat moved from OpenAI onto Cloudflare's open weights, which
removed a party — the only change in this document's history that has. Transcription changed
model within Cloudflare's own catalog, which removed none, and the reason it changed is a licence
rather than a price. Transcription was originally specified on Cloudflare's hosted Llama vision model.
Access to it requires submitting the prompt `agree` to Meta's licence *and representing that the
user is not domiciled in the EU* — a representation about a person that a hosted service cannot
make on its users' behalf, since it does not know where they live and they never saw the term.
The seat is now `moondream`, which is also open weights on Cloudflare's GPUs, so the party list
is unchanged. `upstream/concepts.jsonl:oos.llama-vision-licence-bar` records the bar so nobody
re-routes to it later without meeting the condition.

Google's row carries one further argument worth stating plainly: the dominant sources are Gmail,
Calendar and Drive, so most of what is sent to Gemini for extraction is text Google already
holds. That argument is real and it is **not unconditional** — chat exports and folder imports
flow there too, and consumer Google is a different contracting entity from Google-Cloud-the-
processor.

## What the completeness check can and cannot establish

`test/register/completeness.test.ts` holds `docs/register.md` against the code, in both
directions, using three evidence sets the register does not author: every `http(s)://` host
named in `src/`, every provider a routing profile can reach, and every binding `wrangler.toml`
declares. **It does not read this file, and no gate does.** Everything below is therefore worth
knowing before anyone treats a green build as confirmation of this page.

What the check does establish: a new vendor that arrives as a hostname, as a routing provider,
or as a deployment binding turns the register red on the commit that adds it. That is a real
property and it is why the register is generated rather than remembered.

What it cannot establish, stated because it is the gap that matters most for *this* document:
**it cannot see a party reached only through configuration.** The three Google seats are the live
example. Their route records the provider as `cloudflare` and their host is Cloudflare's API;
the fact that Google serves them is encoded in the model id string and nowhere the sweeps look.
Google survives in the register today only because the *self-hosted* profile still reaches it
directly and still names its hostname in source. Withdraw that profile and the check does not
merely fall silent — it reports the Google entry as stale and invites its deletion, while every
extracted document keeps crossing to Google through the passthrough. A guard that can point the
wrong way is worth writing down rather than trusting.

So: the register is machine-checked, this list is not, and the passthrough relationships on it
are held in place by human review. `upstream/concepts.jsonl:gap.register-passthrough-vendor-blindness`
carries what would close the gap.

## What is *not* a subprocessor

- **A user's own model provider key (R22).** When a user brings their own key, their calls go to
  their own account at that provider under their own terms. It is their relationship, not ours,
  and it is named here so the distinction is explicit rather than assumed.
- **The control plane.** It holds ids, counters, timestamps, tier and secret references. There is
  no brain content in it, and that is enforced mechanically rather than promised
  (`test/control/schema.test.ts`).

**And one that is genuinely undecided rather than excluded.** `docs/register.md` names
`claude-client` — the assistant a user connects to their own brain — as a party user content is
transmitted to, because the answers to `recall`, `search` and `briefing` leave our trust boundary
into that client's context on every call. It is not a row above. Whether a user's own agent,
connected by their own grant, is a *subprocessor of ours* or simply the user reading their own
data is a legal characterization no document here has settled, and settling it quietly in a
published file is worse than naming it as open. It is named as open. The register and this list
are enumerating deliberately different sets until it is answered.
