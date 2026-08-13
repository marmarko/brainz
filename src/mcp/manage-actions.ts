/**
 * The `manage` action table, and what each action's `value` may be.
 *
 * **One table, and everything else is generated from it.** The panel's HTML,
 * the text twin, the gate's confirmation prompt and the settings port's
 * validation all read this file. A panel with a hand-written form and a
 * hand-written list of equivalent tool calls is two lists that agree only on
 * the day they are written — and U14's verification line is precisely that
 * every panel action has a working text twin, so parity has to be structural
 * rather than remembered.
 *
 * **Validation runs before the confirmation, not after it — and that ordering
 * is a security property rather than an ergonomic one.** The confirmation
 * prompt is the user's only defence on the fallback branch, and the model picks
 * the `value` that goes into it. A model acting on instructions laundered out
 * of ingested mail could otherwise put arbitrary prose in front of the user
 * inside a prompt the *server* appears to be asking — "Stop polling <a
 * paragraph of the attacker's choosing>?". Normalising to a closed set first
 * means the only strings that ever reach that prompt are connector names,
 * policy names and digits.
 *
 * **Two callers, one validator.** The gate decides what to *ask about* and the
 * settings port decides what to *write*; the day those two disagree is the day
 * a confirmation approves something else. The database's CHECK constraints
 * (rung 7) are still the backstop, because a validator alone is one forgotten
 * branch from being false.
 */

import { CONNECTOR_SOURCES } from '../ingest/cursor.ts';

export const MANAGE_ACTION_NAMES = [
  'set_context_policy',
  'set_spend_cap',
  'pause_source',
  'resume_source',
] as const;

export type ManageAction = (typeof MANAGE_ACTION_NAMES)[number];

/** The closed set `set_context_policy` writes. Mirrors rung 7's CHECK. */
export const CONTEXT_POLICIES = ['unrestricted', 'personal_only', 'work_only'] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

/**
 * There is deliberately **no** invented ceiling on the spend cap.
 *
 * An earlier draft carried a round number here. It was a magic number pretending
 * to be a control: a cap is a *ceiling on spending*, so an absurdly large one
 * means "effectively uncapped", which is already expressible as `none` — the
 * dangerous direction is a cap that is too small, and no upper bound helps with
 * that. What the parser does enforce is `Number.isSafeInteger`, which is a real
 * bound (the column is `bigint`, and a value past 2^53 stops round-tripping
 * through JavaScript long before the database would complain).
 *
 * What this constant *is*: the word that clears a cap, since the column
 * expresses "no cap" as NULL and a tool argument cannot be one.
 */
export const CLEAR_SPEND_CAP = 'none';

/**
 * Where a web-app-only action goes instead.
 *
 * Overridable on `DispatchDeps` for the deployed origin, and a constant at the
 * call sites, because a deep link that varies per response is a deep link a
 * caller cannot recognise.
 */
export const DEFAULT_WEB_APP_BASE_URL = 'https://app.brainz.test';

export interface ManageActionDef {
  readonly action: ManageAction;
  readonly label: string;
  readonly valueKind: 'micro_usd' | 'connector_source' | 'context_policy';
  /**
   * True when this action is refused on the fallback branch and its twin is the
   * web-app deep link instead.
   *
   * Exactly one action carries it, and the roadmap is why: advertising `manage`
   * removes the nonce gate that was its access-control premise, so the fallback
   * owes a replacement control *and* a narrowing. Confirmation is the
   * replacement; moving the context policy out of reach is the narrowing. A
   * yes-click on a prompt the connected agent framed is not the user choosing
   * how their brain reads.
   */
  readonly panelOnly: boolean;
  readonly summary: string;
}

export const MANAGE_ACTIONS: readonly ManageActionDef[] = [
  {
    action: 'set_context_policy',
    label: 'Reading posture',
    valueKind: 'context_policy',
    panelOnly: true,
    summary: 'Which of your contexts ordinary reads draw on by default.',
  },
  {
    action: 'set_spend_cap',
    label: 'Spend cap',
    valueKind: 'micro_usd',
    panelOnly: false,
    summary: 'The ceiling on model spend for this brain. Raise or lower it at any time.',
  },
  {
    action: 'pause_source',
    label: 'Pause a source',
    valueKind: 'connector_source',
    panelOnly: false,
    summary: 'Stop polling one connector. Nothing already stored is removed.',
  },
  {
    action: 'resume_source',
    label: 'Resume a source',
    valueKind: 'connector_source',
    panelOnly: false,
    summary: 'Start polling it again from where it left off.',
  },
];

const BY_ACTION = new Map<string, ManageActionDef>(
  MANAGE_ACTIONS.map((action) => [action.action, action]),
);

export function manageActionByName(name: string): ManageActionDef | undefined {
  return BY_ACTION.get(name);
}

/** The web app's page for one action. The twin of an action with no in-chat twin. */
export function deepLinkFor(action: string, baseUrl: string = DEFAULT_WEB_APP_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}/manage/${encodeURIComponent(action)}`;
}

export type ManageValueVerdict =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly message: string };

/** What each action accepts, in the words the panel and the twin both publish. */
export function acceptedValuesFor(action: string): readonly string[] {
  switch (manageActionByName(action)?.valueKind) {
    case 'context_policy':
      return CONTEXT_POLICIES;
    case 'connector_source':
      return CONNECTOR_SOURCES;
    case 'micro_usd':
      return [`a whole number of micro-USD, or \`${CLEAR_SPEND_CAP}\` to clear the cap`];
    default:
      return [];
  }
}

/**
 * Normalise and validate one action's value.
 *
 * The spend cap is parsed with a strict digit test rather than `Number()`,
 * because `Number('')` is `0` and `Number(' ')` is `0`: a lenient parse turns a
 * caller who sent nothing into a caller who set the cap to zero, which stops
 * the brain rather than loosening it. That is the wrong direction for a mistake.
 */
export function normalizeManageValue(action: string, value: string | null): ManageValueVerdict {
  const def = manageActionByName(action);
  if (def === undefined) {
    return { ok: false, message: `\`${action}\` is not an action this brain has.` };
  }
  if (value === null || value.trim().length === 0) {
    return { ok: false, message: `\`${def.action}\` needs a \`value\`.` };
  }

  const trimmed = value.trim().toLowerCase();

  switch (def.valueKind) {
    case 'context_policy':
      return (CONTEXT_POLICIES as readonly string[]).includes(trimmed)
        ? { ok: true, normalized: trimmed }
        : { ok: false, message: `\`${def.action}\` must be one of ${CONTEXT_POLICIES.join(', ')}.` };

    case 'connector_source':
      return (CONNECTOR_SOURCES as readonly string[]).includes(trimmed)
        ? { ok: true, normalized: trimmed }
        : {
            ok: false,
            message: `${JSON.stringify(value)} is not a connector this brain polls. It polls ${CONNECTOR_SOURCES.join(', ')}.`,
          };

    case 'micro_usd': {
      if (trimmed === CLEAR_SPEND_CAP) return { ok: true, normalized: CLEAR_SPEND_CAP };
      if (!/^\d+$/.test(trimmed)) {
        return {
          ok: false,
          message: `\`set_spend_cap\` takes a whole number of micro-USD or \`${CLEAR_SPEND_CAP}\`, not ${JSON.stringify(value)}.`,
        };
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isSafeInteger(parsed)) {
        return { ok: false, message: '`set_spend_cap` takes a number this brain can hold exactly.' };
      }
      return { ok: true, normalized: String(parsed) };
    }
  }
}
