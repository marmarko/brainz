/**
 * The per-tenant change channel (P13) — *what shipped, what it did to your
 * memory, and what you can do about it*.
 *
 * P13's framing is the reason this exists and is worth restating rather than
 * summarising: a gbrain user **runs** their upgrade — banner, migration skill,
 * audit trail. A hosted brainz user's memory changes behaviour overnight with no
 * notice and no consent, and a model phase may have rewritten something they
 * wrote. Managing the infrastructure is the deal being offered; changing what
 * somebody remembers without telling them is not part of it.
 *
 * **Three parts, three homes, and only one of them ever names your content.**
 * The record is fleet-wide and committed. The staging decision is a slug and a
 * three-value stage on the control-plane row. The sentence about *your* memory is
 * measured here, against your own database, and written nowhere — not to the
 * control plane, whose columns could not hold it, and not back into the record,
 * whose bytes the tests assert are unchanged after rendering for two tenants.
 *
 * **Fail-closed staging.** A tenant with no flag row sees nothing. An
 * absent-means-on channel would broadcast every record the moment it was
 * committed, which is the overnight change this card exists to prevent, delivered
 * by the mechanism meant to prevent it.
 *
 * **What is not wired yet, said plainly.** `brain` is the model-reachable trust
 * artifact and this block belongs on it, under `content.changes`. That one-line
 * wiring lives in `src/mcp/tools/meta.ts`, which a concurrent unit owns, so this
 * ships as the payload builder with its shape pinned by test and the surface left
 * to the unit that owns the file. `imp.upgrade-notice` stays `not-yet` in the
 * concepts ledger until a user can reach it: its capability statement says
 * *user-visible*, and a function nobody calls is not that.
 */

import type { SQL } from 'bun';

import { stageOf, type FlagStage } from '../control/flags.ts';
import type { ChangeRecord } from './changes.ts';

/** How many of a tenant's own titles a change record may name. */
export const EXAMPLE_LIMIT = 3;

export interface Effect {
  readonly count: number;
  /** Titles from the tenant's own brain. Rendered, never stored. */
  readonly examples: readonly string[];
}

export interface RenderedChange {
  readonly id: string;
  readonly released_on: string;
  readonly stage: FlagStage;
  readonly headline: string;
  readonly what_changed: string;
  readonly what_it_did_to_your_memory: string;
  readonly what_you_can_do: string;
  readonly affected?: Effect;
}

export interface ChangeChannelBlock {
  readonly version: 1;
  readonly changes: readonly RenderedChange[];
}

/**
 * Measure a record's effect against one tenant's database.
 *
 * Bounded by construction: a count and at most {@link EXAMPLE_LIMIT} titles,
 * soft-deleted and quarantined pages excluded, because a change notice that
 * counted rows a user can no longer retrieve would be describing a brain they do
 * not have.
 */
export async function measureEffects(sql: SQL, record: ChangeRecord): Promise<Effect | undefined> {
  const effect = record.effect;
  if (effect === undefined) return undefined;

  switch (effect.probe) {
    case 'pages_created_since': {
      const since = effect.since ?? `${record.released_on}T00:00:00Z`;
      const rows = await sql<{ title: string | null }[]>`
        SELECT title FROM page
        WHERE created_at >= ${since}::timestamptz
          AND deleted_at IS NULL
          AND quarantined_at IS NULL
        ORDER BY created_at DESC, page_id DESC`;
      return {
        count: rows.length,
        examples: rows
          .slice(0, EXAMPLE_LIMIT)
          .map((row) => row.title)
          .filter((title): title is string => title !== null),
      };
    }
  }
}

/**
 * Substitute a tenant's numbers into the record's template.
 *
 * Returns a new string. The record object is shared across every tenant served by
 * one process, so a renderer that substituted in place would put the first
 * tenant's counts into the second tenant's response — and in a single-tenant test
 * that leak is invisible.
 */
export function fillTemplate(template: string, effect: Effect | undefined): string {
  if (effect === undefined) return template.replace(/\{count\}/g, '0').replace(/\{examples\}/g, '');
  const examples = effect.examples.length === 0 ? '' : effect.examples.join(', ');
  return template.replace(/\{count\}/g, String(effect.count)).replace(/\{examples\}/g, examples);
}

export interface ChannelInput {
  readonly records: readonly ChangeRecord[];
  readonly stages: ReadonlyMap<string, FlagStage>;
  /** The tenant's own database. Read only, and only for the effect probes. */
  readonly sql: SQL;
}

/**
 * The block `brain` embeds under `content.changes`.
 *
 * Only records staged `canary` or `on` for this tenant appear, and the stage is
 * carried rather than flattened to a boolean: a canary that cannot tell a user
 * they are early is a rollout mechanism wearing a consent surface's clothes.
 */
export async function changeChannel(input: ChannelInput): Promise<ChangeChannelBlock> {
  const visible = input.records.filter((record) => stageOf(input.stages, record.flag) !== 'off');

  const changes = await Promise.all(
    visible.map(async (record): Promise<RenderedChange> => {
      const effect = await measureEffects(input.sql, record);
      return {
        id: record.id,
        released_on: record.released_on,
        stage: stageOf(input.stages, record.flag),
        headline: record.headline,
        what_changed: record.what_changed,
        what_it_did_to_your_memory: fillTemplate(record.what_it_did_to_your_memory, effect),
        what_you_can_do: record.what_you_can_do,
        ...(effect === undefined ? {} : { affected: effect }),
      };
    }),
  );

  return { version: 1, changes };
}
