# U15 re-plan — Web app, identity, billing

**Date:** 2026-08-13
**Unit:** U15 (Phase 4), per `docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`
**Why this file exists:** U15's execution note calls the unit milestone-grade and names four things the
re-plan must cover — **web-app session management, Stripe webhook signature verification,
account-takeover posture, and the free-tier connector cost decision**. It also owes the **R2a connect
mechanism**, verified against the target client's real UX before building, and the **controller/processor
determination for non-user PII (R12)**, settled before the privacy policy is drafted rather than after.
This is that re-plan. It is a sibling file rather than an edit to the roadmap's body, so the roadmap stays
the record of what was planned and this stays the record of what was found and decided.

---

## 1. The connect flow — R2a's prohibition, and the mechanism that replaces it

R2a forbids "paste this URL into settings". Until this unit that is exactly what the alpha required, and a
previous pass named it the predicted first-abandonment point for the non-technical testers the alpha exit
depends on. The roadmap says the mechanism must be *named and verified against the target clients' actual
custom-connector UX before building*. Research date **2026-08-13**.

### 1.1 What was found

**There is a documented install deep link, and it is official.** Anthropic documents it under the heading
"Share an install link" and frames it as the thing you put behind a "Connect to Claude" button on your own
site:

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=NAME&connectorUrl=ENCODED_URL
```

`modal` must be `add-custom-connector`; `connectorName` is the display name; `connectorUrl` is the MCP
server URL, percent-encoded. The org-admin variant is
`https://claude.ai/admin-settings/connectors?modal=add-custom-connector&…`.
Source: [claude.com/docs/connectors/building/directory-vs-custom](https://claude.com/docs/connectors/building/directory-vs-custom),
section "Share an install link". Provenance:
[anthropics/claude-ai-mcp#74](https://github.com/anthropics/claude-ai-mcp/issues/74), filed 2026-02-28,
closed `completed` **2026-05-13** by an Anthropic collaborator.

**It is prefill, not one-click, and the docs say so in as many words:** *"Install links only prefill the
form. They do not bypass review by the user, and they do not grant your server any permissions the user has
not confirmed."* The user sees the dialog pre-filled plus an external-source notice, clicks **Add**, then
clicks **Connect**, then authorizes. The second click is a known rough edge —
[claude-ai-mcp#542](https://github.com/anthropics/claude-ai-mcp/issues/542) (opened 2026-07-04, no vendor
reply) asks for OAuth to auto-start after Add.

**Custom connectors are available on Free, Pro, Max, Team and Enterprise**, with Free limited to one custom
connector, and they surface on claude.ai, Desktop and mobile (Team/Enterprise require an Owner to add the
connector before members connect). Sources:
[support 11175166](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[support 11176164](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities).
**This retires the moved Outstanding Question** ("do remote MCP connectors surface on claude.ai web and
mobile?") in the favourable direction: the beta's reachable stranger is not limited to someone who already
runs a desktop app or a developer CLI, and U15's funnel is not being designed against the wrong user.

**Once the URL is in the client, everything else is automatic.** claude.ai runs RFC 9728 then RFC 8414
discovery against the server origin, sends PKCE `S256` and the RFC 8707 `resource` parameter, and supports
DCR, CIMD or a pre-registered client. Claude Code does the same and adds `claude mcp login <name>`.
Sources: [connectors/building/troubleshooting](https://claude.com/docs/connectors/building/troubleshooting),
[code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp). `src/mcp/oauth.ts` already serves both
discovery documents, so the server side of this needs nothing new.

**Three paths that do not work and are not worth waiting for.** `.mcpb`/`.dxt` Desktop Extensions declare
only `node`/`python`/`binary`/`uv` server types — there is no field for a remote HTTP endpoint, so a remote
server can only ship as a local stdio proxy, which is Desktop-only and forfeits web and mobile
([MCPB MANIFEST.md](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)). No MCP-spec
install mechanism has landed: SEP-1649 (server cards) and SEP-1960 (`.well-known/mcp`) are both closed
without being accepted, and the official MCP Registry is in preview and explicitly *"not intended to be
directly consumed by host applications"*. And the Anthropic connector **directory** (which would give a
`claude.ai/directory/connectors/<slug>` page with its own Connect button) requires a Team or Enterprise
organisation to submit and passes Anthropic review
([building/submission](https://claude.com/docs/connectors/building/submission)) — a fine Phase-5
discoverability play, not a beta dependency.

### 1.2 Decision

**Build the install link.** `src/web/connect.ts` mints
`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=brainz&connectorUrl=<percent-encoded /mcp URL>`
behind a "Connect to Claude" button, plus a `claude mcp add --transport http brainz <url>` one-liner with a
copy button for Claude Code. **The URL is never displayed as something to transcribe** — R2a's prohibition
is about the *user action*, not the string, so the string may appear as fallback copy and must not be the
primary instruction.

**Honest copy is part of the mechanism.** The UI says what actually happens — Add, then Connect, then
authorize, and Claude will show a notice that the values came from an external link — because a "one click"
promise followed by three clicks is its own abandonment point. The vendor calls this prefill; so do we.

**The step we own is verification, not instruction.** The web app does not fire-and-forget. After the user
follows the link, the connect page polls a small status endpoint that reports whether *this tenant* has
completed an OAuth grant against `/mcp`, and flips to "connected" when it has. That turns the guided flow
from a page of instructions into a step with an observable end state, and it is the half of R2a that no
vendor feature can supply.

**What is deferred and why:** whether the `claude.ai` link opens inside the Desktop app or the mobile apps
is undocumented, and whether custom connectors can be *added* (rather than used) from mobile today is
contradictory in Anthropic's own pages — the support article says "installing connectors on mobile is
currently in beta", secondary summaries say it is web/Desktop only. Both are `deferred: needs a real client
on each surface`. Neither changes the mechanism: connectors added on web sync to Desktop and mobile.

---

## 2. Web-app session management

**Decision: server-side opaque sessions, stored as a SHA-256 digest, in an httpOnly cookie.** Not a JWT.

- **Token:** 32 bytes from the platform CSPRNG, base64url. The database stores `sha256(token)` only —
  the same rule `src/mcp/oauth.ts` applies to refresh tokens, for the same reason: a store that holds a
  usable credential turns one database read into every live session.
- **Cookie:** `bz_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`. `Lax` rather than `Strict` because the
  OAuth consent redirect and the Stripe checkout return are both top-level cross-site navigations that must
  arrive authenticated; `Lax` permits those and refuses cross-site POSTs, which is the shape we need.
- **Two expiries, not one.** Absolute 30 days from issue, idle 7 days from last use. An absolute-only bound
  keeps a stolen cookie alive for its whole window; an idle-only bound never expires for an active thief.
- **Rotation on privilege change.** The session id is rotated on login and on password change, and *every*
  session for the account is invalidated on password reset. Session fixation is the attack the first
  prevents; "I changed my password so I'm safe now" is the belief the second makes true.
- **Why not a JWT.** A self-contained token cannot be withdrawn, and this cookie fronts a brain full of the
  user's mail. `oauth.ts` accepts that trade for MCP access tokens because the control plane holds no grant
  table and rotating the bearer invalidates everything at once; the web app has its own store and no such
  constraint, so it takes the revocable option.
- **CSRF.** `SameSite=Lax` plus an explicit origin check on every state-changing request: `Origin` must
  equal the app's own origin, and a request that carries no `Origin` on a state-changing method is refused
  rather than trusted. No framework, no hidden-field token, one testable function
  (`src/web/router.ts:sameOriginRefusal`). The webhook endpoint is exempt by construction — it is
  authenticated by signature, not by cookie, and it is registered on a path the cookie router never guards.

---

## 3. Stripe webhook signature verification

**Decision: implement the documented scheme in-repo, verify before parsing, and treat replay as a
first-class case with two independent controls.**

Stripe sends `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]…`. The signed payload is
`` `${t}.${rawBody}` ``; the signature is HMAC-SHA256 of that string under the endpoint's signing secret
(`whsec_…`), hex-encoded. Multiple `v1` entries appear during secret rotation and **any** match is
sufficient.

The rules this repo implements, each written as the failure it refuses:

1. **Verify the raw bytes, then parse.** The signature covers the body as sent. A handler that parses JSON
   first and re-serialises later is verifying a string Stripe never signed, and a handler that parses first
   *at all* is running a JSON parser on unauthenticated input.
2. **Constant-time comparison**, over digests of equal length, the same shape `oauth.ts` uses.
3. **Timestamp tolerance, 300 seconds, both directions.** Stripe's own libraries bound age only; we also
   refuse a timestamp far in the future, because a clock-skewed or attacker-chosen future `t` would
   otherwise make one captured request replayable for as long as the attacker chose.
4. **Event-id idempotency.** `account.billing_event` has a unique index on the event id; a second delivery
   of the *same* event is recorded as a duplicate and applies nothing. Tolerance alone does not cover this:
   a genuine, correctly signed, in-window delivery arriving twice is normal Stripe behaviour, not an attack,
   and a tier transition applied twice is a real bug.
5. **The signing secret is a platform credential**, injected at construction from the secret store, never
   read from a request and never defaulted to an empty string. An empty-secret default makes every forged
   signature verifiable against a deterministic HMAC, which is the exact way this control fails silently.
   It takes a row in the register and in the subprocessor list.
6. **No raw event payload is stored.** The control-plane content-free guard would refuse a `jsonb` column
   anyway; what is kept is the event id, the dotted event type, and the moment it was processed.

**No live Stripe account, no live keys, no test-mode API calls were used.** Verification is tested against
synthetic signatures computed in the test from a synthetic secret — including a forged one (right shape,
wrong secret), a tampered body, a stale timestamp, a future timestamp, a duplicate delivery, and a rotation
header carrying one bad and one good `v1`.

---

## 4. Account-takeover posture

This is the section to take seriously: OAuth account linking is where "sign in with Google" silently merges
into an existing password account, and a brain full of the user's mail is the payload.

### 4.1 The attack

An attacker signs up with **the victim's** email address and a password of their choosing. They never verify
the address — they cannot, they do not control the mailbox. Later the victim arrives and clicks "Sign in
with Google". A system that links provider identities to accounts **by email equality** now hands the victim
the attacker's account: the victim connects their real Gmail, the brain fills with their mail, and the
attacker logs in with the password they set. Nothing looks wrong to anyone.

### 4.2 The rules

1. **The link key is `(issuer, subject)`, never the email.** A provider's `sub` is stable; an email is a
   changeable attribute. Keying on email means a provider-side email change re-points the link.
2. **Email equality never auto-links.** If the provider identity is unknown and an account already exists
   with that email, the outcome is `link_required` — the user must authenticate into the existing account
   (password, or an existing session) before the identity is attached. This is the whole control.
3. **`email_verified` is required in both directions.** Even after the user authenticates into the existing
   account, a provider that does not assert `email_verified: true` cannot attach an identity claiming that
   address. A provider assertion is not a substitute for our own verification and our own verification is
   not a substitute for theirs.
4. **A fresh signup through OAuth is verified only if the provider says so.** An account created by an
   unverified provider identity starts unverified and cannot later absorb a colliding password account.
5. **An unverified local account cannot block a verified one forever** — but the remedy is a support-side
   reclaim with proof of mailbox control, not an automatic merge. Written down because "just link it, they
   own the mailbox" is the sentence that reintroduces the attack.

### 4.3 Password reset

- **Uniform response** whether or not the address exists. A reset endpoint that says "no such account" is a
  free account-enumeration oracle on a product whose users are identified by their work email.
- **Single-use, hashed, 30-minute token**, stored as `sha256` exactly like the session token, consumed by a
  compare-and-set so two clicks on the same mail produce one reset.
- **Every session for the account is invalidated on use**, and the password credential is replaced in the
  same transaction.
- **Reset does not verify the email.** A reset proves mailbox control at that moment, and it is tempting to
  promote the account to verified on the strength of it. It is refused here: the attacker in §4.1 controls
  the account but not the mailbox, and there is no path by which their reset request should ever succeed —
  so a design where a successful reset means anything about verification is a design where the attacker's
  half-account gains status from a flow they cannot complete. Verification stays its own flow.

### 4.4 Passwords

`Bun.password` (argon2id, in Bun's standard library — no new dependency, which the unit's constraints
require). Hash parameters are injectable so tests do not pay production memory cost, and the stored hash is
self-describing (`$argon2id$v=…$m=…`), so a later parameter bump re-hashes on next successful login rather
than forcing a fleet-wide reset.

---

## 5. The free-tier connector decision

**The Outstanding Question, verbatim:** *"does the free tier include OAuth connectors? Pipedream bills ~$2
per external user per month plus polling-driven embedding spend, so a connector-enabled free user costs
roughly 20× R13's idle anchor before any model call. This is a unit-economics decision, not an engineering
one."*

**Decision: connectors are paid-only. The free tier is chat-export and folder import (R8a), plus the
deterministic consolidation phases (R8).**

The reasoning, in the order that decides it:

1. **The vendor fee is recurring and does not decay with use.** R13's whole claim is that an idle user costs
   ≈ $0.105/month because computes suspend and nothing runs. A free user who connects Gmail once and never
   returns still costs ~$2/month at the connector vendor, forever — about **20×** the idle anchor, on a
   tenant that generates no signal at all. That is not a cost that gets better at scale; it gets worse
   linearly, and it invalidates the sentence R13 exists to make true.
2. **The free tier still has a defined, non-empty job**, which is exactly why R8a exists. Chat-export and
   folder import carry no per-user connector fee, and they are the one ingestion path the free tier
   guarantees. A free brain is a real brain with real content in it.
3. **The free tier is not free of cost, and that is already handled.** R8a prices a 50k-chunk first import at
   ~$2.60 of embedding spend and puts R14's first-import gate on that path. So the free tier's spend is
   *bounded and one-time*; the connector fee is *unbounded in time*. That asymmetry is the decision.
4. **A trial was considered and rejected for beta.** "Connectors free for 14 days" is the obvious middle,
   and its cost is not the fee — it is that the trial-expiry path must delete the Pipedream external user
   and revoke its tokens to stop the meter, which puts R12's fourth erasure leg on an automated timer before
   that leg has ever been verified end to end (`tokensRevoked` still reports `unverified`, per
   `src/ingest/pipedream/client.ts`). We are not putting an unverified revocation on a cron before beta.

**What the code does with it.** `connectSource` refuses on the free tier with a typed
`tier_required` refusal and honest copy that names the actual reason — a per-user vendor fee, not a
capability we are withholding — and points at the import path that is included. The upgrade prompt reads the
deterministic `pending_debt` counter, per R8, never a contradiction count.

---

## 6. Controller/processor determination for non-user PII (R12)

R12 says beta owes this determination, that it *"decides how brainz answers a correspondent's data-subject
request"*, and that it must be settled **before the privacy policy is drafted, not after**. It is settled
here, and §7's privacy policy is written from it.

### 6.1 The determination

**Two roles, split by data category, and the split is the point.**

- **brainz is the controller** for account and operational data: the email address, the password credential,
  sessions, the subscription and its billing events, the per-tenant counters (debt, spend, schema version),
  and the access log. brainz decides why these exist and how long they are kept. Nobody instructed us to
  keep a spend counter; we keep it because we run a business.
- **brainz is a processor, and the user is the controller,** for everything in the brain: ingested mail,
  calendar events and files, the chunks and facts derived from them, the entity cards and commitments built
  on top, and therefore **the identifiable content about correspondents and meeting attendees who never
  signed up**. The user chooses which mailboxes to connect, which folders to import, and what to `remember`.
  brainz processes on their instruction.

**Why not controller-for-content.** It is the alternative and it is untenable rather than merely
unattractive: a controller needs a lawful basis for every data subject, and brainz would need one for every
person who has ever emailed every user. There is no basis available — not consent (we cannot ask them), not
contract (they have none with us), and legitimate interest fails a balancing test we would be conducting on
behalf of a mailbox we chose to read. The processor determination is not the convenient answer; it is the
only one that survives being written down.

**The honest caveat, stated rather than buried.** The user is very often a natural person processing for
purely personal purposes, for whom GDPR's household exemption (Art. 2(2)(c)) means they carry no controller
obligations at all. That exemption does not extend to brainz — the CJEU line is that a provider of the means
is not covered by another party's household exemption — so brainz's processor obligations are real even
where the controller's are not. This is why §6.2 does not end at "we forward it to the user".

### 6.2 How brainz answers a correspondent's data-subject request

A correspondent who never signed up writes to us and asks what we hold about them, or asks for erasure. The
determination decides the shape of the answer:

1. **We do not decide it, and we say so.** A processor that unilaterally erased a controller's records would
   be determining purposes — the definition of a controller — and would be silently deleting evidence from
   someone's brain on a stranger's say-so.
2. **We route it without delay** to the controlling user, identified by which tenants hold rows whose origin
   includes that correspondent identifier, and we tell the requester we have done so and who the controller
   is.
3. **We provide the tooling that makes the controller's answer executable** — the subject-scoped erasure path
   — and we execute on their instruction, with a receipt and a time bound.
4. **We answer directly for the data we control**: whether that correspondent is an *account holder* here is
   our question, not theirs, and we answer it.
5. **The one case we act on alone** is a request about data we hold outside any tenant — there is none by
   design, and saying so is the point of a content-free control plane.

### 6.3 What this commits U17 to

U17 owns the paired subject-scoped erasure path. This determination is the one it must implement against,
and it fixes four properties:

- **Keyed on a correspondent identifier, not a tenant.** Every one of the five account-erasure legs drops a
  whole tenant; a third-party request has nothing to run against a brain that stays live.
- **Spanning derivation, not just rows.** Neon rows whose `origin_context` includes that correspondent, the
  entity cards and commitments *derived* from them, R2 raw payloads, and the re-derivation that follows. A
  path that deletes the mail and leaves the entity card has deleted nothing that matters.
- **Invocable by the controlling user, out of band.** It is a web-app and panel action, never an `/mcp` tool
  the connected agent can issue — R12a's rule, applied here because the assistant that would issue it is the
  assistant reading the correspondent's mail.
- **Tombstoned against re-ingestion.** This is the property most likely to be missed and it is the one that
  decides whether erasure is real: the next connector poll will happily re-ingest the same correspondent's
  messages from the same mailbox. Erasure must write a tombstone the pull path consults, or the deletion is
  undone on a cadence and the receipt we handed the requester becomes false within the hour.

---

## 7. Legal surface

`docs/legal/terms-of-service.md`, `docs/legal/privacy-policy.md`, `docs/legal/subprocessors.md`. The privacy
policy is written from §6 and is drafted after it, in that order, as R12 requires.

The subprocessor list per R10 names **Pipedream** (connector credential vendor), **Neon** (per-tenant
database), **Cloudflare** (fleet host, container platform, object storage, and AI Gateway transport for
every model call — the broadest >1-user component, and it carries its own entry rather than being treated as
invisible substrate), **Stripe** (billing; account and payment data only, never brain content), and **the
two model-side processors**: OpenAI (embeddings — sees every chunk) and Google (extraction, enrichment,
contradiction detection). Every other content-touching model op stays on Cloudflare's hosted plane per
KTD13, and the list stays this short only as long as that holds. Adding a third-party model row is a
register change *and* a subprocessor-list change, which is what makes that cost visible before it is paid.

One open item is carried into the list rather than resolved by it: the roadmap's deferred question of
**whether Pipedream proxies message bodies through its own infrastructure or brainz calls Google directly
with a Pipedream-minted token** decides whether Pipedream's entry reads "credential vendor" or "content
processor". The entry says both, marked unresolved, with the question named. A subprocessor list that
guesses is worse than one that admits.

---

## 8. The warm pool, and why it ships unsized

KTD9: pool projects provision language-neutral and take their FTS config at assignment. That is not a
preference here, it is forced by the mechanics — `src/schema/fts-language.ts` substitutes the language into
the DDL at apply time and refuses DDL that still carries the placeholder, so a pool project **cannot** have
the tenant schema applied in advance. What the pool can pre-pay is the slow half: Neon project, branch, role
and database. Schema application, first query and the bearer mint happen at assignment, with the language
the user chose.

**The pool is sized by U2's committed benchmark, and there is no committed benchmark.** The harness exists
(`src/control/benchmark.ts`), the 100-provision run exists (`test/control/provision.real.test.ts`), and it is
gated on `BRAINZ_REAL_SUBSTRATE` + `NEON_API_KEY`, which this unit may not set — every run creates billable
Neon projects. So:

- **`poolTarget` has no default.** `createWarmPool` requires it, and refuses a construction that omits it,
  the same way KTD9 refuses a defaulted FTS language: a pool sized by a number nobody chose is the silent
  fallback in a different costume.
- **Zero is a legal, meaningful value** — it means "provision synchronously", which is exactly U2's alpha
  behaviour, and it is what the web app runs with until a receipt exists.
- **Reported `deferred`:** pool sizing needs the real-substrate benchmark. When the receipt lands, the number
  is a config change and nothing else.

---

## 9. Deviations from the roadmap's stated shape

- **`src/web/` rather than `apps/web/`.** `tsconfig.json` includes `src`, `test` and `scripts` only, and the
  unit's constraints forbid modifying it. Code under `apps/` would be neither typechecked nor reachable by
  the guards that scan `src/**` — a worse outcome than a differently-named directory. `src/README.md` gains a
  row.
- **Server-rendered HTML with a small inline script, not a compiled SPA.** Adding a web app without touching
  `package.json` means no bundler and no framework. The API is the real deliverable and is fully typed and
  tested; the pages are rendered from typed data by functions in `src/web/pages.ts`. Stated as a limitation
  rather than sold as a virtue.
- **`/admin` is a web-app surface, not an MCP `Endpoint`.** `src/mcp/tools/index.ts` declares
  `ENDPOINTS = ['mcp', 'openai']`, and that file belongs to another unit this one may not modify. R11's CI
  case therefore lands as: an admin scope table that *recognises* every one of the nine tool names and
  refuses the content-reading ones with `scope_denied` (a refusal on a name it knows, not an `unknown_tool`
  on a name it never heard of), **plus** the containment assertion that matters more — the same admin
  credential driven through the real `dispatch()` from `src/mcp/dispatch.ts` is refused *and opens no tenant
  database connection*, and `secrets.resolve` refuses it at the layer below the tool surface. R11 says in as
  many words that a `scope_denied` on `recall` proves nothing if the same credential can read the connection
  string and connect directly; both halves are asserted.
- **Export config is a surface, not a store.** R18's scheduled self-export destination is a URL and a
  credential — unstorable in any schema under the control plane's content-free rule, and its home is U17's
  lifecycle rung, which is a tenant rung this unit may not add. The web app ships the affordance and a typed
  `not_yet` response naming U17.

---

## 10. Verification, and what cannot be verified here

**Verified in this unit**, against a real Postgres, with each guard mutated and observed to die for the
stated reason: webhook signature verification including a forged signature, a tampered body, a stale and a
future timestamp, a duplicate delivery and a rotated secret; the tier flip end to end from a synthetic
`customer.subscription.updated` event through the control-plane row into a real consolidation cycle, asserted
**differentially** — zero gateway calls after a downgrade and non-zero on the paid side of the same test;
OAuth linking against a colliding email; `/admin` scope refusal on a recognised tool name plus real-dispatch
containment; sessions, reset, CSRF origin refusal; the warm-pool claim under concurrency; and the
content-free guard applied to the new identity schema with its own prose and secret probes.

**Reported `deferred`, with reasons. No live Stripe call, no live paid model call, no deployment, and no
cloud resource is created by this unit:**

- **Stripe end-to-end** (checkout, portal, real webhook deliveries, real signature from Stripe's own signer).
  Deferred: needs a live Stripe account. The verifier is built against the documented contract and tested
  against synthetic signatures; what is *not* established is that Stripe's production header matches our
  parser in some detail the docs omit.
- **Warm-pool sizing.** Deferred: needs the real-substrate benchmark (`BRAINZ_REAL_SUBSTRATE`,
  `NEON_API_KEY`); every run creates billable Neon projects.
- **The install link's behaviour on Desktop and mobile**, and whether custom connectors can be *added* from
  mobile today. Deferred: needs a real client on each surface. Anthropic's own pages conflict on the second.
- **Whether Anthropic's prefilled-dialog parameters are stable.** The link is documented and dated; it is
  still a vendor URL shape we do not control. `src/web/connect.ts` keeps it in one function with the doc URL
  beside it.
- **Pipedream's content-processor status** (does it proxy message bodies?). Deferred: needs the vendor answer
  drafted at `docs/vendor/2026-08-12-pipedream-compliance.md`. The subprocessor entry names the question
  rather than guessing the answer.
