/**
 * The model-id pin guard (U7 approach step 8; KTD13's enforcement half).
 *
 * KTD13 buys a specific diagnostic property by putting a current-generation
 * model in every seat: **a floor miss indicts the architecture, not the model
 * tier.** That property is only true if production runs the model each receipt
 * was scored against. The catalog names are moving aliases — `src/ai/routing.ts`
 * pins dated snapshots precisely because `gemini-3.5-flash-lite` already
 * succeeded a predecessor — so a vendor advancing an alias, or a maintainer
 * editing a row, invalidates every committed receipt with no signal at all.
 *
 * **This guard's own failure mode is being vacuous.** Today no op has a receipt
 * naming a routed model id: U7's committed vectors are synthetic (the R6a
 * receipts' `embedding_source.model` is `synthetic-lexical-v1`, the fixture
 * generator, *not* a routed model), `rerank` and `judge` have nothing scored
 * yet, and `extract`/`enrich`/`contradiction`/`salience`/`synopsis` are U11
 * deliverables, `vision` is U21. A guard that looped over the receipts it found
 * would loop zero times and pass forever.
 *
 * So it runs in the other direction, exhaustively: **every op of every routing
 * profile is either pinned by a receipt or carries a deferral naming what it
 * waits for and which unit owns closing it.** In neither is red; in both is red;
 * a committed receipt naming an id nobody registered is red; a registered pin
 * whose receipt does not carry the claim is red. That is `evals/gates.ts`'s
 * deferred-floor discipline and `scripts/check-ledger.ts`'s
 * classify-or-fail discipline, applied to model identity.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MODEL_OPS,
  PROFILES,
  type ModelOp,
  type RoutingProfileName,
} from '../src/ai/routing.ts';

export const LEDGER_PATH = 'evals/receipts/model-ids.json';
export const RECEIPTS_DIR = 'evals/receipts';

export interface ReceiptPin {
  readonly op: ModelOp;
  /** The id the receipt was scored against. Compared against the routed id. */
  readonly model_id: string;
  /** The committed receipt carrying the claim. */
  readonly receipt: string;
  readonly scored_on: string;
}

export interface PinDeferral {
  /** One row may cover several ops that are waiting on the same thing. */
  readonly ops: readonly ModelOp[];
  /** What would close it. An empty value is refused. */
  readonly awaiting: string;
  /** Who owns closing it. A deferral with no owner is a deferral forever. */
  readonly unit: string;
  readonly note: string;
}

export interface ProfileLedger {
  readonly pins: readonly ReceiptPin[];
  readonly deferrals: readonly PinDeferral[];
}

export interface PinLedger {
  readonly note: string;
  readonly profiles: Readonly<Partial<Record<RoutingProfileName, ProfileLedger>>>;
}

/** What one committed receipt claims to have been scored against. */
export interface ReceiptClaim {
  readonly path: string;
  readonly profile: RoutingProfileName | null;
  readonly models: Readonly<Record<string, string>>;
}

export type PinViolationKind =
  | 'missing_profile'
  | 'unpinned_op'
  | 'double_declared'
  | 'duplicate_declaration'
  | 'pin_drift'
  | 'unregistered_receipt'
  | 'receipt_conflict'
  | 'orphan_pin';

export interface PinViolation {
  readonly kind: PinViolationKind;
  readonly detail: string;
}

export interface PinResult {
  readonly passed: boolean;
  readonly violations: readonly PinViolation[];
  readonly pinned: number;
  readonly deferred: number;
}

const PROFILE_NAMES = Object.keys(PROFILES) as readonly RoutingProfileName[];
const OP_NAMES: readonly string[] = MODEL_OPS;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asOp(value: unknown, where: string): ModelOp {
  if (typeof value !== 'string' || !OP_NAMES.includes(value)) {
    throw new Error(`${where}: ${JSON.stringify(value)} is not one of ${OP_NAMES.join(', ')}`);
  }
  return value as ModelOp;
}

function asProfileName(value: unknown, where: string): RoutingProfileName {
  if (typeof value !== 'string' || !(PROFILE_NAMES as readonly string[]).includes(value)) {
    throw new Error(`${where}: ${JSON.stringify(value)} is not one of ${PROFILE_NAMES.join(', ')}`);
  }
  return value as RoutingProfileName;
}

export function parsePinLedger(text: string): PinLedger {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error(`${LEDGER_PATH} is not a JSON object`);
  if (!nonEmpty(raw['note'])) throw new Error(`${LEDGER_PATH} note is missing`);
  const profilesRaw = raw['profiles'];
  if (!isObject(profilesRaw)) throw new Error(`${LEDGER_PATH} profiles is missing`);

  const profiles: Partial<Record<RoutingProfileName, ProfileLedger>> = {};
  for (const [name, value] of Object.entries(profilesRaw)) {
    const profile = asProfileName(name, `${LEDGER_PATH} profiles`);
    if (!isObject(value)) throw new Error(`${LEDGER_PATH} profiles.${name} is not an object`);

    const pinsRaw = value['pins'];
    if (!Array.isArray(pinsRaw)) throw new Error(`${LEDGER_PATH} profiles.${name}.pins is not an array`);
    const pins: ReceiptPin[] = pinsRaw.map((row, index) => {
      const where = `${LEDGER_PATH} profiles.${name}.pins[${index}]`;
      if (!isObject(row)) throw new Error(`${where} is not an object`);
      if (!nonEmpty(row['model_id'])) throw new Error(`${where}.model_id is missing`);
      if (!nonEmpty(row['receipt'])) throw new Error(`${where}.receipt is missing — a pin names the receipt it reads`);
      if (!nonEmpty(row['scored_on'])) throw new Error(`${where}.scored_on is missing`);
      return {
        op: asOp(row['op'], `${where}.op`),
        model_id: row['model_id'],
        receipt: row['receipt'],
        scored_on: row['scored_on'],
      };
    });

    const deferralsRaw = value['deferrals'];
    if (!Array.isArray(deferralsRaw)) throw new Error(`${LEDGER_PATH} profiles.${name}.deferrals is not an array`);
    const deferrals: PinDeferral[] = deferralsRaw.map((row, index) => {
      const where = `${LEDGER_PATH} profiles.${name}.deferrals[${index}]`;
      if (!isObject(row)) throw new Error(`${where} is not an object`);
      const ops = row['ops'];
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error(`${where}.ops must be a non-empty array; a deferral over no ops declares nothing`);
      }
      if (!nonEmpty(row['awaiting'])) {
        throw new Error(`${where}.awaiting is missing — say what would close this deferral`);
      }
      if (!nonEmpty(row['unit'])) {
        throw new Error(`${where}.unit is missing — a deferral with no owner is a deferral forever`);
      }
      if (!nonEmpty(row['note'])) throw new Error(`${where}.note is missing`);
      return {
        ops: ops.map((op, i) => asOp(op, `${where}.ops[${i}]`)),
        awaiting: row['awaiting'],
        unit: row['unit'],
        note: row['note'],
      };
    });

    profiles[profile] = { pins, deferrals };
  }

  return { note: raw['note'], profiles };
}

/**
 * Read one receipt's claim about the models it was scored against.
 *
 * A receipt with no `scored_against` block claims nothing — which is the honest
 * state of both R6a receipts, since they were produced with zero model calls. A
 * *malformed* block throws rather than degrading to "no claim": that degradation
 * is how a receipt silently stops binding its model.
 */
export function receiptClaims(path: string, body: unknown): ReceiptClaim {
  if (!isObject(body)) throw new Error(`${path} is not a JSON object`);
  const block = body['scored_against'];
  if (block === undefined) return { path, profile: null, models: {} };
  if (!isObject(block)) throw new Error(`${path} scored_against is not an object`);

  const profile = asProfileName(block['profile'], `${path} scored_against.profile`);
  const models = block['models'];
  if (!isObject(models)) throw new Error(`${path} scored_against.models is not an object`);

  const out: Record<string, string> = {};
  for (const [op, id] of Object.entries(models)) {
    asOp(op, `${path} scored_against.models`);
    if (!nonEmpty(id)) throw new Error(`${path} scored_against.models.${op} is not a model id`);
    out[op] = id;
  }
  return { path, profile, models: out };
}

export function checkModelIdPins(input: {
  readonly ledger: PinLedger;
  readonly receipts: readonly ReceiptClaim[];
}): PinResult {
  const violations: PinViolation[] = [];
  let pinned = 0;
  let deferred = 0;

  for (const profileName of PROFILE_NAMES) {
    const profile = input.ledger.profiles[profileName];
    if (profile === undefined) {
      violations.push({
        kind: 'missing_profile',
        detail: `${LEDGER_PATH} has no entry for the ${profileName} profile; every profile's ids drift independently`,
      });
      continue;
    }

    const routes = PROFILES[profileName].routes;
    const declaredBy = new Map<ModelOp, 'pin' | 'deferral'>();

    for (const pin of profile.pins) {
      const previous = declaredBy.get(pin.op);
      if (previous !== undefined) {
        violations.push({
          kind: 'duplicate_declaration',
          detail: `${profileName}/${pin.op} is declared more than once in ${LEDGER_PATH}`,
        });
        continue;
      }
      declaredBy.set(pin.op, 'pin');

      const routed = routes[pin.op].id;
      if (routed !== pin.model_id) {
        violations.push({
          kind: 'pin_drift',
          detail:
            `${profileName}/${pin.op} routes to ${routed} but its last committed receipt ` +
            `(${pin.receipt}, ${pin.scored_on}) was scored against ${pin.model_id}; ` +
            're-score the op or revert the routing change',
        });
        continue;
      }
      pinned += 1;
    }

    for (const deferral of profile.deferrals) {
      for (const op of deferral.ops) {
        const previous = declaredBy.get(op);
        if (previous === 'pin') {
          violations.push({
            kind: 'double_declared',
            detail: `${profileName}/${op} is both pinned by a receipt and deferred; one of the two is stale`,
          });
          continue;
        }
        if (previous === 'deferral') {
          violations.push({
            kind: 'duplicate_declaration',
            detail: `${profileName}/${op} is deferred more than once in ${LEDGER_PATH}`,
          });
          continue;
        }
        declaredBy.set(op, 'deferral');
        deferred += 1;
      }
    }

    for (const op of MODEL_OPS) {
      if (declaredBy.has(op)) continue;
      violations.push({
        kind: 'unpinned_op',
        detail:
          `${profileName}/${op} routes to ${routes[op].id} and is neither pinned by a receipt nor deferred; ` +
          `add it to ${LEDGER_PATH} — an op nobody classified is an op whose receipts nobody can trust`,
      });
    }

    // The other direction: a committed receipt that names an id the ledger has
    // never heard of. Without this, a receipt can bind a model that the guard
    // never compares to the routing table.
    for (const claim of input.receipts) {
      if (claim.profile !== profileName) continue;
      for (const [op, id] of Object.entries(claim.models)) {
        const pin = profile.pins.find((candidate) => candidate.op === op);
        if (pin === undefined) {
          violations.push({
            kind: 'unregistered_receipt',
            detail: `${claim.path} says it scored ${profileName}/${op} against ${id}, but ${LEDGER_PATH} has no pin for it`,
          });
          continue;
        }
        if (pin.model_id !== id) {
          violations.push({
            kind: 'receipt_conflict',
            detail: `${claim.path} scored ${profileName}/${op} against ${id}; ${LEDGER_PATH} records ${pin.model_id}`,
          });
        }
      }
    }

    for (const pin of profile.pins) {
      const claim = input.receipts.find((candidate) => candidate.path === pin.receipt);
      const claimed = claim?.models[pin.op];
      if (claimed === undefined) {
        violations.push({
          kind: 'orphan_pin',
          detail:
            `${LEDGER_PATH} pins ${profileName}/${pin.op} to ${pin.receipt}, but that receipt carries no ` +
            `scored_against claim for it; the pin reads a receipt that does not exist`,
        });
      }
    }
  }

  return { passed: violations.length === 0, violations, pinned, deferred };
}

export interface LoadedPinLedger {
  readonly ledger: PinLedger;
  readonly receipts: readonly ReceiptClaim[];
  readonly result: PinResult;
}

/** Read the committed ledger and every committed receipt, then check them. */
export function loadPinLedger(): LoadedPinLedger {
  const root = new URL('..', import.meta.url);
  const ledger = parsePinLedger(readFileSync(fileURLToPath(new URL(LEDGER_PATH, root)), 'utf8'));

  const dir = fileURLToPath(new URL(`${RECEIPTS_DIR}/`, root));
  const receipts: ReceiptClaim[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = `${RECEIPTS_DIR}/${name}`;
    if (path === LEDGER_PATH) continue;
    receipts.push(receiptClaims(path, JSON.parse(readFileSync(`${dir}${name}`, 'utf8'))));
  }

  return { ledger, receipts, result: checkModelIdPins({ ledger, receipts }) };
}

export function renderPinReport(result: PinResult): string {
  const lines = [
    `model-id pins: ${result.pinned} pinned by receipt, ${result.deferred} deferred, ` +
      `${result.violations.length} violation(s)`,
  ];
  for (const violation of result.violations) lines.push(`  [${violation.kind}] ${violation.detail}`);
  return lines.join('\n');
}
