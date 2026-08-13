# Recipe — capture

**Trigger:** you tell your assistant something durable about yourself, your
people, your preferences or your decisions.
**Action:** it calls `remember`, in your words, in the same turn.
**Preview:** say one thing, then ask it to read the thing back.

The server already instructs every connected assistant to do this, so on a good
day you do not have to ask. This recipe is about what to say when it does not,
and about what the brain does with it afterwards — because a brain that is
written to and never consulted, or consulted and never written to, is the two
ways this product fails quietly.

---

## The habit

Say the durable thing out loud, in a normal sentence. You do not need a
keyword, and you do not need to say "remember" — though saying it works and is
the fastest way to be sure.

Things worth storing look like this:

```
Remember that I do not take meetings before 10.
Remember that alice-example moved to widget-co in March, running operations.
Remember that we decided against the second vendor because of the data
  processing terms, not the price.
Remember that fund-b's partner is the one who introduced me to acme-example.
Remember that I am allergic to shellfish.
```

Two rules make the habit pay:

1. **Say it as a fact, not as a note to self.** "alice-example runs ops at
   widget-co" is retrievable by anyone asking about alice-example. "Follow up
   with Alice" is retrievable by nobody.
2. **Restating is free.** A statement the brain already holds returns
   `duplicate` and writes nothing. There is no penalty for telling it something
   twice, which means there is no reason to hesitate over whether you already
   did.

## What `remember` does with it

- **It stores your words**, not a summary of them. A title is optional and only
  useful for a longer note.
- **The origin is decided by the credential, never by the model.** There is no
  parameter that lets an assistant choose where a memory lands, because
  choosing the origin means choosing which fence it sits behind.
- **A duplicate writes nothing** and returns the id of what already exists.
- **It suggests reading it back.** The response carries a follow-up call so
  your assistant can confirm the memory is stored the way you meant it. Let it.
- **It counts one unit of consolidation work** — a duplicate counts zero,
  because nothing happened.

## What happens afterwards

Consolidation runs on a schedule with no involvement from you. It is phased,
cheapest work first, and it checkpoints as it goes so an interrupted cycle
never pays twice.

**Always, on every tier — the deterministic phases:**

- duplicate facts are collapsed
- entities that are obviously the same person or company are merged by rule
- links between entities are reconciled
- superseded and cancelled things are marked stale
- a first-pass relevance score is computed
- near-identical content is clustered

**Only on the paid tier — the model phases:**

- images and PDFs are transcribed
- facts and commitments are extracted from ingested content
- entity cards are written
- summaries are produced
- contradictions are reported
- relevance is refined

So a free-tier brain deduplicates, merges, links, ages and scores — and never
produces participant cards, extracted commitments, contradiction reports or
the summary layer. That line is drawn deliberately, and the briefing names what
is missing rather than quietly returning less.

## Reading it back

Consulting is the other half of the habit, and it is the half an assistant
skips first. Three ways in:

- `recall` — ask a question in your own words. This is the ranked read.
- `entity` — one named person, company or project as a card. No model call, and
  it never errors on a miss; it returns suggestions instead.
- `briefing` — the standing bundle for a moment. See
  [the daily briefing recipe](daily-briefing.md).

`recall` has **no date filter**, on purpose: a declared parameter the handler
ignored would return unfiltered results with no error, which is worse than not
offering it. "What happened last week" is a `briefing` question, not a `recall`
question.

## Correcting yourself

- **Wrong fact:** `forget` retracts one record by id. It stops being returned
  immediately and stays recoverable for 72 hours. Nothing is erased by that
  call.
- **Changed fact:** just say the new one. Superseding is what the brain is for,
  and conflicting claims are reported rather than silently resolved — nothing
  is overwritten behind your back.

## Files, screenshots and voice memos

`remember` takes text and only text. If your assistant tells it that a file is
involved, it answers with a typed refusal that names what this brain can and
cannot read, and the file itself never travels through the tool.

- **Readable:** PNG, JPEG, WebP, GIF, and PDF.
- **Declined by name:** audio and video. A voice memo is a feature that does
  not exist, and you get told that rather than getting silence.
- **Unrecognised types are refused**, not stored on the hope that something
  downstream copes.

Readable files get in through a connected source or an import, not through
`remember`. Once in, the original is preserved and the text is pulled out
during consolidation — which puts it in the model tier.

> **Alpha limitation worth knowing.** Transcription is a model phase, so a
> free-tier brain never transcribes anything — including a PDF that carries its
> own text layer and would need no model call to read. The cheap path exists
> and is taken first, but the phase it lives in does not run on the free tier.
> Screenshots being findable by their text is a paid-tier property today.

## What not to store

Passwords, API keys and anything else you would not want read back to you by an
assistant in a room with other people. The brain has no secret class; a
`remember` is content, and content is what gets retrieved.

## Related

- [Daily briefing](daily-briefing.md) — the standing morning read.
- [Weekly review](weekly-review.md) — what to do with what capture accumulates.
