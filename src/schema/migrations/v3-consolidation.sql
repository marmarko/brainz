-- ===========================================================================
-- brainz tenant schema — rung 3, consolidation (U11)
--
-- Rung one is chunk storage; rung two is the knowledge core the write path
-- fills in. This rung is what the *cycle* needs: a record of each run, a
-- resumable checkpoint per phase, the artifacts the model tier materializes
-- (entity cards, commitments), the queue a mid-confidence proposal waits in,
-- the clusters the deterministic tier finds, and — on rows rung two already
-- ships — the three markers everything else in U11 turns on.
--
-- **This file holds the user's own words by design**, exactly as rung two does.
-- The content-free rule is the control plane's (`src/control/schema.sql`), and
-- this file is named in `test/control/schema.test.ts`'s classification list with
-- its reason.
--
-- ---------------------------------------------------------------------------
-- Three markers, and why each is a column rather than a convention.
--
-- **1. `derivation` is the anti-loop guard's storage.** Model phases must never
-- re-extract from model-derived rows: cycle N+1 would read cycle N's own
-- summary as fresh evidence, the claim would gain a second "independent"
-- source, and the brain would talk itself into confidence with nothing outside
-- itself having changed. The guard has to key on something durable, because the
-- rows in question are ordinary pages and ordinary facts — there is no shape
-- that distinguishes them. `page.derivation` and `fact.derivation` are that
-- something, they are `NOT NULL DEFAULT 'ingested'` so the previous fleet
-- version's INSERTs keep working through a rolling deploy, and the CHECK is
-- what holds when a materializer is written by somebody who has not read
-- `materialize.ts`.
--
-- **2. `trust_level` is R12's, and it is on the rows a model wrote.** "Model-
-- derived knowledge carries a trust level" is only checkable if the level is
-- stored; a level computed at read time from `derivation` would be a second
-- implementation of the same claim, and the two would disagree the moment a
-- rule-derived row wanted a different level from a model-derived one.
--
-- **3. `compiled_truth` is R12a's, and it is deliberately a stored decision
-- rather than a query.** The rule is that a claim sourced solely from
-- single-origin external content is excluded from the compiled-truth boost
-- until corroborated — and *whether a row looks externally sourced is a
-- property the sender influences* (`src/core/search/boosts.ts` names three
-- forgeries that clear the naive test). So the admission is decided once, by
-- `materialize.ts`, against the shared `corroborationOf`, and written down. A
-- ranking stage that recomputed it from `source_type` would be re-opening every
-- one of those forgeries.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** No DROP, no RENAME, no ALTER COLUMN, and no
-- `ADD COLUMN … NOT NULL` without a DEFAULT. `findExpandContractViolations` in
-- `src/control/migrate.ts` scans this file, the runner scans the DDL it is about
-- to execute, and `test/schema/rollout.test.ts` re-runs the previous release's
-- literal statements against a database this rung has migrated.
--
-- **Every new table declares its class** in its own `COMMENT ON TABLE`, in the
-- vocabulary `test/schema/tenant-schema.test.ts` enumerates, and every new
-- origin column carries the shared immutability trigger — the enumeration in
-- that file and `src/schema/origin-fence.ts`'s attestation both fail on a table
-- that arrives without one.
--
-- The `{{FTS_LANGUAGE}}` placeholder is not used here: nothing this rung adds is
-- full-text indexed. A summary chunk is an ordinary `chunk` row and is indexed
-- by rung one's generated column.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- consolidation_run — one row per cycle.
--
-- `imp.cycle-run-record`: "phases, items, cost, truncation reason — that the
-- brain surface can read". The two CHECKs are the ones that make
-- "consolidated but not dreamt" a state a reader can trust rather than an
-- inference from a null:
--
--   * a finished run that did not dream must say why, so "the budget ran out"
--     and "there was nothing to do" are never the same row;
--   * a run that dreamt cannot also carry a truncation reason, because then the
--     two fields disagree and whichever one a reader believes is a coin toss.
-- ---------------------------------------------------------------------------

CREATE TABLE consolidation_run (
  run_id               bigint      GENERATED ALWAYS AS IDENTITY,

  -- Which of KTD11's triggers put this cycle here. Recorded, never inferred —
  -- the same rule `control.job` follows, and the same closed set.
  trigger_reason       text        NOT NULL,
  tier                 text        NOT NULL,

  dreamt               boolean     NOT NULL DEFAULT false,
  stop_reason          text,

  -- Both in micro-USD, derived from `src/ai/pricing.ts` and nowhere else.
  -- `estimated` is written before the first model call: "estimate before run" is
  -- a discipline only if the estimate survives to be compared against.
  estimated_micro_usd  bigint      NOT NULL DEFAULT 0,
  spent_micro_usd      bigint      NOT NULL DEFAULT 0,

  model_calls          integer     NOT NULL DEFAULT 0,
  phases_run           integer     NOT NULL DEFAULT 0,
  wall_clock_ms        integer,

  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,

  CONSTRAINT consolidation_run_pkey PRIMARY KEY (run_id),
  CONSTRAINT consolidation_run_trigger_is_known CHECK (
    trigger_reason IN ('debt_debounce', 'time_ceiling', 'user_request', 'connector_cadence')
  ),
  CONSTRAINT consolidation_run_tier_is_known CHECK (tier IN ('free', 'paid')),
  CONSTRAINT consolidation_run_stop_reason_is_known CHECK (
    stop_reason IS NULL
    OR stop_reason IN ('complete', 'free_tier', 'budget_exhausted', 'phase_failed', 'cancelled')
  ),
  CONSTRAINT consolidation_run_undreamt_runs_say_why CHECK (
    finished_at IS NULL OR dreamt OR stop_reason IS NOT NULL
  ),
  CONSTRAINT consolidation_run_dreamt_runs_completed CHECK (
    NOT dreamt OR stop_reason IS NULL OR stop_reason = 'complete'
  ),
  CONSTRAINT consolidation_run_money_is_non_negative CHECK (
    estimated_micro_usd >= 0 AND spent_micro_usd >= 0
  ),
  CONSTRAINT consolidation_run_counts_are_non_negative CHECK (
    model_calls >= 0 AND phases_run >= 0 AND (wall_clock_ms IS NULL OR wall_clock_ms >= 0)
  )
);

COMMENT ON TABLE consolidation_run IS 'operational — one row per consolidation cycle: what it was triggered by, what it cost, and why it stopped. No user content, no inference.';

CREATE INDEX consolidation_run_open ON consolidation_run (started_at DESC) WHERE finished_at IS NULL;


-- ---------------------------------------------------------------------------
-- consolidation_checkpoint — what the next cycle must not pay for again.
--
-- Keyed on the phase alone, because "where is this brain up to" has exactly one
-- answer per phase. The `run_id` is what makes a checkpoint *resumable rather
-- than permanent*: a row is only honoured while it belongs to the run being
-- resumed, so a completed cycle's checkpoints do not silently skip the next
-- cycle's work.
-- ---------------------------------------------------------------------------

CREATE TABLE consolidation_checkpoint (
  phase            text        NOT NULL,
  run_id           bigint      NOT NULL,
  items            integer     NOT NULL DEFAULT 0,
  spent_micro_usd  bigint      NOT NULL DEFAULT 0,
  completed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consolidation_checkpoint_pkey PRIMARY KEY (phase),
  CONSTRAINT consolidation_checkpoint_run_fkey FOREIGN KEY (run_id)
    REFERENCES consolidation_run (run_id) ON DELETE CASCADE,
  CONSTRAINT consolidation_checkpoint_counts_are_non_negative CHECK (
    items >= 0 AND spent_micro_usd >= 0
  )
);

COMMENT ON TABLE consolidation_checkpoint IS 'operational — one row per completed phase of the run in progress, so a killed cycle resumes without re-paying for model work it already did.';


-- ---------------------------------------------------------------------------
-- entity_card — what enrichment wrote about an entity.
--
-- Derived, so it carries the union of its inputs' origins; its one checkable
-- input is the entity it describes, and the trigger below is that check. A card
-- claiming `{personal}` over a work-fenced entity would hand a personal-fenced
-- reader a summary of a work relationship, one derivation removed — the same
-- shape rung two's four union triggers exist to refuse.
-- ---------------------------------------------------------------------------

CREATE TABLE entity_card (
  card_id            bigint      GENERATED ALWAYS AS IDENTITY,
  entity_id          bigint      NOT NULL,

  summary            text        NOT NULL,

  -- R12. Not derived from `derivation` at read time: a rule-derived card and a
  -- model-derived one want different levels, and two implementations of one
  -- claim disagree the day that distinction is made.
  trust_level        text        NOT NULL,
  derivation         text        NOT NULL,
  confidence         real,

  -- The pinned id this card was produced by (KTD13). A card whose model nobody
  -- recorded cannot be re-scored when the routing table moves.
  model_id           text,
  run_id             bigint,

  origin_contexts    text[]      NOT NULL,
  subject_context    text,
  subject_confidence real,

  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT entity_card_pkey PRIMARY KEY (card_id),
  CONSTRAINT entity_card_entity_fkey FOREIGN KEY (entity_id) REFERENCES entity (entity_id) ON DELETE CASCADE,
  CONSTRAINT entity_card_run_fkey FOREIGN KEY (run_id) REFERENCES consolidation_run (run_id) ON DELETE SET NULL,
  CONSTRAINT entity_card_trust_is_known CHECK (
    trust_level IN ('user_stated', 'rule_extracted', 'model_extracted', 'model_inferred')
  ),
  CONSTRAINT entity_card_derivation_is_known CHECK (
    derivation IN ('ingested', 'rule_derived', 'model_derived')
  ),
  CONSTRAINT entity_card_summary_is_not_empty CHECK (length(btrim(summary)) > 0),
  CONSTRAINT entity_card_confidence_is_a_probability CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT entity_card_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT entity_card_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE entity_card IS 'content:derived — enrichment''s summary of one entity; origin is the union of its inputs'' origins (R15) and it carries a trust level (R12).';

-- One live card per entity. Safe as a uniqueness promise because this rung
-- creates the table: no previous fleet version is writing to it, so nothing can
-- be failing on a duplicate it wrote before this constraint existed.
CREATE UNIQUE INDEX entity_card_one_live_per_entity ON entity_card (entity_id) WHERE deleted_at IS NULL;

CREATE TRIGGER entity_card_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON entity_card
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

CREATE FUNCTION assert_entity_card_origin_union() RETURNS trigger
LANGUAGE plpgsql AS $assert_entity_card_origin_union$
DECLARE uncovered text;
BEGIN
  SELECT source.origin INTO uncovered
  FROM (
    SELECT unnest(e.origin_contexts) AS origin
    FROM entity e
    WHERE e.entity_id = NEW.entity_id
  ) AS source
  WHERE NOT (source.origin = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'entity card % does not carry the origin % of the entity it describes (R15)', NEW.card_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the card with the full union';
  END IF;

  RETURN NULL;
END;
$assert_entity_card_origin_union$;

CREATE CONSTRAINT TRIGGER entity_card_origin_union
  AFTER INSERT OR UPDATE ON entity_card
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entity_card_origin_union();


-- ---------------------------------------------------------------------------
-- commitment — "who owes what to whom, by when", extracted.
--
-- `compiled_truth` is R12a's exclusion made durable. A commitment planted by a
-- crafted message is *recorded* — refusing to record it would throw away the
-- evidence a user needs to see the attempt — and it is not admitted to the
-- surface that gets the compiled-truth ranking boost until an origin the sender
-- cannot write vouches for it.
-- ---------------------------------------------------------------------------

CREATE TABLE commitment (
  commitment_id      bigint      GENERATED ALWAYS AS IDENTITY,
  fact_id            bigint,
  page_id            bigint,

  statement          text        NOT NULL,
  owner_name         text,
  due_on             date,
  state              text        NOT NULL DEFAULT 'open',

  trust_level        text        NOT NULL,
  derivation         text        NOT NULL,
  compiled_truth     boolean     NOT NULL DEFAULT false,
  confidence         real,

  model_id           text,
  run_id             bigint,

  origin_contexts    text[]      NOT NULL,
  subject_context    text,
  subject_confidence real,

  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT commitment_pkey PRIMARY KEY (commitment_id),
  CONSTRAINT commitment_fact_fkey FOREIGN KEY (fact_id) REFERENCES fact (fact_id) ON DELETE CASCADE,
  CONSTRAINT commitment_page_fkey FOREIGN KEY (page_id) REFERENCES page (page_id) ON DELETE CASCADE,
  CONSTRAINT commitment_run_fkey FOREIGN KEY (run_id) REFERENCES consolidation_run (run_id) ON DELETE SET NULL,
  CONSTRAINT commitment_state_is_known CHECK (state IN ('open', 'done', 'dropped')),
  CONSTRAINT commitment_trust_is_known CHECK (
    trust_level IN ('user_stated', 'rule_extracted', 'model_extracted', 'model_inferred')
  ),
  CONSTRAINT commitment_derivation_is_known CHECK (
    derivation IN ('ingested', 'rule_derived', 'model_derived')
  ),
  CONSTRAINT commitment_statement_is_not_empty CHECK (length(btrim(statement)) > 0),
  CONSTRAINT commitment_confidence_is_a_probability CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT commitment_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT commitment_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE commitment IS 'content:derived — an obligation extracted from the corpus; origin is the union of its inputs'' origins (R15), and compiled_truth records R12a''s admission decision.';

CREATE INDEX commitment_open ON commitment (due_on) WHERE state = 'open' AND deleted_at IS NULL;

CREATE TRIGGER commitment_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON commitment
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

CREATE FUNCTION assert_commitment_origin_union() RETURNS trigger
LANGUAGE plpgsql AS $assert_commitment_origin_union$
DECLARE uncovered text;
BEGIN
  SELECT source.origin INTO uncovered
  FROM (
    SELECT unnest(f.origin_contexts) AS origin FROM fact f WHERE f.fact_id = NEW.fact_id
    UNION ALL
    SELECT p.origin_context AS origin FROM page p WHERE p.page_id = NEW.page_id
  ) AS source
  WHERE NOT (source.origin = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'commitment % does not carry the origin % of the row it was extracted from (R15)', NEW.commitment_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the commitment with the full union';
  END IF;

  RETURN NULL;
END;
$assert_commitment_origin_union$;

CREATE CONSTRAINT TRIGGER commitment_origin_union
  AFTER INSERT OR UPDATE ON commitment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_commitment_origin_union();


-- ---------------------------------------------------------------------------
-- review_queue — R12's middle band, and R12a's closing rule.
--
-- A proposal between 0.5 and 0.8 confidence is neither applied nor discarded.
-- What closes it is the constraint worth reading twice: **`agent_mcp` is not in
-- the set.** R12a says a restatement arriving over `/mcp` marks a claim restated
-- and clears nothing, because the assistant holding `remember` is the same
-- assistant reading the attacker's mail. Leaving that to a code-level check
-- would put the whole rule one forgotten branch away from being false.
-- ---------------------------------------------------------------------------

CREATE TABLE review_queue (
  review_id          bigint      GENERATED ALWAYS AS IDENTITY,

  kind               text        NOT NULL,
  -- `table:id`, opaque here. Deliberately not a foreign key: the queue outlives
  -- proposals about rows that a later cycle superseded, and a cascade would
  -- delete the record of a decision nobody made.
  target_ref         text        NOT NULL,
  proposal           text        NOT NULL,
  confidence         real        NOT NULL,

  state              text        NOT NULL DEFAULT 'open',
  closed_by          text,
  closed_at          timestamptz,

  run_id             bigint,

  origin_contexts    text[]      NOT NULL,
  subject_context    text,
  subject_confidence real,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT review_queue_pkey PRIMARY KEY (review_id),
  CONSTRAINT review_queue_run_fkey FOREIGN KEY (run_id) REFERENCES consolidation_run (run_id) ON DELETE SET NULL,
  CONSTRAINT review_queue_kind_is_known CHECK (
    kind IN ('entity_merge', 'entity_card', 'commitment', 'fact', 'fact_supersede', 'contradiction')
  ),
  CONSTRAINT review_queue_state_is_known CHECK (state IN ('open', 'applied', 'dismissed')),
  -- R12a: an out-of-band action, or an internally-derived one. Never the agent.
  CONSTRAINT review_queue_closed_by_is_out_of_band CHECK (
    closed_by IS NULL OR closed_by IN ('user_out_of_band', 'internal')
  ),
  CONSTRAINT review_queue_closed_entries_say_who CHECK (
    (state = 'open' AND closed_by IS NULL AND closed_at IS NULL)
    OR (state <> 'open' AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
  ),
  CONSTRAINT review_queue_confidence_is_a_probability CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT review_queue_proposal_is_not_empty CHECK (length(btrim(proposal)) > 0),
  CONSTRAINT review_queue_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT review_queue_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE review_queue IS 'content:derived — a mid-confidence proposal awaiting a decision; it quotes the change it proposes, so it carries the origin union of what it quotes (R15).';

CREATE INDEX review_queue_open ON review_queue (created_at DESC) WHERE state = 'open';

CREATE TRIGGER review_queue_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON review_queue
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');


-- ---------------------------------------------------------------------------
-- content_cluster / cluster_member — the deterministic tier's embedding-space
-- clustering.
--
-- **Neither carries an origin, and that is the same call `fact_source` makes.**
-- A membership row asserts nothing beyond the join, and every read of a cluster
-- goes through `chunk`, which is fenced. Giving these an origin union would mean
-- maintaining a second copy of a fence that already holds one join away, and a
-- second copy of a fence is how the two disagree.
-- ---------------------------------------------------------------------------

CREATE TABLE content_cluster (
  cluster_id   bigint      GENERATED ALWAYS AS IDENTITY,
  method       text        NOT NULL,
  run_id       bigint,
  member_count integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_cluster_pkey PRIMARY KEY (cluster_id),
  CONSTRAINT content_cluster_run_fkey FOREIGN KEY (run_id) REFERENCES consolidation_run (run_id) ON DELETE SET NULL,
  CONSTRAINT content_cluster_method_is_known CHECK (method IN ('embedding_greedy')),
  CONSTRAINT content_cluster_member_count_is_non_negative CHECK (member_count >= 0)
);

COMMENT ON TABLE content_cluster IS 'operational — one embedding-space cluster found by the deterministic tier; an artifact record, fenced through the chunks it joins to.';

CREATE TABLE cluster_member (
  cluster_id bigint NOT NULL,
  chunk_id   bigint NOT NULL,
  similarity real,

  CONSTRAINT cluster_member_pkey PRIMARY KEY (cluster_id, chunk_id),
  CONSTRAINT cluster_member_cluster_fkey FOREIGN KEY (cluster_id) REFERENCES content_cluster (cluster_id) ON DELETE CASCADE,
  CONSTRAINT cluster_member_chunk_fkey FOREIGN KEY (chunk_id) REFERENCES chunk (chunk_id) ON DELETE CASCADE,
  -- One cluster per chunk: a chunk counted in two clusters would report the same
  -- recurring theme twice from one row.
  CONSTRAINT cluster_member_belongs_to_one_cluster UNIQUE (chunk_id),
  CONSTRAINT cluster_member_similarity_is_bounded CHECK (
    similarity IS NULL OR (similarity >= -1 AND similarity <= 1)
  )
);

COMMENT ON TABLE cluster_member IS 'operational — the membership edge from a cluster to a chunk; it carries no origin of its own because it asserts nothing beyond the join.';


-- ---------------------------------------------------------------------------
-- The markers, on rung two's tables.
--
-- Every one is nullable or defaulted. That is a rollout requirement rather than
-- a preference: the previous fleet version is still inserting pages and facts
-- with rung two's column list while this rung is live.
-- ---------------------------------------------------------------------------

ALTER TABLE page ADD COLUMN derivation text NOT NULL DEFAULT 'ingested';
ALTER TABLE page ADD COLUMN compiled_truth boolean NOT NULL DEFAULT false;
ALTER TABLE page ADD COLUMN salience real;
ALTER TABLE page ADD COLUMN salience_source text;
ALTER TABLE page ADD COLUMN salience_at timestamptz;
ALTER TABLE page ADD COLUMN stale_at timestamptz;

ALTER TABLE page ADD CONSTRAINT page_derivation_is_known CHECK (
  derivation IN ('ingested', 'rule_derived', 'model_derived')
);
ALTER TABLE page ADD CONSTRAINT page_salience_is_bounded CHECK (
  salience IS NULL OR (salience >= 0 AND salience <= 1)
);
ALTER TABLE page ADD CONSTRAINT page_salience_says_where_it_came_from CHECK (
  salience IS NULL OR salience_source IN ('deterministic', 'model_refined')
);
-- Compiled truth is a decision about a derived surface. An ingested page cannot
-- be one: the boost exists for the summary consolidation compiles, and a page
-- that arrived through a credential is evidence rather than a compilation.
ALTER TABLE page ADD CONSTRAINT page_compiled_truth_is_derived CHECK (
  NOT compiled_truth OR derivation = 'model_derived'
);

-- **Why an edge needs a derivation too, and why its default is different.**
-- The write path's reconciler is page-scoped: it only ever considers edges the
-- page it is rewriting used to imply. Consolidation reconciles the *whole*
-- graph, which is stronger and, without this column, indiscriminate — it would
-- delete every edge the deterministic projection cannot re-derive, including
-- the connector-derived edges U9 is about to add and anything a model phase
-- proposes. So an edge records how it was made, the default is `rule_derived`
-- because every edge that exists today came from `links.ts`'s projection, and
-- whole-graph reconciliation removes only what it could itself have produced.
ALTER TABLE entity_edge ADD COLUMN derivation text NOT NULL DEFAULT 'rule_derived';
ALTER TABLE entity_edge ADD CONSTRAINT entity_edge_derivation_is_known CHECK (
  derivation IN ('ingested', 'rule_derived', 'model_derived')
);

ALTER TABLE fact ADD COLUMN derivation text NOT NULL DEFAULT 'ingested';
ALTER TABLE fact ADD COLUMN trust_level text;
ALTER TABLE fact ADD COLUMN run_id bigint;

ALTER TABLE fact ADD CONSTRAINT fact_derivation_is_known CHECK (
  derivation IN ('ingested', 'rule_derived', 'model_derived')
);
ALTER TABLE fact ADD CONSTRAINT fact_trust_is_known CHECK (
  trust_level IS NULL
  OR trust_level IN ('user_stated', 'rule_extracted', 'model_extracted', 'model_inferred')
);
-- R12, as a constraint rather than as a convention: a model wrote it, so it says
-- how much it should be trusted. A model-derived row with no level is exactly
-- the row a later phase treats as evidence without knowing what it is.
ALTER TABLE fact ADD CONSTRAINT fact_model_rows_carry_a_trust_level CHECK (
  derivation <> 'model_derived' OR trust_level IS NOT NULL
);
ALTER TABLE fact ADD CONSTRAINT fact_run_fkey FOREIGN KEY (run_id)
  REFERENCES consolidation_run (run_id) ON DELETE SET NULL;

CREATE INDEX page_ingested_live ON page (created_at DESC)
  WHERE derivation = 'ingested' AND deleted_at IS NULL AND quarantined_at IS NULL AND stale_at IS NULL;
CREATE INDEX page_by_external_ref ON page (external_ref, created_at DESC) WHERE external_ref IS NOT NULL;
CREATE INDEX fact_by_derivation ON fact (derivation) WHERE deleted_at IS NULL AND superseded_by IS NULL;
