-- ===========================================================================
-- brainz tenant schema — rung 8, the fence stops being a function of its caller
--
-- H6 in `docs/porting-hazards.md`. Rungs 2 and 3 declared eight trigger
-- functions and pinned `search_path` on none of them, and seven of the eight are
-- R15's origin fence. A function that resolves `page` unqualified resolves it
-- through whatever path the calling session set, so the check belongs to the
-- caller rather than to the database.
--
-- **It had a working bypass, and it was not privilege escalation.** None of the
-- eight is SECURITY DEFINER (`prosecdef = false` on all eight), so there is no
-- definer's-rights body to aim a hostile path at. What there was:
--
--   CREATE SCHEMA shadow; CREATE TABLE shadow.page (…); SET search_path = shadow, public;
--
-- after which `assert_fact_page_origin` inspected an empty table, found no
-- uncovered origin, and admitted a `fact` claiming `{personal}` extracted from a
-- `work` page. KTD5 fences reads on origin alone, so that row then reads out to
-- a personal-scoped grant. `refuse_origin_change` names no table and was
-- bypassed too, by listing `pg_catalog` *late* and shadowing `to_jsonb`.
-- `test/schema/search-path.test.ts` replays all three.
--
-- **Why this rung twins rather than rewrites.** `ALTER FUNCTION … SET
-- search_path` is the direct fix and it is not an expand-only statement: the
-- runner's scanner admits `CREATE FUNCTION` and not `ALTER FUNCTION`, and
-- `CREATE OR REPLACE FUNCTION` does not match it either. Rewriting a function a
-- previously-released fleet instance is still calling is exactly what the
-- expand-only rule forbids. So each function gets a pinned twin and each trigger
-- that called one gets a twin trigger calling the twin. Both arms fire. The
-- unpinned arm can be fooled and the pinned arm cannot, and a check that raises
-- is a check that raises — so the fence holds at the strength of its strongest
-- arm. The contract rung that drops the unpinned originals comes later, once
-- every instance predating this one is gone.
--
-- **The pinned path is `pg_catalog, public, pg_temp`, and every position is
-- load-bearing:**
--
--   * `pg_catalog` FIRST AND NAMED. Unlisted, it is searched first and looks
--     safe; listed late, it is demoted, and a shadow `to_jsonb` returning a
--     constant makes OLD and NEW compare equal. Naming it first removes that.
--   * `public`, because the fence's own tables are there.
--   * `pg_temp` LAST AND NAMED. This is the position most easily left out. When
--     `pg_temp` is not listed, Postgres searches it FIRST for relation names —
--     ahead of `pg_catalog` — so `pg_catalog, public` would leave every union
--     check defeatable by `CREATE TEMP TABLE page`, which needs no CREATE
--     privilege on any schema at all. That is a cheaper attack than the one
--     being fixed, and a pin that opens it is worse than none.
--
-- **Backfill: none, and deliberately none.** This rung adds functions and
-- triggers. It writes no column, so there is no value here that a later reader
-- could mistake for an observation. It also does not re-check rows admitted
-- before it — a tenant exploited before rung 8 keeps the forged row, and
-- stamping a "verified clean" marker on the strength of the fleet being pre-beta
-- would be writing exactly the unobserved assertion this repo refuses. Historical
-- re-verification, if it is ever wanted, is a sweep with a receipt.
--
-- Guard: `src/schema/search-path.ts`, in the two-halves shape `origin-fence.ts`
-- uses — a ladder scan that stops a ninth function landing unpinned, and a
-- catalog scan that sees a twin dropped, disabled, or never written.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The eight pinned functions. Bodies are the committed ones verbatim; the only
-- difference from rungs 2 and 3 is the name and the `SET search_path` clause, so
-- a diff between a function and its twin shows the pin and nothing else.
-- ---------------------------------------------------------------------------

CREATE FUNCTION assert_commitment_origin_union_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_commitment_origin_union_pinned$
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
$assert_commitment_origin_union_pinned$;

CREATE FUNCTION assert_edge_origin_union_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_edge_origin_union_pinned$
DECLARE uncovered text;
BEGIN
  SELECT endpoint.origin INTO uncovered
  FROM (
    SELECT unnest(e.origin_contexts) AS origin
    FROM entity e
    WHERE e.entity_id IN (NEW.subject_entity_id, NEW.object_entity_id)
  ) AS endpoint
  WHERE NOT (endpoint.origin = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'edge % does not carry the origin % of one of the entities it connects (R15)', NEW.edge_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the edge with the full union';
  END IF;

  RETURN NULL;
END;
$assert_edge_origin_union_pinned$;

CREATE FUNCTION assert_entity_card_origin_union_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_entity_card_origin_union_pinned$
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
$assert_entity_card_origin_union_pinned$;

CREATE FUNCTION assert_fact_page_origin_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_fact_page_origin_pinned$
DECLARE uncovered text;
BEGIN
  SELECT p.origin_context INTO uncovered
  FROM page p
  WHERE p.page_id = NEW.page_id
    AND NOT (p.origin_context = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'fact % does not carry the origin % of the page it was extracted from (R15)', NEW.fact_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the fact with the full union';
  END IF;

  RETURN NULL;
END;
$assert_fact_page_origin_pinned$;

CREATE FUNCTION assert_inverse_is_involutive_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_inverse_is_involutive_pinned$
DECLARE back text;
BEGIN
  SELECT t.inverse_type INTO back FROM edge_type t WHERE t.edge_type = NEW.inverse_type;

  IF back IS DISTINCT FROM NEW.edge_type THEN
    RAISE EXCEPTION
      'edge type % declares % as its inverse, but % declares % — an inverse that is not an involution silently changes meaning on the second hop',
      NEW.edge_type, NEW.inverse_type, NEW.inverse_type, coalesce(back, '<undeclared>')
      USING ERRCODE = 'BZ003';
  END IF;

  RETURN NULL;
END;
$assert_inverse_is_involutive_pinned$;

CREATE FUNCTION assert_origin_union_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_origin_union_pinned$
DECLARE uncovered text;
BEGIN
  SELECT c.origin_context INTO uncovered
  FROM fact_source fs
  JOIN chunk c ON c.chunk_id = fs.chunk_id
  JOIN fact f ON f.fact_id = fs.fact_id
  WHERE fs.fact_id = NEW.fact_id
    AND NOT (c.origin_context = ANY (f.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'fact % does not carry the origin % of one of its source chunks (R15)', NEW.fact_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the fact with the full union';
  END IF;

  RETURN NULL;
END;
$assert_origin_union_pinned$;

CREATE FUNCTION assert_report_origin_union_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $assert_report_origin_union_pinned$
DECLARE uncovered text;
BEGIN
  SELECT side.origin INTO uncovered
  FROM (
    SELECT unnest(f.origin_contexts) AS origin
    FROM fact f
    WHERE f.fact_id IN (NEW.left_fact_id, NEW.right_fact_id)
  ) AS side
  WHERE NOT (side.origin = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'contradiction report % does not carry the origin % of one of the facts it quotes (R15)', NEW.report_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the report with the full union';
  END IF;

  RETURN NULL;
END;
$assert_report_origin_union_pinned$;

CREATE FUNCTION refuse_origin_change_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $refuse_origin_change_pinned$
BEGIN
  IF to_jsonb(NEW) -> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) -> TG_ARGV[0] THEN
    RAISE EXCEPTION
      'origin is immutable: %.% may not be changed by an UPDATE (R15)', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'BZ001',
            HINT = 'a row whose origin would change is a different row: write a new one and tombstone this one';
  END IF;
  RETURN NEW;
END;
$refuse_origin_change_pinned$;

-- ---------------------------------------------------------------------------
-- The twin triggers — one per trigger that calls an unpinned function, with the
-- same timing, the same events, the same column list, the same deferral and the
-- same arguments. `findUnpinnedFenceCoverage` matches a twin on that whole
-- shape rather than on its name, so a twin attached to the wrong event does not
-- satisfy the requirement by sharing a suffix.
-- ---------------------------------------------------------------------------

CREATE TRIGGER ingest_log_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_context ON ingest_log
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_context');

CREATE TRIGGER page_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_context ON page
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_context');

CREATE TRIGGER chunk_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_context ON chunk
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_context');

CREATE TRIGGER attachment_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_context ON attachment
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_context');

CREATE TRIGGER fact_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON fact
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

CREATE CONSTRAINT TRIGGER fact_page_origin_union_pinned
  AFTER INSERT OR UPDATE ON fact
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_fact_page_origin_pinned();

CREATE CONSTRAINT TRIGGER fact_source_origin_union_pinned
  AFTER INSERT OR UPDATE ON fact_source
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_origin_union_pinned();

CREATE TRIGGER entity_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON entity
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

CREATE CONSTRAINT TRIGGER edge_type_inverse_is_involutive_pinned
  AFTER INSERT OR UPDATE ON edge_type
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_inverse_is_involutive_pinned();

CREATE TRIGGER entity_edge_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON entity_edge
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

CREATE CONSTRAINT TRIGGER entity_edge_origin_union_pinned
  AFTER INSERT OR UPDATE ON entity_edge
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_edge_origin_union_pinned();

CREATE TRIGGER contradiction_report_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON contradiction_report
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

CREATE CONSTRAINT TRIGGER contradiction_report_origin_union_pinned
  AFTER INSERT OR UPDATE ON contradiction_report
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_report_origin_union_pinned();

CREATE TRIGGER entity_card_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON entity_card
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

CREATE CONSTRAINT TRIGGER entity_card_origin_union_pinned
  AFTER INSERT OR UPDATE ON entity_card
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entity_card_origin_union_pinned();

CREATE TRIGGER commitment_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON commitment
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

CREATE CONSTRAINT TRIGGER commitment_origin_union_pinned
  AFTER INSERT OR UPDATE ON commitment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_commitment_origin_union_pinned();

CREATE TRIGGER review_queue_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON review_queue
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');
