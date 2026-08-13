/**
 * Where a `manage` action actually lands.
 *
 * **A port, because the stores are in two different databases.** The spend cap
 * is a control-plane column (`control.tenant.spend_cap_micro_usd`, which
 * `ingest/first-import.ts` already reads to gate a first import); the context
 * policy and the pause set are tenant-side (rung 7). A handler cannot reach
 * either directly — `test/mcp/guards.test.ts` scans the handler directory and
 * fails on a handler that writes SQL or resolves a credential, which is the
 * structural version of "the boundary sits below the handlers". So dispatch
 * builds a bound port and the handler calls methods on it.
 *
 * **Validation lives here, not at the handler and not only at the database.**
 * The CHECK constraints in rung 7 are the backstop and they are load-bearing;
 * they are also a 23514 the caller cannot act on. A typed refusal naming the
 * closed set is what a user gets to see. Both, because a validator alone is one
 * forgotten branch from being false and a constraint alone is unreadable.
 *
 * **An absent backend refuses rather than pretending.** If the fleet has not
 * wired a control-plane connection, `manage` answers `unavailable`. The
 * alternative — a no-op port returning success — is the exact shape that makes
 * `applied: true` a lie, and it would be invisible in every test that did not
 * specifically re-read the store.
 */

import type { SQL } from 'bun';

import type { ConnectorSource } from '../ingest/cursor.ts';
import {
  pauseSource as writePause,
  readPausedSources,
  resumeSource as writeResume,
  type PauseAuthority,
} from '../ingest/pause.ts';
import { CLEAR_SPEND_CAP, normalizeManageValue } from './manage-actions.ts';
import type { ContextPolicy } from './manage-actions.ts';

export interface SettingsSnapshot {
  readonly spendCapMicroUsd: number | null;
  readonly contextPolicy: string | null;
  readonly pausedSources: readonly ConnectorSource[];
}

export type SettingsRefusal =
  | { readonly ok: false; readonly code: 'invalid_params'; readonly message: string }
  | { readonly ok: false; readonly code: 'unavailable'; readonly message: string };

export type SettingsOutcome = { readonly ok: true; readonly effect: string } | SettingsRefusal;

export interface SettingsPort {
  read(): Promise<SettingsSnapshot>;
  setSpendCap(value: string): Promise<SettingsOutcome>;
  setContextPolicy(value: string): Promise<SettingsOutcome>;
  pauseSource(value: string, by: PauseAuthority): Promise<SettingsOutcome>;
  resumeSource(value: string): Promise<SettingsOutcome>;
}

export interface SettingsBackend {
  forTenant(input: { readonly tenantId: string; readonly sql: SQL }): SettingsPort;
}

/**
 * Normalise, or return the refusal.
 *
 * The same validator the gate ran. Running it twice is deliberate: the gate
 * decides what to *ask about* and this decides what to *write*, and the day
 * those two disagree is the day a confirmation approves something else.
 */
function normalized(action: string, value: string): { readonly value: string } | SettingsRefusal {
  const verdict = normalizeManageValue(action, value);
  return verdict.ok
    ? { value: verdict.normalized }
    : { ok: false, code: 'invalid_params', message: verdict.message };
}

function isRefusal(candidate: { readonly value: string } | SettingsRefusal): candidate is SettingsRefusal {
  return 'ok' in candidate;
}

export function createSettingsBackend(control: SQL): SettingsBackend {
  return {
    forTenant({ tenantId, sql }) {
      return {
        async read(): Promise<SettingsSnapshot> {
          const capRows = (await control`
            SELECT spend_cap_micro_usd::bigint AS cap
              FROM control.tenant
             WHERE tenant_id = ${tenantId}
          `) as Array<{ cap: string | number | null }>;
          const policyRows = (await sql`
            SELECT context_policy FROM tenant_setting
          `) as Array<{ context_policy: string | null }>;

          const cap = capRows[0]?.cap;
          return {
            spendCapMicroUsd: cap === null || cap === undefined ? null : Number(cap),
            contextPolicy: policyRows[0]?.context_policy ?? null,
            pausedSources: await readPausedSources(sql),
          };
        },

        async setSpendCap(value): Promise<SettingsOutcome> {
          const checked = normalized('set_spend_cap', value);
          if (isRefusal(checked)) return checked;
          const parsed = checked.value === CLEAR_SPEND_CAP ? null : Number.parseInt(checked.value, 10);

          const rows = (await control`
            UPDATE control.tenant
               SET spend_cap_micro_usd = ${parsed},
                   updated_at = now()
             WHERE tenant_id = ${tenantId}
            RETURNING tenant_id
          `) as Array<{ tenant_id: string }>;

          // No row is a refusal rather than a silent success. The control plane
          // not knowing this tenant is the state in which every downstream
          // reader of the cap is also wrong, and reporting `applied` would hide
          // it behind a green tool call.
          if (rows.length === 0) {
            return { ok: false, code: 'unavailable', message: 'This brain could not be reached.' };
          }
          return {
            ok: true,
            effect:
              parsed === null
                ? 'The cap is cleared; the platform default applies.'
                : `The rolling spend cap is now ${parsed} micro-USD, and the first-import gate reads it on its next run.`,
          };
        },

        async setContextPolicy(value): Promise<SettingsOutcome> {
          const checked = normalized('set_context_policy', value);
          if (isRefusal(checked)) return checked;
          await sql`UPDATE tenant_setting SET context_policy = ${checked.value as ContextPolicy}`;
          return {
            ok: true,
            // Said plainly rather than implied. Rung 7 stores this and the read
            // path does not consult it yet; a response that claimed otherwise
            // would be a user believing their reads had narrowed when they had
            // not.
            effect:
              'Recorded. Reads are not narrowed by this yet — the reading posture takes effect with the web app, and access fencing still evaluates origin only.',
          };
        },

        async pauseSource(value, by): Promise<SettingsOutcome> {
          const checked = normalized('pause_source', value);
          if (isRefusal(checked)) return checked;
          const source = checked.value as ConnectorSource;
          await writePause(sql, source, by);
          return { ok: true, effect: `Polling for ${source} is stopped. Nothing stored is removed.` };
        },

        async resumeSource(value): Promise<SettingsOutcome> {
          const checked = normalized('resume_source', value);
          if (isRefusal(checked)) return checked;
          const source = checked.value as ConnectorSource;
          await writeResume(sql, source);
          return { ok: true, effect: `Polling for ${source} resumes on its ordinary cadence.` };
        },
      };
    },
  };
}
