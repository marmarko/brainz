# Recipe — the weekly review

**Trigger:** once a week, by hand or on a schedule.
**Action:** one `briefing` over a seven-day window, then a short pass over
what it flags.
**Preview:** run it by hand the first time. The first week's output is the one
that tells you whether the brain has enough in it to be worth reviewing.

---

## Read this first: the delta is not weekly

`briefing` takes a `since` and an `until`, and most of the bundle honours them.
The `delta` section does not, and knowing that in advance saves a confusing
first run.

| Section | Honours the seven-day window? |
|---|---|
| `meetings` | **Yes** — pages inside the window, at most 20. |
| `delta.changed`, `delta.stated` | **No.** It starts from this connection's last briefing call, whenever that was. |
| `stale` | **No.** It ignores the window entirely and returns the most relevant stale things, at any age. |
| `commitments`, `counts` | Point in time, not a window. What is open and what is queued right now. |

The delta runs off a cursor stored against the credential the call arrived on,
and **every** briefing call advances it. So if you also run
[the daily briefing](daily-briefing.md) on the same connection, this morning's
run consumed the week's delta and your weekly review's "what changed" covers
about a day.

Two honest ways to live with that:

1. **Run the weekly review from a separate connection.** A second credential
   has its own cursor, so its delta really is a week. This is the only way to
   get a weekly delta today.
2. **Accept it, and read the other sections as the weekly part.** The meetings
   list, the stale flags and the counts are all genuinely week-shaped or
   point-in-time. The delta is then "since yesterday", which is still true —
   just not what the section name suggests.

## The prompt

Fill in the date once; your client can compute it if you ask it to.

```
Call `briefing` with `since` set to seven days ago (ISO date) and `until` set
to now.

Then write me a weekly review in four parts:

1. THE WEEK — the meetings in the window, grouped by who was in them. Use the
   participant cards if the bundle carried them.
2. STILL OPEN — the commitments, oldest due date first. Say which have no due
   date.
3. NEEDS ME — the counts, in full sentences: how many proposals are waiting on
   a decision, how many claims came in from outside with nothing of mine
   vouching for them, and how many contradictions are on report.
4. GOING STALE — anything in the stale list that you would not have expected
   to see there.

Then ask me one question: which of the open commitments is no longer true.

If the response carries `degraded`, say so at the top with the reason it gave.
Do not call any other tool, and do not fill gaps with anything the bundle did
not contain.
```

## What to do with what it surfaces

Three of the four numbers are work; one is reading. They are genuinely
different, and treating them the same is how a review becomes a ritual.

### Proposals waiting on a decision (`pending_review`)

These are automated changes the system was not confident enough to apply on its
own. High confidence applies, middling confidence queues here, low confidence
is only logged.

> **Alpha limitation: there is nowhere to close one from.** The in-chat panel
> and the web app are where a decision is meant to land, and neither exists
> yet. The `manage` tool accepts the call, validates it, and returns
> `applied: false` with a note saying the settings store lands with the panel.
> Nothing your assistant can do closes a review entry.

So for now: read the count, and write the entries down somewhere you control if
they matter. A rising `pending_review` over the bake is a finding to report, not
a queue you can work.

### Claims nobody of yours has vouched for (`uncorroborated_claims`)

Facts whose origins are all external — they came from mail, invitations, shared
files, or something derived from them, and nothing you wrote supports them.
They are held out of the ranking boost that compiled, trusted knowledge gets.

Saying one back through `remember` marks it **restated**. It does not clear it.
The reason is worth understanding rather than working around: the assistant
holding `remember` is the same assistant reading the mail, so a message could
instruct it to restate a claim and thereby promote that claim into your
briefing. Corroboration needs an origin the outside sender cannot also write,
and it has to arrive out of band — which, like the review queue, is a surface
that does not exist yet.

Treat this count as a reading list. It tells you how much of what your brain
believes came from other people. That is a useful number even before anything
can be done with it.

### Contradictions (`contradictions`)

Report-only, by design and permanently: the system tells you two things
disagree and does not pick a winner.

**This count is structurally zero on the free tier**, because contradiction
detection is a model phase. A zero here means "nothing looked" unless the
bundle also says `coverage: "materialized"`. Check that before you read a zero
as good news.

### Pending debt (`pending_debt`)

How much has arrived that the model phases have not been over yet. On a free
tier brain this only goes up, and that is what the occasional upgrade notice is
counting. On a paid brain a large number after a cycle means a cycle stopped
early — usually a spend cap.

## A second pass worth doing

Call `entity` on the three to five people who came up most this week. It costs
nothing, makes no model call, and it is the fastest way to notice that the
brain has two half-merged versions of the same person, or a card that says
something out of date. When you find one, correct it the ordinary way: state
the true thing through `remember`, or retract the wrong record with `forget`.

## What the review cannot tell you yet

- **Whether the brain is quietly getting worse.** The per-tenant quality
  signal is collected but has no rollup or dashboard behind it yet.
- **Whether anything is broken fleet-side.** There is no health rollup. With
  one database per person, silent degradation is invisible until somebody
  complains — during the alpha, you are that somebody.
- **What changed in the product.** There is no per-brain change channel yet, so
  behaviour can shift between deployments with no notice in the bundle.

All three are named work, and all three are tracked on the alpha-exit
checklist: [`docs/alpha-exit.md`](../alpha-exit.md).

## Related

- [Daily briefing](daily-briefing.md) — the same tool, every morning, and the
  cursor this recipe shares with it.
- [Capture](capture.md) — where most of what this review reads comes from.
