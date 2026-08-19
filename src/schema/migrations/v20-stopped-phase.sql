-- ===========================================================================
-- brainz tenant schema — rung 20, which phase the cycle stopped in
--
-- Two nullable columns on `consolidation_run`, and they exist because of a
-- measured outage rather than a wish for more telemetry.
--
-- A production brain ran cycle after cycle at `stop_reason = 'phase_failed'`
-- with its fact count flat: 5,608 pages, 167 facts, unchanged across attempts.
-- Everything that could have named the cause existed — the cycle builds a
-- `PhaseRecord` per phase carrying that phase's own stopped code — and none of
-- it was durable. It lived in the worker's memory for the length of an attempt
-- and reached one line of the container's stdout, which nothing outside the
-- container can read. `consolidation_run` kept the aggregate reason and nothing
-- else, so "a phase failed" was the whole of the diagnosis available to anybody
-- who was not attached to the process.
--
-- This is the same gap that made an ingest outage last ten hours, and it is
-- closed the same way: carry the real code onto a row somebody can query. There
-- the code went to `control.connector_health` and named the cause in one cycle
-- after months of an undifferentiated `provider_error`.
--
-- ---------------------------------------------------------------------------
-- **A failure reason is a code and a timestamp, not a subject line.**
--
-- Both columns are closed vocabularies drawn from `src/worker/consolidate/
-- phases.ts` — `CYCLE_PHASES` and `PHASE_STOPS` — and the CHECKs are what keep
-- them that way. The temptation on this table is specific and strong: the
-- obvious "improvement" on "synopsis stopped" is to record *what it was
-- summarising*, and a page title in an operational table is a leak with a
-- plausible motive. A CHECK against twelve phase names and five codes is the
-- refusal, held by the database rather than by whoever writes the next
-- materializer. `test/consolidate/schema.test.ts` asserts the alphabet the
-- database accepts is exactly the alphabet the code can produce, in both
-- directions, so a phase added to `phases.ts` cannot start failing its own run
-- record's CHECK at the moment somebody needs to read it.
--
-- Rung 3 already classified `consolidation_run` as operational, and it stays
-- operational: a phase name, a stop code, and no sentence anybody wrote.
--
-- ---------------------------------------------------------------------------
-- **Why the pair is not tied to `stop_reason` or `dreamt` by a CHECK.**
--
-- It would read well — "a run that dreamt claims no stopped phase" — and it
-- would break a rolling deploy. `SCHEMA_LOOKAHEAD` is 1, so an instance running
-- the release *before* this rung serves a tenant this rung has migrated. That
-- instance can resume a run a newer instance attributed, complete it, and issue
-- the UPDATE it has always issued — one that names `dreamt`, `stop_reason` and
-- `finished_at` and cannot name columns it has never heard of. A cross-column
-- CHECK would refuse that write, which is precisely the outage the expand-only
-- ladder exists to prevent, arriving from the one direction static analysis does
-- not look.
--
-- So the invariant lives where it can be enforced without refusing anybody:
-- `finishRun` and `recordProgress` both write the pair on **every** call, the
-- current attempt's attribution or NULL, and `test/consolidate/cycle.test.ts`
-- holds them to it. That also fixes the stale-attribution case a
-- write-only-when-set writer would have — a run stays open across attempts and
-- the same row is rewritten, so a cycle that succeeds after one that failed must
-- clear the phase the failed one named.
--
-- **Additive, and no backfill.** A run that completed before this rung has no
-- stopped phase and must not be given one; inferring an attribution after the
-- fact would be inventing history, which is the objection rung 17 records
-- against rewriting `ingest_log` rows to a cause derived later.
-- ===========================================================================

ALTER TABLE consolidation_run ADD COLUMN stopped_phase text;
ALTER TABLE consolidation_run ADD COLUMN stopped_phase_code text;

-- `CYCLE_PHASES`, in order: the deterministic tier then the metered one.
ALTER TABLE consolidation_run ADD CONSTRAINT consolidation_run_stopped_phase_is_known CHECK (
  stopped_phase IS NULL
  OR stopped_phase IN ('dedup', 'link_reconcile', 'staleness', 'entity_merge', 'salience', 'cluster',
                       'transcribe', 'extract', 'enrich', 'synopsis', 'contradiction', 'salience_refine')
);

-- `PHASE_STOPS`. Deliberately NOT the `stop_reason` alphabet: `complete`,
-- `free_tier` and `cancelled` are things a run does, and a phase never reports
-- one. Admitting them would make this column mean two things and make "which
-- code did the phase stop with" unanswerable.
ALTER TABLE consolidation_run ADD CONSTRAINT consolidation_run_stopped_phase_code_is_known CHECK (
  stopped_phase_code IS NULL
  OR stopped_phase_code IN ('budget_exhausted', 'model_unavailable', 'bad_output',
                            'payload_unavailable', 'out_of_time')
);

-- Half an attribution is not an attribution. A phase with no code says a cycle
-- stopped somewhere for no stated reason, and a code with no phase is the
-- aggregate `stop_reason` again under a second name. Safe against the previous
-- fleet version because it writes neither column: NULL and NULL satisfies it.
ALTER TABLE consolidation_run ADD CONSTRAINT consolidation_run_stopped_phase_is_whole CHECK (
  (stopped_phase IS NULL) = (stopped_phase_code IS NULL)
);
