# Recipe — a daily briefing

**Trigger:** once each morning, on a schedule your client runs.
**Action:** one `briefing` call.
**Preview:** paste the prompt into an ordinary chat and run it by hand once
before you schedule it. What you see there is what will arrive every morning.

That is the whole recipe. Everything below is what to expect from it.

---

## Before you start

Your brain has to be connected to the client you want the briefing in. In the
alpha that means adding brainz as a custom connector in your client's settings
and giving it the origin your operator handed you — something of the shape
`https://<your-brainz-origin>/mcp`. There is one such URL per deployment; this
document deliberately does not name one, because the alpha has no public origin
yet.

> **Alpha limitation.** There is no guided connect flow. Pasting a URL into a
> settings screen is exactly the setup question the product is meant to remove,
> and removing it is scheduled work, not something this recipe can do. If you
> are a tester rather than the operator, ask for the URL — do not go looking for
> it.

## The prompt

Paste this as the scheduled task's instruction. Nothing in it needs editing.

```
Call `briefing`.

Then write me the morning read, in this order, and skip any section that
came back empty:

1. Today's meetings — for each one, the title, and one line per participant
   drawn from their card if the bundle carried one.
2. What is open — the commitments, with owner and due date where present.
3. What changed since I last looked — the `delta` section, one line each.
4. Anything flagged stale that still looks relevant.
5. The counts, verbatim, as one line: contradictions, pending review,
   uncorroborated claims.

If the response carries `degraded`, say so in one sentence at the top and tell
me the reason it gave. If it carries a `notice`, put it at the bottom.

Do not call any other tool. Do not guess at anything the bundle did not
contain.
```

Run it once by hand. If it reads well, schedule it for whenever you want it —
your client's own scheduled-task feature is the delivery channel. There is no
server-side scheduler and no push: brainz answers when something pulls.

## What actually arrives

`briefing` is assembled by SQL over what the brain already knows. It makes **no
model call**, which is why it still answers on a morning when a model provider
is having a bad day. Your client writes the prose; the server ships the material.

**"The window", below, is the last 24 hours** when you call it the way this
recipe does — with no `since`. Pass one and every windowed section widens with
it. The bundle echoes what it used back as `window`, so the answer is never a
guess.

| Section | What fills it | What leaves it empty |
|---|---|---|
| `meetings` | Pages whose source type is `calendar` **happening** inside the window, newest first, at most 20. Each carries `occurred_at` (when the meeting is) alongside `created_at` (when this brain heard about it). | No calendar connector, or nothing in the window. |
| `participants` (inside each meeting) | People resolved against the brain's own entity dictionary, each with the card consolidation wrote for them. | **Dropped entirely until a model-tier consolidation cycle has completed over the brain** — see below. |
| `commitments` | Open commitments with owner and due date, soonest first, at most 20. | Same: a model-tier artifact. |
| `delta.changed` / `delta.stated` | Pages and facts written since **your last briefing call on this connection** — this recipe passes no `since`, so the bookmark governs. `first_read: true` the very first time. | Nothing arrived since you last looked. |
| `stale` | Pages that **went stale inside the window**, ordered by how relevant the brain thinks they still are, at most 20. | Nothing went stale in the window — widen `since` to reach older ones. |
| `counts` | Four numbers: contradictions, pending debt, pending review, uncorroborated claims. | Always present; several are structurally zero on the free tier. |
| `coverage`, `tier`, `not_included` | Whether the bundle is `materialized` or `cold`, which tier last ran, and what a `cold` bundle is missing. | Always present. |
| `notice` | The upgrade prompt, when it fires. | Most mornings — see "the prompt is bounded". |

### Cold is a shape, not an error

A brain that has never run a model-tier consolidation cycle — and a free-tier
brain, which never will — comes back with `coverage: "cold"`, a `degraded`
marker, and a `not_included` list naming what is absent:
`participant_cards`, `extracted_commitments`, `synopsis`.

Participants are **dropped, not shown bare**. A list of names with no cards
would be a thinner briefing pretending to be a whole one, so the bundle omits
the list and says it did. The same goes for commitments. What a cold briefing
still carries is real and useful: the meetings themselves, the delta, the stale
flags and the counts.

### The contradiction count is a paid-tier number

`counts.contradictions` reads the contradiction report and the review queue,
and both are produced by model phases. On a free-tier brain it is zero because
nothing can write to it, not because nothing conflicts. Do not read a zero as a
clean bill of health until the bundle also says `coverage: "materialized"`.

The same is true of `commitments`. `pending_debt` and `uncorroborated_claims`
are the two counts that mean something on every tier.

### The delta is per connection, and it moves — when you let it

The `delta` section is the difference between a briefing and a dashboard, and
it works off a bookmark stored against the credential the call arrived on.
Which of two things you get depends on one thing only: **whether you passed
`since`.**

| You call | The delta covers | The bookmark |
|---|---|---|
| `briefing` with no `since` | since your last such call on this connection | **moves** to the end of the window |
| `briefing` with a `since` | exactly the window you named | **untouched** |

The response says which one happened, in `delta.basis` — `"cursor"` or
`"window"` — so you never have to guess.

This recipe's prompt deliberately passes no `since`. That is what makes it a
briefing rather than a report: today's delta is what arrived since yesterday's
run, and tomorrow's covers today.

- The bookmark only ever moves forward, so a retried scheduled task cannot
  rewind it and replay a week.
- Every client sharing one connection shares one bookmark. Two scheduled tasks
  on one credential, both calling with no `since`, will split the delta between
  them — the first to run gets it.
- A call that names a `since` takes nothing from anybody. Ask for a week as
  often as you like; it is a query, not a bookmark advance.

That last rule is why [the weekly review](weekly-review.md) can run on the
same connection as this recipe. It asks for seven days, gets seven days, and
leaves your morning delta exactly where it was.

### The prompt is bounded

A free-tier bundle can carry a `notice` inviting an upgrade. It fires at most
once every 14 days, and once more only when the backlog crosses a new
threshold; it states its own dismissal. It is not a daily sales pitch and it is
not supposed to become one. If it starts arriving more often than that, report
it — that is a bug, not a setting.

## Cost

`briefing` makes no model call, so the briefing itself costs nothing beyond the
request. What your assistant spends turning the bundle into prose is your
client's own model spend and is not metered here.

## What this recipe does not promise

- **Delivery.** Nothing is pushed. If your client's schedule does not fire, no
  briefing happens and nothing anywhere notices.
- **A measured scheduled-task guarantee.** That a scheduled task can invoke a
  custom-connector tool unattended is accepted on the founder's daily use of
  their own client, not on a probe. It is the single mechanism this recipe
  rests on, and re-verifying it against a real connector is an alpha-exit line,
  not a settled fact. See [`docs/alpha-exit.md`](../alpha-exit.md).
- **Ranking quality.** `briefing` does not rank; it assembles. The retrieval
  stack's reranking stage belongs to `recall`, and its uplift is currently
  unmeasured — see the alpha-exit checklist.

## Related

- [Capture](capture.md) — the habits that give the briefing something to say.
- [Weekly review](weekly-review.md) — the same tool over a wider window.
