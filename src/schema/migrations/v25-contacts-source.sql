-- ---------------------------------------------------------------------------
-- brainz tenant schema — rung 25, a fourth connector and the content type it
-- brings with it
--
-- Three CHECKs in this database enumerate a closed vocabulary that a fourth
-- connector widens, and every one of them is a list written before the fourth
-- existed. None of them is reachable by editing the rung that created it: rungs
-- are applied once, so a live tenant carries the constraint as it was first
-- spelled and only a new rung can change it.
--
-- **`source_pause` is the one that fails loudly, and it is not the dangerous
-- one for that reason.** `pauseSource` casts nothing and binds the source as
-- text, so a paused `contacts` would raise the CHECK at the moment somebody
-- pressed the button — visible, immediate, and repairable. It is here because
-- the pause control is offered for every source the connectors page renders,
-- and a control that 500s is worse than one that is absent.
--
-- **`page_source_type_is_known` and its `page_version` twin are the widening
-- this rung exists to think about.** The contacts adapter deliberately writes
-- **no pages** — an address book of 2,525 entries whose overlap with this
-- brain's corpus is thirteen addresses is a dictionary, not a document set, and
-- 2,525 pages would bury a 10,036-page corpus under a decade of stale cruft. So
-- on the day this rung lands, nothing writes `source_type = 'contact'` at all.
--
-- It is widened anyway, and the argument is the one this schema uses everywhere
-- else: a vocabulary that the code can name and the database cannot hold is a
-- runtime failure waiting for the first caller who does the obvious thing.
-- `SourceType` gains `'contact'` in the same commit because
-- `SOURCE_TYPE_FOR[source]` is a total map over `ConnectorSource` and the
-- fourth entry has to be *something*; making it `'note'` would have avoided
-- this file by writing a lie into every ingest-log row the lane produces.
-- Cheaper is not the same as true.
--
-- **Drop-and-re-add under the same name, and a strict superset**, which is what
-- the expand-only scanner admits (rungs 15, 16, 17, 19 and 21 are the
-- precedents, pinned in `test/control/schema.test.ts`). Nothing is narrowed
-- here: every value that satisfied these constraints before satisfies them
-- after, so no existing row can be invalidated and the re-add needs no scan
-- anybody has to wait for.
-- ---------------------------------------------------------------------------

ALTER TABLE source_pause
  DROP CONSTRAINT source_pause_source_is_a_connector;

ALTER TABLE source_pause
  ADD CONSTRAINT source_pause_source_is_a_connector CHECK (
    source IN ('gmail', 'calendar', 'drive', 'contacts')
  );

ALTER TABLE page
  DROP CONSTRAINT page_source_type_is_known;

ALTER TABLE page
  ADD CONSTRAINT page_source_type_is_known CHECK (
    source_type IN (
      'email', 'chat', 'document', 'web', 'note', 'calendar', 'transcript',
      'file', 'contact'
    )
  );

ALTER TABLE page_version
  DROP CONSTRAINT page_version_source_type_is_known;

ALTER TABLE page_version
  ADD CONSTRAINT page_version_source_type_is_known CHECK (
    source_type IN (
      'email', 'chat', 'document', 'web', 'note', 'calendar', 'transcript',
      'file', 'contact'
    )
  );
