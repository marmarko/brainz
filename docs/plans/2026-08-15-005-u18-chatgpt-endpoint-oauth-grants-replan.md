# U18 re-plan — ChatGPT endpoint, own OAuth/CASA, context grants

**Date:** 2026-08-15 · **Unit:** U18 (Phase 5) · **Requirements:** R2 (expansion), R15 (grant side), R16 (exit ramp)
**Roadmap:** `docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md` §U18 — *"Milestone-grade — re-plan
before execution; start CASA paperwork at Phase 4 start."* This is that re-plan. It is a sibling document;
the roadmap body is unedited.

Two siblings are load-bearing here and are read rather than restated:
`docs/plans/2026-08-13-003-u16-isolation-proofs-replan.md` (the attestation and the canary this unit must not
weaken) and `docs/plans/2026-08-15-004-u17-export-backup-lifecycle-replan.md` (whose §on blast radius built
the two-column severance preview this unit is the caller for).

---

## 1. What the roadmap asked for, and what U6 already built

The roadmap's approach line reads as four items. Three of them turn out to be partly built already, and
knowing which parts changes the shape of the unit completely.

| Roadmap item | State on 2026-08-15 |
|---|---|
| `/openai` endpoint with mandated `search`/`fetch` shapes | **Built at U6.** `ENDPOINTS = ['mcp','openai']`, `/openai` routed in `src/mcp/server.ts`, `search`/`fetch` are projections of `recall` in `src/mcp/tools/read.ts`, and a mandated-shape assertion exists in `test/mcp/dispatch.test.ts`. |
| Equivalence suite vs `/mcp` | **Two tests, not a suite.** One compares `fetch` against `recall({id})` for body and title; one asserts the `/openai` search result has exactly `{id,title,url}`. Neither drives from the blocking corpus, neither compares the *ranked* id lists, neither touches refusals, and neither pins the wire contract. |
| Own Google/Microsoft OAuth replacing Pipedream | **Nothing.** `src/ingest/pipedream/sources/types.ts` was *designed* for the swap ("the Phase 5 own-OAuth swap is a new implementation of `ProviderSource` rather than a change to the pull runner") but the auth half has no seam at all — `src/ingest/pipedream/client.ts` is reached directly. |
| Work/personal dual grants, `allowedOrigins` fence | **The fence exists; the grant does not.** `GrantClaims.origins` narrows reads and `test/mcp/dispatch.test.ts` proves it on four tools. But **no product path mints a narrowed grant** — `handleAuthorize` hardcodes `origins: []`. Every narrowed token in this repo is minted by a test helper. |
| Severance flow with preview | **Preview only.** `previewSeverance` in `src/core/lifecycle/blast-radius.ts` is called by nothing in `src/`; the ledger row `gap.data-lifecycle` says so in those words. |

So this unit is **not endpoint construction**. It is: make the narrowed grant real and provable, turn two
tests into a suite that would catch a divergence, give the preview a caller, and cut the auth seam.

---

## 2. Research — the mandated shapes, and the SLA question (2026-08-15)

The roadmap's Key Decisions record "OpenAI app review has no published SLA and must not gate v1" as the
reason for Claude-first launch. That claim is **re-verified and still holds**, and the mandated shapes are
now more specific than the roadmap knew.

**The `search`/`fetch` contract** (`https://developers.openai.com/api/docs/mcp`):

- `search` takes **a single query string** and returns "an object with a single key, `results`, whose value
  is an array of result objects"; each result carries `id`, `title`, `url`.
- `fetch` takes "a string which is a unique identifier for the search document" and returns one object with
  `id`, `title`, `text`, `url`, and optional `metadata`.
- **Both must be returned twice**: "return this object as `structuredContent` and include the same value as
  a JSON-encoded string in the content array for compatibility."
- **"ChatGPT creates citation metadata only when `url` is a non-empty string."**

The last two are new constraints on brainz and neither is currently asserted. `src/mcp/server.ts:toolResult`
does dual-encode, but nothing pins that the two lanes are *the same value*, and nothing pins that every
`/openai` result carries a non-empty `url` — which is the difference between a cited answer and an
uncited one, invisible in every test that only checks the field exists.

**Company-knowledge eligibility** (same page, plus
`https://developers.openai.com/plugins/build/mcp-server`): implement the standard `search`/`fetch` input
schemas, mark other read-only tools `readOnlyHint: true`, and "return absolute, user-openable URLs for
sources that the model should cite". brainz already sets `readOnlyHint` on its read tools and
`recordUrl` already emits an absolute URL into the user's own web app.

**The SLA.** `https://developers.openai.com/apps-sdk/app-submission-guidelines` states requirements —
demo account with sample data, transparent auth, data minimisation, a prohibited-category list — and
**publishes no review timeline of any kind**. OpenAI's own announcement says approved apps "begin rolling
out gradually"; the developer forum carries submitters reporting multi-week silence with no
acknowledgement. So the roadmap's decision stands **unchanged and for the same reason**: submission is a
thing brainz does *after* a launch that does not depend on it.

Sources:
- [Building MCP servers for plugins and API integrations — OpenAI](https://developers.openai.com/api/docs/mcp)
- [App submission guidelines — Apps SDK](https://developers.openai.com/apps-sdk/app-submission-guidelines)
- [Build an MCP server — Plugins](https://developers.openai.com/plugins/build/mcp-server)
- [Developers can now submit apps to ChatGPT — OpenAI](https://openai.com/index/developers-can-now-submit-apps-to-chatgpt/)
- [App Submission and Acceptance — OpenAI Developer Community](https://community.openai.com/t/app-submission-and-acceptance/1371246)

### 2.1 One conformance question this unit cannot close, and does not pretend to

`toolResult` spreads brainz's **response envelope** (`degraded`, `notice`, `next`, `setup`, `protocol`)
beside `results` in the payload. The mandated shape is "an object with a **single** key, `results`".

Whether ChatGPT tolerates the extra keys, ignores them, or refuses the tool is **not determinable without a
live connector against a real ChatGPT account**, which is spend and a deployment this unit may not make.
So the decision is:

- The **mandated fields are pinned now** — `results` present and an array; every element exactly
  `{id,title,url}`; `url` non-empty; `title` never `undefined`; `structuredContent` deep-equal to
  `JSON.parse(content[0].text)`.
- The **strict projection is written and unit-tested but not switched on** — `src/mcp/openai.ts` exports
  `strictOpenAiPayload`, which drops everything but the mandated keys, and a test proves it. Turning it on
  is one line at the wire layer.
- Live verification is recorded as **deferred, with its reason**: it needs a real ChatGPT connector.
  Reporting it as passing would be exactly the fake pass the discipline forbids.

The envelope is not merely decorative — `degraded` is how a caller learns the index is cold — so dropping it
by default would silently downgrade the `/openai` surface. Keeping it and pinning the mandated half is the
honest position until the live check can run.

---

## 3. The security core: `allowedOrigins`, and the marker that silently means "everything"

This is the part of the unit that can leak, so it is designed first and mutation-tested hardest.

### 3.1 The hazard the current code carries

`src/mcp/dispatch.ts` step 4:

```ts
grant = claims.origins.length > 0 ? claims.origins : await fullBrainGrant(sql, writeOrigin);
```

`fence.ts`'s stated rule is **"an empty grant sees nothing (not everything)"**, and every function in it
implements that. This line is the one place in the system that inverts it: an empty origins array is a
*marker* meaning whole brain. Today that is safe, because the only producer of an empty array is the
provisioned bearer.

The moment narrowed grants become real it stops being safe, and it fails **open**:

- a work grant whose origin list is filtered down to nothing by validation,
- a work grant re-minted after its only origin was severed,
- a client that sends `origins: []` to a consent endpoint that trusts it,

each becomes **a whole-brain grant**, silently, with the fence reporting no violation at any level because
the fence was never consulted. That is the "a new fence added at one call site while ten others bypass it"
defect in its purest form: the bypass is *above* every call site.

**Fix, structurally.** `GrantClaims` gains a required, explicit `scope`:

```ts
readonly scope: 'whole_brain' | 'narrowed';
```

with the invariant `scope === 'narrowed' ⟺ origins.length > 0` enforced **at mint and again at verify**.
A narrowed grant with no origins cannot be minted, cannot be signed, and — the half that matters, because
a signer is a thing an attacker might obtain — **cannot be verified**. Dispatch then reads the marker
rather than inferring it:

```ts
grant = claims.scope === 'narrowed' ? await expandGrant(sql, claims.origins) : await fullBrainGrant(...);
```

### 3.2 The grant vocabulary: concrete origins and class wildcards

Origins already follow a `class:source` grammar throughout the repo (`personal:mail`, `work:calendar`,
`personal:agent`). A narrowed grant's `origins` entry is therefore either:

- a **concrete origin** — `work:mail`; or
- a **class wildcard** — `work:*`, which is what a "work connector grant" actually means.

Wildcards are expanded **per request**, in one function, against `brainOrigins(sql)` — not frozen at mint.
Freezing at mint would mean a work grant issued before the first work mail arrives can never read work
mail, and a grant issued today silently excludes a source connected tomorrow. Expansion also
unconditionally adds the class's own agent origin (`work:agent`), which mirrors what `fullBrainGrant`
already does for the whole-brain case and gives the expansion a **non-empty floor**: a `work:*` grant on a
brain holding no work rows resolves to `['work:agent']`, never to `[]`, so the fail-open path of §3.1
cannot be reached even through an unlucky corpus.

`work:*` never matches `personal:anything`. The class is the token before the first `:` and the match is
exact string equality on it — not a prefix test, because `work` is a prefix of `workplace` and R9's R2
finding is precisely that a prefix match against a boundary the separator was supposed to mark is how a
credential reads a sibling's data. The same lesson, one store over.

### 3.3 `writeOrigin ⊆ grant`, checked statically

`GrantClaims.writeOrigin` is where a grant's `remember` lands. It is independent of `origins` today, so a
work-scoped grant would write `personal:agent` rows: a **cross-context write**, and one the same grant then
cannot read back — so it is invisible to any test that stores and recalls under one credential.

The invariant is checked at verify, statically (no database): `writeOrigin` must be one of the concrete
origins, or belong to the class of one of the wildcards. A grant that fails it is refused with the same
single unauthorized sentence — not downgraded, not silently rewritten.

### 3.4 Where the fence sits, enumerated

The claim "the fence is below every read path" is only worth as much as the enumeration behind it. Every
function in `src/` that takes a `Grant`:

| Path | Fence | Reached from |
|---|---|---|
| `reads.ts:indexState` | `origin_context = ANY` ×4 | envelope on every tool |
| `reads.ts:inventory` | scalar/subset/intersect ×4 | `brain` |
| `reads.ts:fetchRecord` → `fetchChunk`/`fetchPage`/`fetchFact`/`fetchEntity` | `fenceScalar`/`fenceRow`/`fenceEntity` | `fetch`, `recall({id})` |
| `reads.ts:entityCard` | `fenceEntity` on the card, `origin_contexts <@` on fact hydration, `&&` on suggestions | `entity` |
| `core/search/read.ts:recall` → `arms.ts` (4 arms) | grant threaded to every arm, `visibleUnder` on output | `recall`, `search` |
| `core/briefing/assemble.ts` | grant on both fenced statements | `briefing` |
| `mcp/tombstone.ts:forgetRecord` → `mayTouch` | three fence rules | `forget` |
| `core/lifecycle/blast-radius.ts:previewForget` → `mayTouch` | three fence rules | severance/forget preview |
| `core/lifecycle/versions.ts` | grant on the doc read | versions/revert |
| `core/export/reconstruct.ts` | grant on the page/chunk read | export |

And the paths that take **no** grant, each with why:

- `reads.ts:brainOrigins` — deliberately unfenced; it *builds* the fence and its result never reaches a
  caller. U18 adds a second consumer (wildcard expansion), which is the same use.
- `mcp/resources.ts:readResource` — returns settings only (spend cap, context policy, paused source
  names), no row content and no origin names. Tenant-scoped, not origin-scoped.
- `tools/meta.ts:manage` — writes settings; tenant-scoped.
- `tools/write.ts:remember` — writes at `ctx.writeOrigin`, which §3.3 now constrains.

**Two residuals, named rather than closed:**

1. **`entity_alias` has no origin column** (`v2-knowledge-core.sql`), so `entityCard`'s alias list is
   returned unfenced. An entity resolved on the intersect rule by a work grant therefore returns aliases
   that were only ever written from personal mail. Closing it needs an additive origin column *plus* a
   write path that fills it, and backfilling existing rows with an invented origin is exactly the
   "unobserved value a later reader takes as an assertion" this repo refuses. **Filed, not fixed** — and
   the dual-grant suite asserts the leak's *bound* (aliases and origin labels, never statements or bodies)
   rather than pretending it is absent.
2. **`EntityCard.origins` returns the entity's full origin union**, so a work grant learns that a shared
   person also appears under `personal:mail`. That is an origin *label*, not content, and it is the same
   bounded disclosure `scope_denied` already makes deliberately. Recorded here so it is a decision.

### 3.5 The proof, and the trap it is written against

> The dual-grant test passes trivially unless the fixture contains BOTH work and personal rows and the
> assertion is that the personal row is absent under a work grant.

So the fixture carries, and a test asserts it carries: a personal-only page/chunk, a work-only page/chunk,
a **mixed-origin fact** (subset rule must refuse it under a work grant — an intersect rule here would hand
the work connector the personal half of every joined claim), a **shared entity** (intersect resolves it,
and the hydration below it must still fence), and a personal-only entity.

Every personal row's body, title and entity name carries a **sentinel** string. The assertion is then not
per-field but total: call **every advertised tool on both endpoints** plus `resources/read` under the work
grant, serialise the entire result — content, envelope, `_meta`, error — and assert the sentinel does not
appear. A per-field check tests the fields somebody remembered; the sentinel tests the response.

---

## 4. Severance, and what it is allowed to do

U17 built `previewSeverance` with its two columns. U18 is its caller.

**Where it is surfaced.** Not on `tools/call`. R12a's rule — the assistant holding `remember` is the
assistant reading the user's mail — applies at full force to an irreversible destructive operation, and
`manage`'s enum is deliberately four reversible settings. Severance is a **web-app** action, behind a
session, a CSRF check, and an **explicit echo of the origin being severed** (not a boolean: a
confirm-flag is a field a bug fills in, an echoed string is one only a human types).

**What executes where.** The web-app identity cannot resolve a tenant connection string — that is R11 and
it is guarded. So the tenant-side work reaches the tenant through a **port**, the same shape
`ConnectorVendor` and `ProviderKeyWriter` already use, whose implementation runs where tenant access
legitimately lives. The web app calls `preview` and `execute`; it never holds a DSN.

**What execute does, in order:**

1. Re-run the preview inside the same transaction and record it — a preview computed at page-render time
   and acted on minutes later is a number the user consented to and not the number that happened.
2. Soft-delete the rows whose origins are **exactly** the severed origin, through the tombstone columns
   that already exist. Not a hard delete: R12's 72h recoverable window is the whole reason `forget` is
   reversible, and severance is not a more-final operation than `forget`.
3. Append one row to a new, additive `severance` table (rung 10) recording the origin, the instant, the two
   count columns, and the surviving origins. **Append-only and observation-only** — every column records
   something that happened, so no later reader can mistake it for an assertion about a row it did not see.
4. Revoke every grant whose origins fall **within** the severed set (a `work:*` grant when `work:mail` was
   the only work origin), because a live credential scoped to nothing is the §3.1 hazard arriving from the
   other direction.
5. Stop the polling for that source, and ask the vendor to delete the external user — the two legs
   `handleDisconnect` already performs.

**What execute does NOT do:** re-derive the mixed rows. Re-derivation is a consolidation cycle and belongs
to U11. What this unit owes is that the *need* for it is recorded honestly and is discoverable — which the
`severance` row is — and that the counts the user saw are the counts that were acted on.

**The post-severance read property**, which is the third leg of the ledger's `gap.context-injection-gate`:
after severance, no read path returns a row whose origin is the severed one, under any grant including the
whole-brain bearer. It falls out of the soft-delete, and it is asserted across every read path rather than
assumed to.

---

## 5. The auth seam, and what CASA gates

**The adapters stay; the auth swaps.** `sources/types.ts` already made a provider a `ProviderSource`
implementation, so a Google adapter does not care who obtained the token. What has no seam is the
*obtaining*: `pull.ts` reaches `pipedream/client.ts` directly.

U18 cuts one port, `ConnectorAuth`, with three methods — `accessTokenFor`, `revoke`, `deleteExternalUser` —
and two implementations:

- `pipedreamAuth` — today's behaviour, delegating to `pipedream/client.ts`. No change in observable
  behaviour, which is the point: the swap must be a no-op until it is deliberately flipped.
- `ownOAuth` — the structural stub. It declares the token store, the refresh contract, and the per-source
  cutover selector, and every method **refuses with a typed `not_certified` reason naming CASA**. It does
  not call Google. No OAuth application is registered by this unit.

**The swap path** is per-source and per-tenant, resolved by one function so the fleet cannot end up with
two answers: a source is on own-OAuth only when the source is marked certified *and* the tenant has an
own-OAuth token for it; otherwise Pipedream. That ordering makes the cutover reversible — un-marking the
source moves everyone back without touching a tenant row.

**Two consequences that are easy to miss and are wired here:**

1. **Own-OAuth tokens add a leg to the erasure runbook.** U17's account-erasure runbook has five legs, the
   fourth being "Pipedream external-user deletion with token revocation". If brainz holds its own refresh
   tokens, that leg must cover them or "no queryable trace" becomes false the day the swap happens. The
   port is therefore shaped so the runbook's fourth leg calls `ConnectorAuth.deleteExternalUser` rather
   than Pipedream directly — one leg, two implementations, no sixth store.
2. **Own client secrets are R10 register entries.** A Google OAuth client secret held by the fleet is a
   platform-scoped credential whose blast radius is every tenant who granted through it — strictly larger
   than the Pipedream project key it replaces, because it is the mint rather than a vendor's mint. The
   register gains its rows when the app is registered, and this unit records that as a required step of
   registration rather than a follow-up.

### 5.1 CASA — the dated dependency, and exactly what it gates

**CASA** (Cloud Application Security Assessment) is Google's annual third-party security assessment
required for an OAuth application requesting **restricted scopes** — which is what Gmail message-body
access is. Its published cost band is **~$540–1,800 per year**, its lead time **3–4 weeks**, and it
**renews annually**. The roadmap's instruction is to start the paperwork at **Phase 4 start**.

What it gates, precisely:

| Gated | Not gated |
|---|---|
| brainz's **own** Google OAuth app requesting Gmail restricted scopes | Gmail through **Pipedream's** OAuth apps (Pipedream holds the assessment) — the alpha and beta path, unchanged |
| Removing Pipedream from the trust boundary for mail | Calendar and Drive under non-restricted scopes, which have a lighter review |
| The R10 register shrinking by one subprocessor | Microsoft connectors, which are a separate Microsoft review, not CASA |

**Therefore: CASA is on no critical path in this unit, and this unit starts none of it.** The `ownOAuth`
implementation is a structural stub that refuses; the certification is a dated external dependency with an
invoice and a renewal, recorded so that the day someone wants to remove Pipedream from the subprocessor
list they discover the four-week lead time in a plan rather than in a launch week.

This unit reports CASA as **deferred**, reason: an external paid assessment with a real invoice and an
annual renewal, outside this session's hard limits.

---

## 6. Order of work, and what each step's red looks like

1. **`allowedOrigins`** — red: a narrowed grant with `origins: []` reads the whole brain; a work grant's
   `remember` lands in `personal:agent`. Then `src/mcp/grant-scope.ts`, the claims change, dispatch wiring.
2. **The dual-grant suite** — red: the sentinel appears in some tool's response under a work grant.
3. **The equivalence suite** — red: driven from the blocking corpus, on twin endpoint-bound grants.
4. **Severance** — red: preview says N, execute leaves the rows; a severed row still reads back.
5. **The auth seam** — red: `pull.ts` has no way to be handed a different token source.

Every guard is then mutated individually and must die for its own named reason. The repo's recorded
failure — three access controls where only one was doing the work, because the mutations were never applied
in isolation — is the reason each mutation is applied alone and reverted by digest, never by `git checkout`.

---

## 7. Ledger

- `gap.context-injection-gate` (critical, p0, U16) names three cases: derived-row inheritance, graph
  traversal across contexts, post-severance reads. It flips to `covered` **only if all three land**;
  otherwise it stays `not-yet` naming the missing one.
- `gap.data-lifecycle` (covered, U17) carries the sentence "the severance flow that consumes the second one
  is U18's". Its note is updated when the flow lands.
- Any part of §2's conformance that needs a live ChatGPT connector, and the whole of §5.1, stay
  **not-yet/deferred** with the missing half named. Four agents have declined flips on that basis; this is
  the fifth.

---

## 8. What execution changed about this plan

Written after the work, per the convention `docs/plans/2026-08-13-002-u14-…` and the U16 execution-note
commit established. Five things the plan did not know:

**1. The plan under-described the fail-open in §3.1 — the guards make its branch unreachable, so it was
unprovable.** A mutation restoring the pre-U18 line (`origins.length > 0 ? origins : wholeBrain`) **survived
the entire integration suite**. Once `grantScopeViolations` refuses `narrowed` with no origins at mint *and*
at verify, and `expandGrant`'s class floor keeps every valid narrowing non-empty, nothing the request path
can construct reaches the fall-through. A guard nothing can provoke is a guard nobody can prove. The
decision was therefore extracted into `grant-scope.ts:resolveGrant` — a named function a unit test can hand
the shape the request path can no longer produce — and the mutation dies there. **This is the plan's most
important correction and it generalises**: defence in depth is only depth if each layer is separately
reachable by a test.

**2. Two of the three §3 guards overlap on the obvious fixture, and the overlap hid one of them.** Removing
the empty-origins check alone (M1) killed only its unit test; the integration assertion survived, because
`origins: []` also fails the `writeOrigin ⊆ grant` check. It took a *combined* mutation (M3) to show the
pair is what closes the hole — and to show that even with both gone the grant resolves to `[]` and
`fence.ts` refuses everything, so the explicit `scope` marker in the resolution is the load-bearing control
and the two claim-side guards are the second layer. That is exactly the repo's recorded defect ("three
access controls where only one was doing the work") caught in the act, and the isolating test is the unit
one asserting the *specific* finding text rather than merely that something was found.

**3. Three U6 fixtures expressed grants that write where they cannot read.** `dispatch.test.ts`,
`adversarial.test.ts` and `schema-guard.test.ts` all minted `origins: ['work:mail']` with
`writeOrigin: 'personal:agent'`. Under §3.3 those are now incoherent credentials and the suite went red on
landing — correctly. They derive the write origin from the origins now. The plan treated §3.3 as an
addition; it is also a **correction to existing fixtures**, and any future narrowed grant has to be built
the same way.

**4. §3.4's enumeration was right about the read paths and missed a residual in the entity card.**
`entityCard`'s fact hydration is fenced (the mutation dropping that predicate is killed). Its **alias list
is not**, because `entity_alias` carries no origin column at all — so a work grant resolving a shared person
receives aliases written only from personal mail. Vocabulary and labels rather than statements or bodies,
and the suite asserts that bound. It is the reason `gap.context-injection-gate` stays `not-yet` on two and a
half legs of three rather than flipping.

**5. The plan forgot that a fence nobody can request is not a product.** §3 designed the credential and §6
ordered the work, and neither noticed that `handleAuthorize` hardcoded `origins: []` — so the first four
commits' worth of fence could not be *obtained* by any user. `scope=brainz:context:work` closes it, and the
mutation that skips unrecognised scope tokens survived three of the four cases first written for it: only
`openid brainz:context:work`, the realistic client string, isolates the prefix check.

Also landed and not in the plan: `ClientFailure.detail` (an erasure receipt that cannot say *why* a leg
failed names a problem without naming the work), and `developers.openai.com` as an R10 not-a-destination
entry — the register scanner flagged the docs URL cited in `openai.ts`, and the citation is the receipt for
a shape this repo conforms to, so it is registered rather than deleted.
