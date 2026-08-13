# Recipe — the weekly review

**Trigger:** once a week, by hand or on a schedule.
**Action:** one `briefing` over a seven-day window, then a short pass over
what it flags.
**Preview:** run it by hand the first time. The first week's output is the one
that tells you whether the brain has enough in it to be worth reviewing.

---

## Read this first: what the seven days cover

`briefing` takes a `since` and an `until`, and **naming a `since` is what makes
this recipe weekly.** Every windowed section then runs over the week you asked
for, including the delta.

| Section | Over the seven-day window? |
|---|---|
| `meetings` | **Yes** — meetings *happening* in the window, at most 20. Each carries `occurred_at` beside `created_at`. |
| `delta.changed`, `delta.stated` | **Yes**, because you named a `since`. The response says so: `delta.basis` is `"window"`. |
| `stale` | **Yes** — things that went stale inside the window. Something that rotted in April needs a wider `since`. |
| `commitments`, `counts` | Point in time, not a window. What is open and what is queued right now. |

**Run it on whatever connection you like, as often as you like.** A call that
names a `since` reads across the connection's bookmark without moving it, so
this review takes nothing from [the daily briefing](daily-briefing.md) and the
daily takes nothing from it. That is a deliberate rule and not a coincidence: a
query is not a bookmark advance.

The consequence worth knowing in advance is the mirror of the old one: **a
weekly review re-shows things the daily already showed you.** Seven days is
seven days, every time you ask. If you want "what has arrived since I last
looked", drop the `since` — but then you are running the daily recipe, on the
daily's bookmark.

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

> **Alpha limitation: there is nowhere to close one from, and that is by
> design rather than by omission.** The queue records who closed an entry, and
> the database itself admits only two answers — a decision you took out of
> band, or one the system derived internally. `agent_mcp` is refused by a CHECK
> constraint, because the assistant holding your tools is the same assistant
> reading your mail: a crafted message that talked it into approving a proposal
> would be the whole gate, defeated.
>
> So the close has to arrive from a surface the connected agent cannot drive —
> the in-chat panel (**U14**) or the web app (**U15**). U14 has now shipped, and
> it **deliberately did not add one**. `manage` gained four working settings and
> carries no review action, for a reason worth reading rather than taking on
> trust:
>
> - The panel is the surface that would qualify, and on the shipping clients it
>   does not render for a connector you added yourself. A close that only the
>   panel could reach would be a control nobody can exercise — which looks
>   identical to a control that works, until you need it.
> - The other route is your assistant asking you to confirm. That is a real
>   control for reversible settings, and it is the wrong one here: your
>   assistant issued the call, worded the context you read it in, and read the
>   mail that prompted it. Approving inside that turn is not the independent
>   decision the constraint is asking for.
>
> **So the close lands with the web app (U15), and until then nothing your
> assistant can do closes a review entry.** That is the same sentence as before;
> what changed is that it is now a decision with a named owner rather than a
> gap.

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

### What U14 did give you

The `brain` tool now carries a `management` block: your spend cap, your reading
posture, which connectors are paused, and the exact call for each thing you can
change. Ask your assistant "what can I change about my brain" and it reads that.

Three of the four changes run in chat, and every one of them asks you first —
your client has to be able to put the question in front of you, and if it
cannot, the call is refused with a link rather than made. The fourth, the
reading posture, is web-app-only on a chat connection for the same reason the
review close is: it is not a thing to be waved through inside a turn your
assistant is driving.

None of these touch the review queue.

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
  bookmark this recipe reads across without moving.
- [Capture](capture.md) — where most of what this review reads comes from.
