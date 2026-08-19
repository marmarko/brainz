/**
 * Postgres array literals, in one place.
 *
 * Bun's SQL template **spreads** a JavaScript array into a value list — which is
 * right for `IN ${ids}` and wrong for every column in this schema typed
 * `text[]`. Binding `['personal']` against `$1::text[]` sends the bare string
 * `personal`, and Postgres answers `malformed array literal`. That is the loud
 * version; the quiet version is a single-element array that happens to look
 * like a valid literal, which is why the escaping below is not optional.
 *
 * The columns this serializes are `origin_contexts` on `fact`, `entity`,
 * `entity_edge` and `contradiction_report` — R15's fence, the thing KTD5
 * evaluates access on. A serializer that drops or mangles an element is a
 * derived row narrower than its inputs, which is the failure the whole origin
 * union exists to prevent.
 */

/**
 * `{"a","b"}` — the literal form, with `"` and `\` escaped, for binding as text
 * and casting (`${textArrayLiteral(values)}::text[]`). Binding as text and
 * letting the cast parse it is the same shape the JSONB rule upstream settles
 * on for the same reason: the driver's own array handling is not the one this
 * column wants.
 */
export function textArrayLiteral(values: readonly string[]): string {
  const escaped = values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/**
 * `{1,2}` — the same literal form for `bigint[]` and `float8[]`, which the
 * batched writes bind to drive an `unnest`.
 *
 * **The absence of escaping is the thing to check when editing.** Every value
 * passed here is either a row id this process read out of the database (digits)
 * or a number the caller computed; neither can carry a quote and neither is user
 * text. Hand it anything derived from a document and it needs
 * {@link textArrayLiteral}'s treatment instead — a name that ended its own
 * element early is how a batched write silently writes the wrong row.
 */
export function numericArrayLiteral(values: readonly (string | number)[]): string {
  return `{${values.join(',')}}`;
}
