import { describe, expect, test } from "bun:test";
import { assertIsoDate } from "./iso-date";

describe("strict ISO calendar dates", () => {
	test("accepts real calendar dates, including leap day", () => {
		expect(() => assertIsoDate("2024-02-29", "from")).not.toThrow();
		expect(() => assertIsoDate("2026-12-31", "to")).not.toThrow();
	});

	test("rejects dates that JavaScript silently normalizes", () => {
		for (const value of ["2026-02-29", "2026-02-31", "2026-04-31"] as const) {
			expect(() => assertIsoDate(value, "from")).toThrow(
				expect.objectContaining({ code: "BAD_REQUEST" }),
			);
		}
	});

	test("rejects malformed values and identifies the field", () => {
		expect(() => assertIsoDate("2026-2-03", "to")).toThrow(
			expect.objectContaining({
				code: "BAD_REQUEST",
				message: expect.stringContaining("to"),
			}),
		);
	});
});
