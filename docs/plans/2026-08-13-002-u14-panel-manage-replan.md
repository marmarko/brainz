# U14 re-plan — Panel + `manage`

**Date:** 2026-08-13
**Unit:** U14 (Phase 4), per `docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`
**Why this file exists:** U14's execution note calls the unit milestone-grade and requires a
re-plan before execution, because "MCP Apps client rendering was still unreliable in research"
and Claude's `ext-apps` status had to be re-verified first. This is that re-plan. It is a
sibling file rather than an edit to the roadmap's body, so the roadmap stays the record of what
was planned and this stays the record of what was found.

---

## 1. What the research found

### 1.1 The extension is Final and Claude declares support

- **SEP-1865 (MCP Apps) reached Final and shipped as an official extension.** The spec release
  is dated **2026-01-26**; MCP Apps ships inside the versioned extensions framework as of the
  **2026-07-28** core release — the same revision this server already declares
  (`envelope.ts:PROTOCOL_VERSION`).
  Sources: [MCP Apps blog, 2026-01-26](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/),
  [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview),
  [ext-apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).
- **The extension identifier is `io.modelcontextprotocol/ui`**, and the published client matrix
  lists Claude (web) and Claude Desktop as supporting it, alongside VS Code Copilot, M365
  Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI and PostHog Code.
  Source: [extension client matrix](https://modelcontextprotocol.io/extensions/client-matrix).
- **Anthropic states MCP Apps is "already live in Claude"** in its 2026-07-28 spec announcement
  (published 2026-07-28), alongside stateless transport and enterprise-managed auth.
  Source: [Bringing MCP 2026-07-28 to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude).

So the paper answer to "is `ext-apps` real yet" is **yes, and it is Final**. That is a genuine
change from the state the roadmap recorded.

### 1.2 …and it does not render for a custom remote connector

Three independent, dated reports say the shipping Claude clients do not mount the iframe for a
**custom** remote connector — which is exactly and only what brainz is:

| Report | Opened | Status as of 2026-08-13 | What it says |
|---|---|---|---|
| [anthropics/claude-ai-mcp#471](https://github.com/anthropics/claude-ai-mcp/issues/471) | 2026-06-20 | **Closed as not planned** (labels: bug, duplicate) | "A custom MCP server implementing the MCP Apps (SEP-1865) spec does not get its HTML widget rendered by Claude Web… never mounts the widget iframe — the result is shown only as plain text." Reporter verified `tools/list` carried `_meta.ui.resourceUri`, `resources/read` returned valid `text/html;profile=mcp-app`, and the *same backend* renders correctly in ChatGPT. |
| [modelcontextprotocol/ext-apps#671](https://github.com/modelcontextprotocol/ext-apps/issues/671) | 2026-05-27 | **Open**, no maintainer reply | Same symptom on Claude Desktop and claude.ai; the identical resource renders in the SDK's own `basic-host` harness. |
| [anthropics/claude-ai-mcp#636](https://github.com/anthropics/claude-ai-mcp/issues/636) | 2026-07-17 | **Open**, no maintainer reply | claude.ai web shows "Client server capabilities not available", after which every MCP Apps tool result renders as an "Unable to reach" chip — while the origin returns HTTP 200 to every POST. The origin **never receives a single GET**; the client's optional GET SSE stream appears rejected inside Anthropic's proxy, and the client treats that failure as fatal to capability state. |

**#636 is the one that names us.** `server.ts` answers `GET /mcp` with `405 method not allowed`
by deliberate design — a stateless server has nothing to put on a server-initiated stream. That
is spec-legal and is precisely the condition the reporter says invalidates capability state and
kills interactive rendering. We would be walking into the reported failure with our eyes open.

**Verdict: the panel cannot be assumed to render on the client this product launches against.**
The roadmap's caution was correct and remains correct; only the reason changed. It is no longer
"the extension is not finished" — it is "the extension is finished and the shipping client does
not honour it for custom connectors."

### 1.3 The `manage` advertisement question is retired, not answered

The roadmap carries a deferred Outstanding Question: *"whether MCP hosts forward `tools/call`
for unadvertised names (decides `manage`'s advertisement; fallback in U14)."*

That question no longer decides anything, because the spec standardised the mechanism it was
groping for. MCP Apps defines **tool visibility**:

- `_meta.ui.visibility` is an array of `"model"` and/or `"app"`; the default when absent or
  empty is `["model", "app"]`. `["app"]` means *callable by the rendered app, hidden from the
  model*.
- The spec's host requirement is the load-bearing half: **"Host MUST reject `tools/call`
  requests from apps for tools that don't include `"app"` in visibility."**

Sources: [ext-apps spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
[ext-apps tool visibility](https://deepwiki.com/modelcontextprotocol/ext-apps/6.3-tool-visibility-control).

Two consequences, both of which change U14's design rather than merely informing it:

1. **`manage` must appear in `tools/list` for the panel path to work at all.** A conformant host
   rejects an app's call to a tool it has no definition for, and a tool absent from the list has
   no visibility array to check. "Unadvertised dispatch" is not the design any more; *app-scoped
   listing* is.
2. **The gate is no longer a bet on host behaviour.** `["app"]` is a declared, host-enforced
   scope. What it is *not* is our enforcement — a host that ignores it, or a host with no MCP
   Apps support at all, still forwards whatever the model asks. So the server-side gate stays,
   and visibility is what makes the panel path legitimate rather than lucky.

### 1.4 Elicitation exists, but not as a server→client request

2026-07-28 removed the `initialize`/`initialized` handshake (SEP-2575) and the session header
(SEP-2567). Elicitation therefore cannot be a server-initiated request down a held stream. It is
re-expressed as **Multi Round-Trip Requests (SEP-2322, Final)**:

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "confirm": { "type": "elicitation", "message": "Delete 3 files?", "schema": { "type": "boolean" } }
  },
  "requestState": "<opaque blob the client MUST echo back unmodified>"
}
```

The client gathers answers and **re-issues the original call** with `inputResponses` and the
echoed `requestState`. Because all resume state lives in the payload, any stateless instance can
continue the work. Client capabilities — including `"elicitation": { "form": {} }` — ride in
`_meta["io.modelcontextprotocol/clientCapabilities"]` on **every request**, next to
`io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientInfo`.

Sources: [SEP-2322 (Final)](https://modelcontextprotocol.io/seps/2322-MRTR),
[the 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
[extensions negotiation](https://modelcontextprotocol.io/extensions/overview).

This is a better fit for brainz than the shape U14 was written against. The confirmation the
fallback owes the user is a signed, short-TTL, self-contained blob — the *same primitive* as the
panel nonce, with a different purpose claim. No session, no server-side pending-action table.

---

## 2. Which path is being built, and why

**Both.** The panel is built and gated behind a capability check that the shipping client does
not currently open; the fallback is built and is what actually ships.

That is the roadmap's own instruction ("build both — the panel plus the fallback — because the
fallback is what ships and the panel is what you flip on when the client catches up"), and §1.2
is the evidence that the condition still holds. Nothing here is speculative work: the panel is
~200 lines of resource plumbing and a generated HTML document, and every guard it introduces is
exercised by the fallback path too.

### 2.1 The precedence matrix

Client capabilities are read **per request** from
`params._meta["io.modelcontextprotocol/clientCapabilities"]`. Three states, and the gate is a
total function over them:

| Client declares | `manage` in `tools/list` | Gate on `manage` | `set_context_policy` |
|---|---|---|---|
| `io.modelcontextprotocol/ui` | yes, with `_meta.ui.visibility: ["app"]` | **panel nonce required.** Elicitation never substitutes on this branch. | allowed with a nonce |
| no `ui`, has `elicitation` | yes, as the 8th **model-visible** name on `/mcp` | **MRTR confirm required**: first call returns `input_required` + signed `requestState`; the resume must echo it and answer `confirm: true` | **refused**, `scope_denied` + web-app deep link |
| neither | yes, as the 8th model-visible name on `/mcp` | **refuses**, typed, with the deep link. Never executes. | refused, deep link |

Three properties worth stating because each is a place the design could silently rot:

- **The nonce is only mintable on a ui-capable request.** `resources/read` mints a panel nonce
  only when that request declares `io.modelcontextprotocol/ui`. Without that rule the connected
  agent could simply read `ui://brainz/panel` itself, harvest the nonce, and call `manage` — the
  nonce would be a formality, not a gate. With it, a host that cannot render a panel cannot mint
  a panel credential either.
- **`set_context_policy` is web-app-only in *both* fallback rows**, including the elicitation
  row. The roadmap moves it web-app-only in the fallback; it is not "confirmable". A yes-click on
  an agent-framed prompt is not the user choosing a context policy.
- **The gate fails closed in the right direction.** Issue #636's own logs show Claude still
  sending `initialize`, which means it may not be sending per-request `clientCapabilities` at
  all. If it does not, the `ui` branch never opens and every call lands in the fallback. The
  branch that is unverifiable is the branch that grants more; the branch that grants less is the
  default.

### 2.2 KTD3's number, and the delta this unit publishes

KTD3 says nine names on the wire, seven advertised to models. That holds exactly on a ui-capable
client: `manage` is listed but scoped `["app"]`, so the host keeps it out of the model's tool
list. On a client without MCP Apps the model sees **eight**. That is the roadmap's own stated
fallback cost, and the replacement control is the confirm gate above rather than a note in a
changelog. `definitionsDigest()` continues to cover the definition *table* — the per-request
filtering is a listing decision, not a definition change, and an admin who approved eight names
is not surprised by seven.

### 2.3 Text twins

Every panel action has a text equivalent, generated from the **same** `MANAGE_ACTIONS` table the
panel HTML is generated from, so parity is structural rather than remembered:

| Action | Panel | Text twin |
|---|---|---|
| `set_spend_cap` | button + amount field | `manage(action:"set_spend_cap", value:"<micro-USD>")`, confirmed |
| `pause_source` | per-source toggle | `manage(action:"pause_source", value:"gmail")`, confirmed |
| `resume_source` | per-source toggle | `manage(action:"resume_source", value:"gmail")`, confirmed |
| `set_context_policy` | radio group | **the web-app deep link** — per the fallback rule above |

The twin is discoverable without a panel: the `brain` tool (advertised on both endpoints,
read-only, no model call) carries a `management` block listing the current setting values, the
exact call for each action, and the deep link. That is also the panel's data source, so the two
cannot describe different worlds.

### 2.4 What each action actually does

An action that returns `applied: true` and changes nothing is worse than one that refuses.

| Action | Store | Effect today |
|---|---|---|
| `set_spend_cap` | control plane, `control.tenant.spend_cap_micro_usd` | **live** — `src/ingest/first-import.ts` already reads this column to gate a first import |
| `pause_source` / `resume_source` | tenant DB, `source_pause` (rung 7) | **live** — `enqueuePullIfDue` refuses to enqueue a paused source |
| `set_context_policy` | tenant DB, `tenant_setting.context_policy` (rung 7) | **recorded only.** The read-path narrowing is not wired in this unit and the response says so |

`set_context_policy`'s honesty note is deliberate. Wiring a tenant-set narrowing into
`dispatch.ts`'s fence derivation is a change to the mechanism the whole isolation claim rests on,
and it would be reachable *only* from the panel branch — which §1.2 says does not render. Building
an unreachable modification of the fence is how a fence acquires a bug nobody can see. The column
is the durable record U15's web app drives; the response carries an `effect` string naming exactly
what did and did not change.

---

## 3. The review-queue close: ruling

**Ruling: no review action joins `manage`'s enum. The close is routed web-app-only through U15.**
The schema constraint `review_queue_closed_by_is_out_of_band` is untouched, and it keeps refusing
`agent_mcp`.

The roadmap demanded an explicit decision and a defence. The defence has three legs.

1. **The only surface that could satisfy R12a is the one that does not render.** A nonce-gated
   panel action is the *right* shape — a panel click is out-of-band in the sense R12a means. But
   §1.2 is three dated reports that the panel does not mount for a custom remote connector on
   Claude. Shipping the close there means shipping a guard no client can exercise: green in CI
   forever, because the branch is never entered by anything except its own fixture. This
   repository has shipped that exact class of guard before and the plan says so in as many words.

2. **The fallback path is agent-initiated by construction and therefore cannot corroborate.**
   The MRTR confirm is: crafted mail → consolidation proposes a merge → the agent calls
   `manage(close_review)` → the host renders a confirmation the *agent* worded the context for →
   the user clicks yes. R12a's whole point is that the assistant holding `remember` is the
   assistant reading the attacker's mail. A yes-click on a prompt that arrived inside an
   agent-driven turn is not "an action taken in the web app or panel which the connected agent
   cannot issue" — it is an action the connected agent issued and the user waved through. Writing
   `user_out_of_band` for it would make the constraint's string a lie while the constraint itself
   still passed.

3. **The nonce is exfiltratable in the one place it would matter most.** The panel nonce lives in
   the resource body, because the app's JavaScript needs it. On any host where resource content
   can reach model context, the connected agent can read it. For the four reversible settings that
   residual is bounded and acceptable — the worst case is a spend cap the user can re-raise and a
   source they can un-pause. For approving a model-proposed mutation of the brain's own compiled
   truth it is disqualifying, because that class must never execute unconfirmed and there is no
   recovery that restores the trust boundary after a forged corroboration lands in the
   compiled-truth boost.

**What this leaves standing, and what goes stale.** `pending_review` remains a number a user can
read and cannot act on until U15. `docs/recipes/weekly-review.md` says that in those words today;
this unit updates the paragraph to name the decision and its owner rather than leaving it reading
as an unclosed gap. `stack.corroboration-boost` in the ledger currently names "(U12/U14/U15)" as
the units that might write a corroborating attestation — U14 is now settled as *not* one of them,
which is a ledger note change, not a status change.

**What would reverse this.** Either of two observations, both cheap once available: a Claude
release that mounts the iframe for a custom connector (retest against #471/#636), or a web-app
session in U15, which makes the question moot by supplying the surface R12a always meant.

---

## 4. Schema: rung 7

Additive, expand-only, no `DROP`/`RENAME`, no `NOT NULL` without a default on an existing table.

- `ALTER TABLE tenant_setting ADD COLUMN context_policy text` — nullable, **no default**, CHECK
  admits a closed set. **Backfill story: none, deliberately.** NULL means "the user has never
  chosen", which is different from every named policy including the permissive one. This follows
  rung 5's `occurred_at` and rung 6's `external_ref` precedent verbatim: the only value available
  to a backfill would be a guess, and a guess written into a column a later reader takes as an
  assertion is worse than a null, because a null is legible. It heals from an observation — the
  user choosing — and from nothing else.
- `CREATE TABLE source_pause (...)` — new table, so there is nothing to backfill. A row exists
  **only** while a source is paused; the absence of a row is the unambiguous "not paused", which
  means a previous fleet release that has never heard of this table keeps behaving exactly as it
  does today. `paused_by` records *which surface authorised it* (`panel`, `agent_confirmed`,
  `app`) rather than asserting a person, for the same reason `review_queue.closed_by` does: the
  authorising channel is the fact, and collapsing three channels into "the user" is how R12a's
  distinction gets lost one table over.

---

## 5. Verification, and what cannot be verified here

**Verified in this unit:** every gate branch under test with a real tenant database, real
control plane, real secret store; each guard mutated and observed to die for the stated reason.

**Reported `deferred`, with reasons — no live paid model call, no deployment, no cloud resource
is made by this unit:**

- **Panel rendering in Claude.** Requires a deployed public origin and a real client. The three
  issues in §1.2 say the expected result today is text-only fallback. Deferred: needs a
  deployment.
- **Whether Claude sends per-request `clientCapabilities`.** #636's server log shows `initialize`
  still in use. Deferred: needs a real client. The design fails closed if it does not.
- **Whether Claude's host honours `_meta.ui.visibility: ["app"]`.** Spec-required; unobservable
  from here. Deferred: needs a real client. Our own nonce gate does not depend on it.
- **Whether Claude implements MRTR `input_required` end to end.** Deferred: needs a real client.
  A client that ignores it sees a plain refusal carrying the deep link, which is the third row of
  the matrix and is correct behaviour rather than a failure.
