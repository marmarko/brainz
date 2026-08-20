-- ===========================================================================
-- brainz tenant schema — rung 22, what a model phase has already looked at
--
-- Four nullable integer columns, one per phase that could not previously say
-- what it had finished. They exist because of a measured incident that three
-- previous rungs each fixed one link of, and that two opposite designs each
-- half-fixed and half-broke.
--
-- ---------------------------------------------------------------------------
-- **The failure, and why it had two faces.**
--
-- A brain of 5,608 pages sat at 167 facts for hours, reporting the same line
-- every cycle: the cycle stopped in `synopsis`, on one page the provider was
-- answering with a 500. A model phase that stops stops the cycle; a cycle that
-- stopped short left its run OPEN, because that null `finished_at` was the
-- resume signal; and a model phase holding a checkpoint against an open run is
-- skipped on every resume. So `extract`, banked by the first cycle, was skipped
-- by every cycle after it — called ONCE in the whole of it.
--
-- The obvious fix is to close the run whatever stopped the cycle. It was built,
-- measured against the same brain, and reverted: with the run closed, `extract`
-- is re-paid every single cycle and `enrich`, `synopsis`, `contradiction` and
-- `salience_refine` are never reached at all. The old code escaped precisely
-- BECAUSE the open run carried `extract`'s checkpoint forward.
--
-- Both faces have one cause, and it is not the run's lifetime. Per phase:
--
--     transcribe       attachment.ocr_text IS NULL          content-durable
--     extract          every live ingested chunk            NO RECORD
--     enrich           every live entity                    NO RECORD
--     synopsis         no summary page exists yet           content-durable
--     contradiction    every live fact                      NO RECORD
--     salience_refine  every ingested page                  NO RECORD
--
-- The two content-durable phases re-select only work nobody has done, so a run
-- that closes costs them nothing. The other four could say nothing about their
-- own progress, so a per-RUN checkpoint row was the only thing standing between
-- a second cycle and a second invoice — and a per-run row cannot be kept without
-- keeping the run, which is the freeze.
--
-- These columns give those four the same kind of durability the other two
-- already had. With them, closing the run costs nothing, because there is
-- nothing left that a closed run would make anybody pay for twice.
--
-- ---------------------------------------------------------------------------
-- **"Considered", not "produced something".**
--
-- The stamp is written for every row the phase sent to the model and got a
-- readable answer about, whether or not the row yielded anything. Keying it on
-- output instead was refused on an ordinary case: a calendar invite or a
-- one-line email states no factual claim, so under a yields-a-fact rule it is
-- never done — it stays at the top of the salience-ordered queue and is re-sent
-- every cycle forever, with every chunk behind it waiting. The batch would be
-- pinned by exactly the rows with nothing in them.
--
-- ---------------------------------------------------------------------------
-- **Why a version rather than a boolean or a timestamp.**
--
-- A durable marker's price is that a deliberate re-run needs a door, and a bare
-- flag leaves only one: an operator writing UPDATE over a content table by hand.
-- An integer gives the code the door. A row carries the version that considered
-- it; a selector takes rows whose stamp is absent or lower than the version it
-- runs at; and `src/worker/consolidate/consideration.ts` holds one number per
-- phase, bumped in the same commit as whatever made the old answers not worth
-- keeping — a rewritten prompt, a changed gate, or a different model behind that
-- phase's op. Bumping means one thing: the corpus is a candidate again for that
-- phase, once.
--
-- A timestamp would look equivalent and is not — "re-consider everything stamped
-- before this instant" needs the instant written down somewhere anyway, and that
-- somewhere is a second source of truth for a decision the code already makes.
--
-- `integer`, not `smallint`, for rung 21's reason: a number that grows for as
-- long as the system is maintained should not have a ceiling anybody can reach,
-- and an overflow inside a phase would be a fresh way for the cycle to break.
--
-- **Nullable with no backfill, and the null is load-bearing.** NULL means "no
-- phase has looked at this row", which is the truth about every row that exists
-- when this rung lands: nothing here can honestly claim a chunk was extracted
-- from, and rung 17 records the objection to rewriting rows to a state inferred
-- after the fact. The cost is one full pass per phase over the existing corpus
-- on the first cycles after upgrade, after which each converges and stops.
-- Nullable is also what keeps the rung expand-only — every INSERT the previous
-- fleet version issues names the old column list and must keep working.
--
-- ---------------------------------------------------------------------------
-- **Four columns rather than one shared side table.**
--
-- The alternative is a table keyed by (phase, row kind, row id). It buys nothing
-- here and costs three things: the key would be polymorphic across four
-- different id columns, so no foreign key and no cascade when the row it
-- describes is deleted; every candidate query gains an anti-join against a table
-- that grows with the corpus; and the marker would outlive the row it is about.
-- On the row, the stamp goes when the row goes and the predicate is a column
-- read.
--
-- The columns are named for the PHASE, not for the op. `page` is written by the
-- deterministic `salience` phase as well as by `salience_refine`, and a column
-- called `salience_considered_version` would read as the other one's.
--
-- **These columns carry no content and cannot start to.** An integer has no room
-- for a page title, a provider's sentence or an excerpt — the temptation rung 19
-- named and rungs 20 and 21 met is answered here by shape rather than by
-- discipline. The tables are the tenant's most content-bearing ones, which is
-- the argument for the shape and not against the rung.
--
-- ---------------------------------------------------------------------------
-- **The indexes, and why they are plain.**
--
-- The predicate every selector adds is `col IS NULL OR col < $version`, and the
-- state a healthy brain spends nearly all of its time in is the converged one,
-- where that returns nothing. Without an index each cycle seq-scans the whole
-- chunk, entity, fact and page tables to discover it has nothing to do.
--
-- Plain btree rather than partial `WHERE col IS NULL`: the partial index is
-- tighter today and stops serving the query the moment a version is bumped,
-- which is the one occasion the scan is over a full corpus and the index matters
-- most. A btree stores NULLs, so it answers both halves of the predicate.
-- ===========================================================================

ALTER TABLE chunk  ADD COLUMN extract_considered_version         integer;
ALTER TABLE entity ADD COLUMN enrich_considered_version          integer;
ALTER TABLE fact   ADD COLUMN contradiction_considered_version   integer;
ALTER TABLE page   ADD COLUMN salience_refine_considered_version integer;

ALTER TABLE chunk ADD CONSTRAINT chunk_extract_considered_version_is_a_version CHECK (
  extract_considered_version IS NULL OR extract_considered_version >= 1
);
ALTER TABLE entity ADD CONSTRAINT entity_enrich_considered_version_is_a_version CHECK (
  enrich_considered_version IS NULL OR enrich_considered_version >= 1
);
ALTER TABLE fact ADD CONSTRAINT fact_contradiction_considered_version_is_a_version CHECK (
  contradiction_considered_version IS NULL OR contradiction_considered_version >= 1
);
ALTER TABLE page ADD CONSTRAINT page_salience_refine_considered_version_is_a_version CHECK (
  salience_refine_considered_version IS NULL OR salience_refine_considered_version >= 1
);

CREATE INDEX chunk_extract_considered ON chunk (extract_considered_version);
CREATE INDEX entity_enrich_considered ON entity (enrich_considered_version);
CREATE INDEX fact_contradiction_considered ON fact (contradiction_considered_version);
CREATE INDEX page_salience_refine_considered ON page (salience_refine_considered_version);

COMMENT ON COLUMN chunk.extract_considered_version IS 'operational — the consideration version at which the extraction phase last sent this chunk to the model and got a readable answer, or NULL if it never has. Written whether or not the chunk yielded a fact: a chunk that states no claim would otherwise pin the salience-ordered batch forever.';
COMMENT ON COLUMN entity.enrich_considered_version IS 'operational — the consideration version at which the enrichment phase last sent this entity to the model and got a readable answer, or NULL if it never has. Written whether or not a card was written.';
COMMENT ON COLUMN fact.contradiction_considered_version IS 'operational — the consideration version at which this fact was last part of a batch the contradiction phase sent and got a readable answer about, or NULL if it never was. Written whether or not a conflict was reported.';
COMMENT ON COLUMN page.salience_refine_considered_version IS 'operational — the consideration version at which the salience-refinement phase last sent this page to the model and got a readable answer, or NULL if it never has. Written whether or not the model returned a score for it.';
