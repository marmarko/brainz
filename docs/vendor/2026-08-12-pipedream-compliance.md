# Vendor question — Pipedream Connect

**Status:** draft, not yet sent
**Owner:** founder
**Blocks:** Assumption 1 (Phase 0). A "no" on Q1 changes what alpha *is*, not just how it is built.
**Why it is asked in Phase 0:** it costs one email, and the answer can invalidate KTD6 before Phases 1–3 deepen the investment in it.

---

## What the answers decide

| Question | What it gates |
|---|---|
| Q1 — their OAuth apps for restricted Gmail scopes | Assumption 1. If no: the fallback is CASA-free scopes (Calendar/Contacts/Drive-picker) **plus** an MBOX mailbox-export path through U8's folder import. The alpha bar requires a mail source, connector-fed or export-fed — shipping alpha without one is a different alpha, not a degraded one. |
| Q2 — programmatic deletion with token revocation | R12's fourth erasure leg. Without it, live OAuth tokens to an erased user's mailbox persist at a vendor inside the trust boundary, and "no queryable trace" is false. |
| Q3 — whether message bodies transit Pipedream | Whether Pipedream's entry in our public register and subprocessor list reads "credential vendor" or "content processor". Materially different disclosure. |

Q1 and Q2 are blocking. Q3 is not blocking but should be asked in the same email — it is free to ask now and awkward to ask after the privacy policy is drafted.

---

## Draft

> **Subject:** Connect — production use of your OAuth apps for Gmail, and programmatic user deletion
>
> Hi,
>
> We're building a consumer product on Connect and want to confirm three things
> before we commit our architecture to it. Short questions, and precise answers
> would help us a lot.
>
> **1. Gmail restricted scopes under your OAuth apps.** For a production
> consumer app, can we use *your* OAuth apps for Gmail — specifically the
> restricted scopes needed to read message content — rather than registering our
> own client and completing CASA ourselves? If yes, is that generally available
> or does it need review/approval on your side, and is there anything about our
> use case that would exclude us? If we would eventually need our own client and
> CASA, we'd rather know the trigger now (user count, scope set, verticals) than
> discover it at launch.
>
> **2. Deleting an external user, including token revocation.** When we delete an
> external user via the API, does that revoke the underlying OAuth grants at the
> provider, or only remove them from your side? We need to be able to state, in a
> privacy policy, that account deletion leaves no live credential anywhere — so
> we're asking specifically whether revocation reaches Google, and what the time
> bound is. If revocation is a separate call, we'd like the endpoint.
>
> **3. Where message content flows.** When we fetch Gmail messages through
> Connect, do the message bodies transit your infrastructure, or do we call
> Google directly with a token you mint? This determines whether we list you as a
> credential provider or as a processor of end-user content in our public
> subprocessor list, and we'd like to get that right the first time.
>
> Happy to jump on a call if that's faster. For (1) and (2) we'd particularly
> value something we can cite internally rather than a verbal confirmation.
>
> Thanks,

---

## Where each answer lands in code (U9, 2026-08-13)

U9's substrate is built so that either answer is absorbable without a rewrite.
The three places an answer changes something:

| Answer | What changes |
|---|---|
| **Q1 — no** (their OAuth apps do not cover production restricted Gmail scopes) | `src/ingest/pipedream/sources/gmail.ts` is replaced, **and the MBOX route has one field to fill**. The adapters depend on `ProviderApi` — one method — so a replacement connector is a new `ProviderSource`, not a new pipeline, and `src/ingest/cursor.ts`, `junk.ts`, `pipedream/pull.ts`, `first-import.ts` and `log.ts` never mention Gmail. But an MBOX export arrives through U8's *import* runner rather than through a connector, and the junk gate lives on the item: whoever writes the MBOX parser must populate `ImportItem.junk` with the message's headers, or a consumer mailbox is chunked, embedded and priced with no bulk filtering at all — which `src/ingest/junk.ts` calls the single largest avoidable cost in the product. The gate itself is shared (`gateJunk`, reached by both runners), so this is a field to fill rather than a path to build. **The fallback is deliberately not built** — building it before the answer arrives would be a second mail path to maintain for a question one email settles. |
| **Q2** (programmatic external-user deletion with token revocation) | `PipedreamClient.deleteExternalUser` in `src/ingest/pipedream/client.ts` already makes the call R12's fourth erasure leg needs, and classifies the answer on its own terms: a 404/410 is `already_absent`, a 202 is `accepted` (queued, **not** `deleted`), and only a 2xx that says the record is gone reports `deleted: true`. What it reports for revocation is `tokensRevoked: 'unverified'`, and a test pins that string: promoting it to `'confirmed'` without a written vendor answer would put a false sentence in a privacy policy. When the answer arrives, change the literal and the test together. **The method has no caller in `src/` and deliberately so** — wiring the erasure pipeline is U17's, and half a pipeline here would be worse than the gap. |
| **Q3** (whether message bodies transit Pipedream) | Only prose: R10's register entry and U15's subprocessor list read "credential vendor" or "content processor". No code depends on it. The vendor's URL and header shape for the proxied call is a separate unverified detail, confined to `providerUrl` and `connectionHeaders` in `client.ts`. |

## Recording the answer

Write the reply into this file under a `## Answer (YYYY-MM-DD)` heading, verbatim
where it matters. Then update:

- **Assumption 1** in the plan — mark verified, or take the priced no-branch.
- **R12 / U17** — confirm or correct the erasure leg's description.
- **R10 register + U15 subprocessor list** — set Pipedream's classification from Q3.
- **`client.ts`'s `ExternalUserDeletion.tokensRevoked`** — and its test.
