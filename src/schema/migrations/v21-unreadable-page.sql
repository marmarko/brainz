-- ===========================================================================
-- brainz tenant schema — rung 21, a page the model can never read
--
-- Two columns on `page` and one widened CHECK on `consolidation_run`, and they
-- exist because rung 20's diagnosis was correct and the repair it enabled was
-- not enough.
--
-- ---------------------------------------------------------------------------
-- **The failure, one link further down than rung 20 could see.**
--
-- A production brain sat at 5,608 pages and 167 facts. Rung 20 named the cause:
-- the cycle stopped in `synopsis`, on a page the model would not summarise. The
-- first repair let the phase SKIP that page and carry on — and skipping defers
-- the freeze rather than removing it. The candidate query excludes a page only
-- once a summary row exists for it, and a skipped page writes nothing. So every
-- usable page leaves the candidate set and every unusable one stays. The set
-- converges monotonically onto the unusable pages; the ordering key is fixed, so
-- they end up adjacent at its head; the phase's consecutive-failure bound then
-- trips on the first three calls of every cycle with nothing applied. The
-- terminal state is the state the skip was written to fix — the cycle stops, the
-- run stays open, and a model phase holding a checkpoint against an open run is
-- skipped on every resume, which is what pinned extraction and therefore the
-- fact count.
--
-- The link that has to break is the candidate set. `page.quarantined_at` already
-- exists and the candidate query already honours it; nothing set it from this
-- path. These columns are what make setting it defensible.
--
-- ---------------------------------------------------------------------------
-- **`consolidation_refusals` — the evidence a page must accumulate first.**
--
-- Quarantining on a transient failure is a WORSE bug than the freeze, and the
-- asymmetry is the whole design constraint: the freeze is loud — it is on the
-- run record, in the cycle log and in a fact count that stops moving — while a
-- page wrongly dropped from consolidation is silent. The user is never told that
-- the brain stopped reading something.
--
-- So a page earns its way out of the set. The counter is incremented only by a
-- DURABLE refusal (`src/worker/consolidate/model-phases.ts`), and a phase run
-- tries a given page at most once, so reaching the threshold necessarily spans
-- more than one cycle and more than one independent answer from the model. A
-- provider that is rate-limiting or down increments nothing at all, however long
-- the outage lasts and however many pages it touches.
--
-- `smallint NOT NULL DEFAULT 0` rather than nullable: "this page has never been
-- refused" and "nobody has looked" are the same state here, and a nullable
-- counter would invite a reader to distinguish them. The DEFAULT is what keeps
-- the rung expand-only — every INSERT the previous fleet version issues names
-- the old column list and must keep working.
--
-- ---------------------------------------------------------------------------
-- **`quarantine_reason` — a code, and never the page.**
--
-- Rung 20's discipline, applied to the table that holds the user's own words:
-- the reason is one of a closed vocabulary the CHECK enumerates, so no title, no
-- excerpt and no provider sentence can be filed here. The temptation is the same
-- one rung 20 recorded — the obvious "improvement" on "this page was retired" is
-- to say what it was about — and the refusal is again held by the database
-- rather than by whoever writes the next materializer.
--
-- The vocabulary is a subset of `PHASE_STOPS`: the two codes a per-item model
-- phase can attribute to the item itself. `budget_exhausted`, `out_of_time`,
-- `model_unavailable` and `payload_unavailable` are excluded on purpose — none
-- of them is anything the page did, so none of them may ever appear here.
--
-- **Together they are the operator's whole view**, and it is deliberately two
-- numbers and a word rather than a report:
--
--     SELECT quarantine_reason, count(*)
--       FROM page
--      WHERE quarantined_at IS NOT NULL AND quarantine_reason IS NOT NULL
--      GROUP BY quarantine_reason;
--
-- **Un-quarantining is one statement, and it must clear the counter too:**
--
--     UPDATE page
--        SET quarantined_at = NULL, quarantine_reason = NULL, consolidation_refusals = 0
--      WHERE page_id = <id>;
--
-- Leaving `consolidation_refusals` alone would put the page one durable refusal
-- from re-quarantine, so an operator's judgement call would survive exactly one
-- cycle and look like it had not been applied at all.
--
-- ---------------------------------------------------------------------------
-- **The widened CHECK, and why a drop is admissible here.**
--
-- Rung 20 spelled `PHASE_STOPS` into `consolidation_run_stopped_phase_code_is_known`.
-- `input_rejected` joins that vocabulary — the distinction between "the provider
-- was unavailable" and "the provider refused what we sent" is what licenses the
-- quarantine above, so the run record has to be able to say which one happened.
-- The DROP is paired with an ADD of the same constraint name in this same rung,
-- which is the one shape `findExpandContractViolations` admits, and the
-- replacement is strictly WIDER: every code the previous fleet version can write
-- is still accepted, so an instance that has never heard of `input_rejected`
-- keeps writing run records through a rolling deploy.
--
-- The narrowing risk a widening rung carries — a code silently dropped from the
-- replacement — is held by `test/consolidate/schema.test.ts`, which asserts
-- against a live database that the alphabet the CHECK accepts is exactly
-- `PHASE_STOPS`, in both directions.
--
-- **Additive, and no backfill.** A page quarantined before this rung was
-- quarantined by U9's junk gate for a different reason, and has no
-- `quarantine_reason` to be given. Inferring one would be inventing history,
-- which is the objection rung 17 records against rewriting rows to a cause
-- derived later.
-- ===========================================================================

ALTER TABLE page ADD COLUMN consolidation_refusals smallint NOT NULL DEFAULT 0;
ALTER TABLE page ADD COLUMN quarantine_reason text;

ALTER TABLE page ADD CONSTRAINT page_consolidation_refusals_are_counted CHECK (
  consolidation_refusals >= 0
);

-- The two codes a per-item model phase can attribute to the item. See above for
-- why the other four members of `PHASE_STOPS` are not here.
ALTER TABLE page ADD CONSTRAINT page_quarantine_reason_is_a_code CHECK (
  quarantine_reason IS NULL
  OR quarantine_reason IN ('input_rejected', 'bad_output')
);

-- A reason with no quarantine is a page describing a retirement that did not
-- happen. The converse is allowed and is not an oversight: U9's junk gate has
-- been setting `quarantined_at` alone since rung one, and every one of those
-- rows predates this vocabulary.
ALTER TABLE page ADD CONSTRAINT page_quarantine_reason_needs_a_quarantine CHECK (
  quarantine_reason IS NULL OR quarantined_at IS NOT NULL
);

-- `PHASE_STOPS`, widened by one. Dropped and re-added under the same name, which
-- is the paired shape the expand-only scanner admits; see the header.
ALTER TABLE consolidation_run DROP CONSTRAINT consolidation_run_stopped_phase_code_is_known;
ALTER TABLE consolidation_run ADD CONSTRAINT consolidation_run_stopped_phase_code_is_known CHECK (
  stopped_phase_code IS NULL
  OR stopped_phase_code IN ('budget_exhausted', 'model_unavailable', 'input_rejected',
                            'bad_output', 'payload_unavailable', 'out_of_time')
);
