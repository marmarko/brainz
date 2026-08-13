/**
 * `upstream/gbrain.pin` — parsing it, and refusing any checkout that is not it.
 *
 * U7 step 5 pins the gbrain build "so upstream master cannot redden brainz CI on
 * unrelated PRs. Advancing the pin is a deliberate U19 ledger action."
 *
 * **A tag is recorded but a sha is verified.** Tags are mutable refs: a
 * force-push changes what a `--branch v0.44.1.0` clone produces while the pin
 * file reads identically. That is the same silent-drift shape the model-id pin
 * guard closes on the model side, and it is closed the same way — by binding to
 * an identifier the upstream cannot move.
 *
 * Every failure here refuses to produce a verdict. A conformance run against an
 * unverified build is worse than no run: it looks like evidence.
 */

export interface GbrainPin {
  /** Clone source. `https://` for CI; `file://` for a local mirror. */
  readonly repo: string;
  /** The human-readable name of the build. Recorded, not trusted. */
  readonly tag: string;
  /** The verified identity of the build. */
  readonly commit: string;
  readonly pinned_on: string;
  /** Who advanced it and under what authority. An empty value is refused. */
  readonly advanced_by: string;
}

export const PIN_PATH = 'upstream/gbrain.pin';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Well-formed AND calendar-real, the rule `scripts/check-ledger.ts` already applies. */
function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parsePin(text: string): GbrainPin {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error(`${PIN_PATH} is not a JSON object`);

  const repo = raw['repo'];
  if (!nonEmpty(repo) || !/^(https:\/\/|file:\/\/)/.test(repo)) {
    throw new Error(`${PIN_PATH} repo must be an https:// or file:// URL; CI clones it with no credential`);
  }
  if (!nonEmpty(raw['tag'])) {
    throw new Error(`${PIN_PATH} tag is missing — the pin has to be readable by a person, not only by a machine`);
  }
  if (typeof raw['commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(raw['commit'])) {
    throw new Error(`${PIN_PATH} commit must be a full lower-case 40-character sha; a tag moves, a sha does not`);
  }
  if (!nonEmpty(raw['pinned_on']) || !isIsoDay(raw['pinned_on'])) {
    throw new Error(`${PIN_PATH} pinned_on must be a real ISO day (YYYY-MM-DD)`);
  }
  if (!nonEmpty(raw['advanced_by'])) {
    throw new Error(`${PIN_PATH} advanced_by is missing — advancing the pin is a deliberate act and it has an owner`);
  }

  return {
    repo,
    tag: raw['tag'],
    commit: raw['commit'],
    pinned_on: raw['pinned_on'],
    advanced_by: raw['advanced_by'],
  };
}

export type CheckoutViolationKind = 'pin_mismatch' | 'checkout_dirty' | 'checkout_unusable';

export interface CheckoutViolation {
  readonly kind: CheckoutViolationKind;
  readonly detail: string;
}

export interface CheckoutVerdict {
  readonly verified: boolean;
  readonly violations: readonly CheckoutViolation[];
  /** The sha actually found, when one was readable. */
  readonly head?: string;
}

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/** Injected so the rules are testable without a filesystem or a real clone. */
export type GitRunner = (args: readonly string[]) => GitResult;

export function verifyCheckout(options: {
  readonly dir: string;
  readonly pin: GbrainPin;
  readonly git: GitRunner;
}): CheckoutVerdict {
  const { dir, pin, git } = options;

  let head: GitResult;
  let status: GitResult;
  try {
    head = git(['rev-parse', 'HEAD']);
    if (!head.ok) {
      return {
        verified: false,
        violations: [{ kind: 'checkout_unusable', detail: `git rev-parse failed in ${dir}: ${head.stdout.trim()}` }],
      };
    }
    status = git(['status', '--porcelain']);
    if (!status.ok) {
      return {
        verified: false,
        violations: [{ kind: 'checkout_unusable', detail: `git status failed in ${dir}: ${status.stdout.trim()}` }],
      };
    }
  } catch (error) {
    return {
      verified: false,
      violations: [
        {
          kind: 'checkout_unusable',
          detail: `could not run git in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const sha = head.stdout.trim();
  if (sha !== pin.commit) {
    return {
      verified: false,
      head: sha,
      violations: [
        {
          kind: 'pin_mismatch',
          detail: `${dir} is at ${sha || '(nothing)'}; ${PIN_PATH} pins ${pin.commit} (${pin.tag})`,
        },
      ],
    };
  }

  if (status.stdout.trim().length > 0) {
    return {
      verified: false,
      head: sha,
      violations: [
        {
          kind: 'checkout_dirty',
          detail: `${dir} has uncommitted changes; a modified upstream checkout is not the pinned build`,
        },
      ],
    };
  }

  return { verified: true, violations: [], head: sha };
}
