/**
 * Per-tenant feature flags — the staged-rollout half of fleet migration (U19).
 *
 * `gap.per-tenant-feature-flags` has sat in the concepts ledger since U1 saying
 * what their absence costs: *"a new chunker or extractor prompt can still only
 * ship all-at-once across every isolated project."* With tens of thousands of
 * separate databases there is no other way to stage anything — there is no shared
 * schema to migrate half of, and no fleet-wide switch that reaches one tenant.
 *
 * **Fail-closed, and the direction matters.** A tenant with no row for a flag is
 * `off`. The alternative — absent means on — would ship every record the moment
 * it was committed, to everybody, which is precisely the overnight change with no
 * notice that P13 exists to stop.
 *
 * **The registry is committed, not free-form.** A flag name is a slug in the
 * database (`control.feature_flag`'s alphabet cannot hold a sentence), and it must
 * additionally be one of the names below. Two reasons: a typo would otherwise
 * stage a change for nobody and look identical to a change staged for nobody on
 * purpose, and a flag that exists only in a database row is a flag nobody can
 * find the meaning of by reading the repo.
 */

import type { SQL } from 'bun';

/** The three stages a change moves through, per tenant. */
export const FLAG_STAGES = ['off', 'canary', 'on'] as const;
export type FlagStage = (typeof FLAG_STAGES)[number];

/**
 * Every flag the fleet knows about.
 *
 * A change record under `upstream/changes/` names one of these, and
 * `src/upstream/changes.ts` refuses a record that names anything else.
 */
export const FLAG_REGISTRY = ['media_ocr', 'briefing_today'] as const;
export type FeatureFlag = (typeof FLAG_REGISTRY)[number];

export function isFeatureFlag(value: unknown): value is FeatureFlag {
  return typeof value === 'string' && (FLAG_REGISTRY as readonly string[]).includes(value);
}

export function isFlagStage(value: unknown): value is FlagStage {
  return typeof value === 'string' && (FLAG_STAGES as readonly string[]).includes(value);
}

/**
 * Stages this tenant has a row for. A flag missing from the map is `off` —
 * {@link stageOf} is the reader that says so, so no caller has to remember.
 */
export async function readFlagStages(sql: SQL, tenantId: string): Promise<Map<string, FlagStage>> {
  const rows = await sql<{ flag: string; stage: string }[]>`
    SELECT flag, stage FROM control.tenant_flag WHERE tenant_id = ${tenantId}`;

  const stages = new Map<string, FlagStage>();
  for (const row of rows) {
    if (isFlagStage(row.stage)) stages.set(row.flag, row.stage);
  }
  return stages;
}

/** `off` for anything unset, which is what makes the channel fail-closed. */
export function stageOf(stages: ReadonlyMap<string, FlagStage>, flag: string): FlagStage {
  return stages.get(flag) ?? 'off';
}

export async function setFlagStage(
  sql: SQL,
  tenantId: string,
  flag: string,
  stage: FlagStage,
): Promise<void> {
  if (!isFeatureFlag(flag)) {
    throw new Error(
      `${JSON.stringify(flag)} is not a declared flag. Add it to FLAG_REGISTRY in src/control/flags.ts ` +
        'first — a flag that exists only as a database row is a flag nobody can look up.',
    );
  }
  await sql`
    INSERT INTO control.tenant_flag (tenant_id, flag, stage, set_at)
    VALUES (${tenantId}, ${flag}, ${stage}::control.flag_stage, now())
    ON CONFLICT (tenant_id, flag) DO UPDATE SET stage = EXCLUDED.stage, set_at = now()`;
}

/** Who is in a flag's cohort — the query a staged rollout is steered by. */
export async function tenantsAtStage(sql: SQL, flag: string, stage: FlagStage): Promise<string[]> {
  const rows = await sql<{ tenant_id: string }[]>`
    SELECT tenant_id FROM control.tenant_flag
    WHERE flag = ${flag} AND stage = ${stage}::control.flag_stage
    ORDER BY tenant_id`;
  return rows.map((row) => row.tenant_id);
}
