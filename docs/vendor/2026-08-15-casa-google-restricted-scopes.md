# Dated dependency — CASA, and brainz's own Google OAuth application

**Status:** not started, and deliberately not started by U18.
**Owner:** founder.
**Blocks:** removing Pipedream from the trust boundary for mail (R10's subprocessor list, R16's exit ramp).
**Blocks nothing else.** In particular it is on **no launch critical path** — see "What it does not gate".
**Start by:** Phase 4 start, per the roadmap's U18 execution note. Lead time is 3–4 weeks and it renews annually, so a start date is the whole point of writing this down.

---

## What it is

**CASA** — Cloud Application Security Assessment — is Google's annual third-party
security assessment required of an OAuth application that requests **restricted
scopes**. Gmail message-body access is a restricted scope. So an application
that reads a user's mail must hold a current assessment, every year, for as long
as it reads mail.

Published cost band: **~$540–1,800 per year**, tiered by how the application is
assessed. Lead time: **3–4 weeks**. It is an invoice and a calendar item, not an
engineering task, and it cannot be compressed by working harder on it.

---

## What it gates, precisely

| Gated by CASA | Not gated by CASA |
|---|---|
| brainz's **own** Google OAuth application requesting Gmail restricted scopes | Gmail through **Pipedream's** OAuth application — Pipedream holds the assessment. This is the alpha and beta path and it is unchanged. |
| Removing one row from R10's register and one name from the subprocessor list | Calendar and Drive under non-restricted scopes, which take a lighter review |
| The claim "brainz holds your mail grant directly" | Microsoft connectors, which are a separate Microsoft review and not CASA at all |
| A second annual renewal, forever | Anything in Phases 0–4 |

### What it does not gate

The roadmap's Claude-first decision already records the general form of this:
*"OpenAI app review has no published SLA and must not gate v1."* CASA is the same
shape with a price attached. Concretely:

- **Alpha and beta ship without it.** Connectors authenticate through Pipedream's
  OAuth applications (R16), which is what the whole vendored-connector decision
  bought: real data early *without* CASA on the critical path.
- **The code path exists and is inert.** `src/ingest/oauth/seam.ts` defines the
  `ConnectorAuth` port with two implementations — `pipedreamAuth` (today, and
  observably identical to calling the client directly) and `ownOAuth`, which
  refuses every call with a typed blocker naming what is missing. No OAuth
  application is registered by that unit.
- **The cutover is per-source and reversible.** A source moves only when it is
  marked certified in fleet config **and** the tenant has granted through the
  brainz application — fleet fact first, so un-marking the source rolls every
  tenant back with no tenant write. The ordering is pinned by
  `test/ingest/oauth-seam.test.ts`.

---

## Two consequences that are easy to miss

**1. Own-OAuth tokens change R12's fourth erasure leg.** U17's account-erasure
runbook has five legs, the fourth being "Pipedream external-user deletion with
token revocation" — without it, live OAuth tokens to an erased user's mailbox
persist at a vendor inside the trust boundary and "no queryable trace" is false.
If brainz holds its own refresh tokens, that leg must cover them **on the day the
swap happens**. This is why `ConnectorAuth` carries `deleteExternalUser` rather
than leaving it on the vendor client: one leg, two implementations, **no sixth
store**.

**2. Own client secrets are R10 register entries, and they are bigger than what
they replace.** A Google OAuth client secret held by the fleet is a
platform-scoped credential whose blast radius is every tenant who granted through
it — strictly *larger* than the Pipedream project key it replaces, because it is
the mint rather than a vendor's mint. Registering the application is therefore a
register change and a rotation-owner decision, not a config edit, and that work
belongs in the same change as the registration rather than after it.

The net effect on the subprocessor list is a trade, not a pure reduction: one
vendor comes off, and one fleet-held credential with a wider blast radius goes on.
That is still worth doing — the vendor sees message *content* and the credential
does not — but it should be decided with both halves visible.

---

## Status of this document

Nothing has been submitted, no application has been registered, and no fee has
been paid. This unit reports CASA as **deferred**, reason: an external paid
assessment with a real invoice and an annual renewal.

The point of writing it now is the date. Discovering a four-week lead time in a
launch week is the failure this file exists to prevent.
