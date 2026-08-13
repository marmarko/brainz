/**
 * The fleet-wide half of the change channel: `upstream/changes/*.json`.
 *
 * A change record is authored, committed, and **identical for every tenant**. It
 * says what shipped, what it did to memory *as a template*, and what the user can
 * do about it. It never holds a tenant's numbers and never holds a tenant's words
 * — the sentence about your memory carries `{count}` and `{examples}` and is
 * filled in on the way out, per tenant, from that tenant's own database.
 *
 * That split is what lets P13's promise coexist with the control plane's
 * content-free rule. Three parts, three homes:
 *
 *   - **what shipped** — here, committed, fleet-wide;
 *   - **whether you see it** — `control.tenant_flag`, a slug and a stage;
 *   - **what it did to your memory** — nowhere. Measured at read time and
 *     discarded with the response.
 *
 * Validation is fail-closed and runs at load: a record naming a flag the registry
 * does not declare, or an effect probe nobody wrote, is an error rather than a
 * record that stages for nobody and looks exactly like one staged for nobody on
 * purpose.
 */

import { FLAG_REGISTRY, isFeatureFlag } from '../control/flags.ts';

export const CHANGES_DIR = 'upstream/changes';

/**
 * Effect probes a record may name. Each is a bounded read against the tenant's
 * own database, implemented in `change-channel.ts`.
 *
 * A closed set on purpose. The alternative — a record carrying SQL — would put a
 * query somebody wrote in a JSON file on the request path of every tenant.
 */
export const EFFECT_PROBES = ['pages_created_since'] as const;
export type EffectProbe = (typeof EFFECT_PROBES)[number];

export interface EffectSpec {
  readonly probe: EffectProbe;
  /** ISO timestamp; the probe's parameter. */
  readonly since?: string;
}

export interface ChangeRecord {
  readonly id: string;
  readonly released_on: string;
  readonly flag: string;
  readonly headline: string;
  readonly what_changed: string;
  /** Carries `{count}` / `{examples}` placeholders. Never substituted in place. */
  readonly what_it_did_to_your_memory: string;
  readonly what_you_can_do: string;
  /** Absent when nothing already in a brain changed. */
  readonly effect?: EffectSpec;
  /** Where it was loaded from. Set by the loader, not by the file. */
  readonly path: string;
}

function nonEmpty(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${where}: "${field}" must be a non-empty string`);
  }
  return value;
}

export function parseChangeRecord(raw: unknown, path: string): ChangeRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: a change record must be a JSON object`);
  }
  const row = raw as Record<string, unknown>;

  const flag = row['flag'];
  if (!isFeatureFlag(flag)) {
    throw new Error(
      `${path}: flag ${JSON.stringify(flag)} is not declared. FLAG_REGISTRY in src/control/flags.ts ` +
        `holds ${FLAG_REGISTRY.join(', ')}. A record staged by an undeclared flag reaches nobody and ` +
        'is indistinguishable from one deliberately staged off.',
    );
  }

  let effect: EffectSpec | undefined;
  const rawEffect = row['effect'];
  if (rawEffect !== undefined && rawEffect !== null) {
    if (typeof rawEffect !== 'object' || Array.isArray(rawEffect)) {
      throw new Error(`${path}: "effect" must be an object naming a probe`);
    }
    const spec = rawEffect as Record<string, unknown>;
    const probe = spec['probe'];
    if (typeof probe !== 'string' || !(EFFECT_PROBES as readonly string[]).includes(probe)) {
      throw new Error(
        `${path}: effect probe ${JSON.stringify(probe)} does not exist. The probes are a closed set ` +
          `(${EFFECT_PROBES.join(', ')}) so that a committed JSON file can never carry a query.`,
      );
    }
    const since = spec['since'];
    effect = {
      probe: probe as EffectProbe,
      ...(typeof since === 'string' ? { since } : {}),
    };
  }

  return {
    id: nonEmpty(row['id'], 'id', path),
    released_on: nonEmpty(row['released_on'], 'released_on', path),
    flag,
    headline: nonEmpty(row['headline'], 'headline', path),
    what_changed: nonEmpty(row['what_changed'], 'what_changed', path),
    what_it_did_to_your_memory: nonEmpty(row['what_it_did_to_your_memory'], 'what_it_did_to_your_memory', path),
    what_you_can_do: nonEmpty(row['what_you_can_do'], 'what_you_can_do', path),
    ...(effect === undefined ? {} : { effect }),
    path,
  };
}

/** Newest first, then by id — the order a change channel is read in. */
export async function loadChangeRecords(dir = CHANGES_DIR): Promise<ChangeRecord[]> {
  const names = [...new Bun.Glob('*.json').scanSync({ cwd: dir })].sort();
  const records = await Promise.all(
    names.map(async (name) => {
      const path = `${dir}/${name}`;
      return parseChangeRecord(JSON.parse(await Bun.file(path).text()), path);
    }),
  );

  return records.sort(
    (left, right) => right.released_on.localeCompare(left.released_on) || left.id.localeCompare(right.id),
  );
}
