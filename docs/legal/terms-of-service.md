# Terms of service

**Effective:** 2026-08-13 · **Draft — for the hosted beta.**

Plain terms for a product whose whole claim is that you can check what it does. Where a term
here would be contradicted by the code, the code is public and you should believe the code.

## 1. What the service is

A personal knowledge brain. You connect accounts or import files; we ingest, index and
periodically consolidate what arrives; your assistant reads it over MCP. There is no other way
in — the brain is consumed over the protocol, not through a chat window we operate.

## 2. Your account

One person, one account. You are responsible for your credentials. We will never ask you for your
password, and no part of our system can read it: we store a one-way hash.

Signing in with a third-party identity provider does **not** merge into an existing account that
happens to share an email address. If a collision happens you will be asked to sign in to the
existing account first. This is deliberate and it is not negotiable at a support desk: the whole
of somebody's mail is behind that door.

## 3. Plans

**Free** includes chat-export and folder import, retrieval, and the deterministic half of
consolidation — deduplication, link reconciliation, staleness marking, rule-based entity merging,
deterministic salience and clustering. A free briefing says what a paid one would add rather than
being quietly thinner.

**Paid** adds the model-driven consolidation phases — extraction, entity enrichment, synopsis,
contradiction reporting, refined salience — and connected accounts.

**Connected accounts are paid-only**, and the reason is a cost rather than a capability: each
connected mailbox carries a per-user monthly fee from our connector vendor whether or not you use
the brain. We would rather say that than imply we are holding a feature back.

Changing plan changes what runs, not what you keep. Downgrading stops the model phases; it does
not delete anything they produced.

## 4. Billing

Subscriptions are billed by our payment processor. Cancel at any time; the paid tier runs to the
end of the period you have paid for. We do not see or store your card details.

## 5. Model spend and your own keys

Consolidation makes model calls and those calls cost money. Every call is metered against your
brain and visible to you, and every brain carries a spend cap. You may supply your own provider
key, in which case those calls are billed to you by that provider and metered here only so your
own cap and your own view work.

## 6. What you may put in

Content you have the right to put in. You keep everything you own; we claim no licence beyond
what running the service requires — storing it, indexing it, transmitting it to the
subprocessors listed at `docs/legal/subprocessors.md`, and deriving the artifacts the product is.

**Note what that includes.** A brain fed from a mailbox holds information about other people. You
are the controller of that information. If one of them asks us about it we will pass the request
to you, give you the tools to answer it, and carry out your instruction — we will not decide it
for you, and we will not ignore it. See the privacy policy.

## 7. What we do with instructions inside your content

Content that arrived from outside — mail, calendar invitations, shared files, and anything
derived from them — is returned to your assistant inside an untrusted-data marker. A message in
your inbox does not get to issue instructions to your assistant by being ingested. We do this
because the alternative is a product where anyone who can email you can act through your
assistant.

## 8. Availability

Beta. We will try hard and we do not promise an uptime figure we have not measured.

## 9. Export and deletion

Export produces markdown you can read and re-import elsewhere, with no lock-in and no proprietary
format. Deleting your account removes your database, your stored files, your control-plane row,
the connector vendor's record of you, and any provider key you stored.

**What that does not establish, said here rather than left to be assumed.** Removing the connector
vendor's record of you is a deletion at that vendor. Whether it also ends the permission you gave
at the account you connected — your mail provider — is a question we have put to them and have not
had answered in writing. So we do not claim it. Our deletion receipt reports that point as
unverified rather than as done, and if you want the certainty now, remove our app from your
provider's own connected-applications settings as well.

The deletion window is bounded by our database provider's point-in-time-recovery period, which the
privacy policy states.

## 10. Ending it

You may stop at any time. We may suspend an account for non-payment, or one being used to attack
the service or another user, and we will tell you why.

## 11. Liability

To the extent the law allows, our liability is limited to what you have paid us in the previous
twelve months. Nothing here limits liability that cannot be limited.

## 12. The software

The server core is AGPL-3.0 and public. These terms cover the hosted service, not the licence —
that is in `LICENSE`, and it governs.

## 13. Changes

Material changes are announced before they take effect. This file's history is public.
