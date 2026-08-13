# Privacy policy

**Effective:** 2026-08-13 · **Draft — for the hosted beta.**

This policy is written from the controller/processor determination in
`docs/plans/2026-08-13-003-u15-web-app-identity-billing-replan.md` §6, which was settled before
this document was drafted rather than after. R12 requires that order, and the reason is that the
determination decides what this policy can honestly say about a correspondent's request.

## The two roles, and why there are two

**We are the controller** for your account: your email address, your password credential, your
sessions, your subscription and its billing events, the per-brain counters (pending work, spend,
schema version) and the access log. We decide why those exist and how long they are kept. Nobody
instructed us to keep a spend counter; we keep it because we run a business.

**We are a processor, and you are the controller,** for everything inside your brain: the mail,
calendar events and files you connect or import, the passages and facts derived from them, and
the entity cards and commitments built on top. You choose which mailboxes to connect, which
folders to import and what to remember. We process on your instruction.

That includes **identifiable information about people who never signed up** — the people who
write to you and the people who attend your meetings. It is in your brain because it is in your
mail. We hold it as your processor.

We considered being the controller for brain content and rejected it, because it does not
survive being written down: a controller needs a lawful basis for every data subject, and we
would need one for every person who has ever emailed every user. There is no basis available.

## What we store, and where

- **Your account** lives in an identity database: your email address, a hashed password
  (argon2id), hashed session and reset tokens, your subscription state and the identifiers of
  billing events we have processed. We do **not** store the body of any billing event, your
  payment details, your IP address or your browser's user agent.
- **Your brain** lives in a Postgres project of its own, and its raw payloads and exports live
  under a storage prefix of its own. One project, one database, one role per user — the
  connection string is the isolation receipt.
- **The control plane** — the database that knows which brains exist and when they are due for
  work — holds ids, counters, timestamps, tier and references to secrets. It holds no content and
  no email address. That is enforced by a check rather than by a promise.

## Who else sees it

Everyone, in `docs/legal/subprocessors.md`. It is six parties, one of which (Stripe) never
receives brain content at all, and one of which (Pipedream) carries an unresolved question we
have named rather than answered.

## Model providers

Inference runs on our keys by default. Two providers receive brain content: one for embeddings,
which sees every passage, and one for extraction, enrichment and contradiction detection. Every
other model operation runs on open weights on our infrastructure provider's own hardware and
goes nowhere else.

**We do not train models on your content, and neither may our providers on our behalf.** Our
model gateway is configured to record metadata only — operation, model, token counts, cost, brain
id. Prompts and completions are not retained at the gateway or in our logs.

You may bring your own provider key. Those calls go to your account at that provider under your
own terms with them, and they are metered here only so your own spend cap and your own spend view
work.

## Your requests

Access, correction, export and deletion: from the app, or by writing to us. Export produces
markdown you can read without us. Deleting your account deletes the database, the stored files,
the control-plane row, the connector vendor's record of you, and any provider key you stored.

## If you are not our user

If you have written to one of our users, or attended a meeting with one, some information about
you may be in their brain. **We are their processor, not the controller of that information, and
we do not decide what happens to it — they do.** So:

1. Write to us and we will pass your request to the person whose brain holds it, without delay,
   and tell you we have.
2. We provide them the tools to answer it, including deleting information about you specifically
   from a brain that otherwise stays live, and we carry out their instruction.
3. We will not delete a user's records on a third party's say-so alone, because doing that would
   be deciding on their behalf what their own records are for.
4. We answer directly for what we control: whether you have an account with us is our question,
   and we will answer it.

We think this is the honest answer rather than the convenient one. The convenient answer —
"we'll delete it" — would mean acting as controller over records we have no lawful basis to
control.

## Security

Passwords are hashed with argon2id. Session and reset tokens are stored only as digests, so a
copy of our database contains nothing anyone can sign in with. Sessions expire both on inactivity
and absolutely. Every brain is a separate database reachable only by a credential scoped to it,
and neither our operator surface nor the web app can read those credentials.

## Changes

Material changes are announced before they take effect. This file's history is public.
