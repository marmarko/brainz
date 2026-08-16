/**
 * Stage 3a — R15's origin fence, on the read side.
 *
 * **KTD5 in one sentence: origin informs ranking, and access evaluates origin
 * alone.** Source-type priors and trust levels are ranking inputs that arrive
 * four stages later; the fence sees `origin_context` and nothing else. The
 * mutable, inferred `subject_context` never widens access and never narrows it —
 * both directions are wrong, and only the first is obviously wrong, which is why
 * `test/core/search/fence.test.ts` pins them separately.
 *
 * **Three row shapes, three rules.** The schema spells origin two ways — scalar
 * on ingested rows, an array on derived ones — and the array rows do not all
 * want the same rule:
 *
 *   - {@link fenceScalar} for `chunk` and `page`: membership.
 *   - {@link fenceRow} for `fact` and `entity_edge`: **subset**. The row's
 *     content is a synthesis of every contributing origin, so a credential that
 *     holds only some of them must not read the synthesis. This is the same
 *     union the database's `fact_page_origin_union` trigger enforces on the
 *     write side, read back.
 *   - {@link fenceEntity} for `entity`: **intersect**. An entity is a *name*, and
 *     a subset rule here refuses to resolve any entity that appears under more
 *     than one credential — which, on a brain with a work and a personal
 *     mailbox, is most of the interesting ones. Refusing them silently disables
 *     the graph arm on exactly the relational queries it exists for.
 *
 * **Why intersect on entities is not a leak.** Resolving a name is not reading a
 * row. Every row the fan-out then produces — the edges, the facts, the chunks —
 * goes back through the subset and scalar rules above. So the credential learns
 * that a name it already saw is a name; it does not learn anything that name
 * touches in an origin it does not hold. The arms are written so that this is
 * structural rather than remembered: fan-out returns ids, and hydration fences.
 *
 * **Everything here is fail-closed.** An empty grant sees nothing (not
 * everything), a row with no origins is refused (not admitted), and an unknown
 * origin string is refused. Each of those is a place where the "obvious"
 * implementation is a silent whole-brain read.
 */

import type { Candidate } from './types.ts';

/** The origins a credential may read. R15's fence, as a query input. */
export type Grant = readonly string[];

/**
 * A grant as a set, built once per query.
 *
 * Exported because the arms build it once and pass it down; rebuilding a `Set`
 * per candidate is the kind of thing that turns a fence into a hot loop and
 * then into a fence somebody removed for performance.
 */
export function grantSet(grant: Grant): ReadonlySet<string> {
  return new Set(grant);
}

/** Scalar origin: `chunk`, `page`, `ingest_log`, `attachment`. */
export function fenceScalar(origin: string, grant: Grant | ReadonlySet<string>): boolean {
  const allowed = grant instanceof Set ? grant : new Set(grant as Grant);
  if (allowed.size === 0) return false;
  return allowed.has(origin);
}

/**
 * Array origin, subset rule: `fact`, `entity_edge`, `contradiction_report`.
 *
 * Every contributing origin must be in the grant. An empty array is refused: the
 * DDL forbids it, and a read path that treated "no origins recorded" as "no
 * restrictions" would turn a write-path bug into a disclosure.
 */
export function fenceRow(origins: readonly string[], grant: Grant | ReadonlySet<string>): boolean {
  const allowed = grant instanceof Set ? grant : new Set(grant as Grant);
  if (allowed.size === 0 || origins.length === 0) return false;
  for (const origin of origins) {
    if (!allowed.has(origin)) return false;
  }
  return true;
}

/**
 * Array origin, intersect rule: `entity` only.
 *
 * See the header for why this one differs. The safety property is not in this
 * function — it is that everything the resolved entity leads to is fenced by
 * {@link fenceRow} or {@link fenceScalar}.
 */
export function fenceEntity(origins: readonly string[], grant: Grant | ReadonlySet<string>): boolean {
  const allowed = grant instanceof Set ? grant : new Set(grant as Grant);
  if (allowed.size === 0) return false;
  for (const origin of origins) {
    if (allowed.has(origin)) return true;
  }
  return false;
}

/**
 * A row's origin union **as this credential may be told it** — the intersection.
 *
 * The companion to {@link fenceEntity}, and needed for exactly the reason that
 * rule is looser than the others. An entity resolves on *intersect* because an
 * entity is a name; the licence for that is the header's sentence — resolving a
 * name is not reading a row, and everything the resolution reaches goes back
 * through the subset and scalar rules. `entity.origin_contexts` is a row
 * attribute rather than the name: returned whole, it tells a `work:mail`
 * credential that the person it just resolved also appears in a mailbox it may
 * not read. No page, chunk or fact crosses, and the fence is still breached —
 * the existence of the personal half is itself the thing being fenced.
 *
 * **The intersection rather than nothing.** The intersection is what the caller
 * already holds, so it discloses nothing, and it keeps the field doing its job,
 * which is attribution. An empty array was the other candidate and is worse
 * *here specifically*: it already means something in this system and it does not
 * mean "redacted". {@link fenceRow} refuses an empty union, `demarcation.ts:
 * isExternalUnion` calls one external, and the DDL forbids `origin_contexts`
 * from being empty at all — every reader treats it as a write-path bug read
 * fail-closed. Synthesising it as a privacy measure overloads a sentinel.
 *
 * **This is for a value a caller is shown, never for a trust decision.** R2a's
 * demarcation asks a different question — could an outsider have written this —
 * and the honest input to that is the *whole* union: an entity whose canonical
 * name an outside sender chose in an origin this grant does not hold is still
 * attacker-authored text, and intersecting first can flip `isExternalUnion` from
 * true to false. So `tools/context.ts:project` keeps reading the union, and the
 * property that makes that safe is that its output carries no origins at all.
 *
 * Fail-closed by construction: an empty grant, or a row with no overlap, returns
 * nothing — which is the same answer the fence would have given before the
 * caller got this far.
 */
export function visibleOrigins(origins: readonly string[], grant: Grant | ReadonlySet<string>): string[] {
  const allowed = grant instanceof Set ? grant : new Set(grant as Grant);
  if (allowed.size === 0) return [];
  return origins.filter((origin) => allowed.has(origin));
}

/**
 * The candidate filter every arm's output passes through.
 *
 * Two predicates, both non-negotiable: live (R12 soft delete, U9 quarantine) and
 * in-grant. They are together in one function because a call site that applied
 * one and forgot the other is the shape both failures take, and a single
 * function is the thing an arm can be required to call.
 */
export function visibleUnder(
  candidates: Iterable<Candidate>,
  grant: Grant | ReadonlySet<string>,
): Candidate[] {
  const allowed = grant instanceof Set ? grant : new Set(grant as Grant);
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.live) continue;
    // Deliberately `candidate.origin`, never `candidate.subject`. KTD5.
    if (!fenceScalar(candidate.origin, allowed)) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * The SQL fragment shape the arms share, as data rather than as prose.
 *
 * Returned as a parameterised predicate rather than interpolated text: origins
 * are credential-derived strings and one of them reaching a query as literal SQL
 * would be an injection through the one column the whole security model rests
 * on. The arms bind `$n::text[]` and use `= ANY`.
 */
export const SCALAR_FENCE_SQL = 'origin_context = ANY($GRANT::text[])';
export const SUBSET_FENCE_SQL = 'origin_contexts <@ $GRANT::text[]';
export const INTERSECT_FENCE_SQL = 'origin_contexts && $GRANT::text[]';
