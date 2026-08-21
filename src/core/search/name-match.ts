/**
 * Turning a name somebody typed into a pattern that matches that name and not
 * the words it happens to sit inside.
 *
 * **This was `subject-erasure.ts`'s private helper until it had three callers.**
 * The erasure sweep, the `entity` tool's fact lookup and `?view=entity` all ask
 * the same question — *which stored sentences mention this person* — and they
 * are the three surfaces where getting it wrong is expensive in three different
 * directions: an erasure that silently did not happen, a tool answer that
 * attributes a stranger's sentence to the subject, and a count on a page whose
 * whole job is being honest about what the brain holds. One rule, one
 * implementation, and the argument in one place.
 *
 * **`\m` and `\M` are word-boundary assertions, not `LIKE`.** They are what make
 * `al` reach the person called Al without reaching `legal`, `Alvarez`,
 * `renewal` or `Alberta`. The escaping is regex escaping for the same reason
 * the pattern is a regex at all: `J.P.` under a LIKE-escaped pattern would
 * match `JXPX`.
 *
 * **The fallback direction is chosen rather than inherited.** A form starting
 * with `@` or an accented letter gets no assertion at that end and falls back to
 * substring matching there, which is *wider*. That is deliberate: a sweep that
 * matches too much is caught by a human reading the preview, and one that
 * matches too little is an erasure that silently did not happen. On the read
 * surfaces the same widening shows up as a count that may include a sentence
 * about somebody else — which those surfaces say out loud rather than hide.
 */

/**
 * A POSIX ARE pattern for `~*` that matches this name at word boundaries.
 *
 * Callers must apply their own length floor before using it: a one- or
 * two-character form is a substring rather than a name, and no pattern can
 * repair that. `src/core/briefing/assemble.ts` ships the same guard on the same
 * join.
 */
export function nameMatchPattern(form: string): string {
  const head = isWordCharacter(form.charAt(0)) ? '\\m' : '';
  const tail = isWordCharacter(form.charAt(form.length - 1)) ? '\\M' : '';
  return `${head}${escapeRegex(form)}${tail}`;
}

/** The POSIX ARE metacharacters, and nothing else. */
function escapeRegex(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, (character) => `\\${character}`);
}

/** ASCII only, so the fallback is the wide direction rather than the silent one. */
function isWordCharacter(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}
