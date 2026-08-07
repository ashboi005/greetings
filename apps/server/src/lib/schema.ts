import { t } from "elysia";

/**
 * An optional enum-valued parameter that is genuinely optional.
 *
 * `t.Optional(t.UnionEnum([...]))` looks right and is not: when the parameter
 * is absent, it resolves to the *first* value in the list rather than
 * undefined. A `status` filter written that way silently filters every listing
 * to the first status, which reads as an empty or truncated result rather than
 * an error. `t.String({ enum })` stays undefined and still documents the
 * allowed values in the OpenAPI schema.
 *
 * Required enum fields are unaffected — `t.UnionEnum` is fine there.
 */
export function optionalEnum<const T extends readonly string[]>(
	values: T,
	options: { description?: string } = {},
) {
	// t.Unsafe narrows the *static* type back to the union while keeping the
	// runtime schema a plain string-with-enum. Without it the value widens to
	// `string`, and Drizzle's `eq()` rejects it against an enum column.
	return t.Optional(
		t.Unsafe<T[number]>(
			t.String({ enum: [...values], description: options.description }),
		),
	);
}
