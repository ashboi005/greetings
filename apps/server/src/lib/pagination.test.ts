import { describe, expect, test } from "bun:test";
import { AppError } from "./errors";
import { decodeCursor, encodeCursor } from "./pagination";

describe("encodeCursor / decodeCursor", () => {
	test("round-trips a payload", () => {
		const payload = { nowBucket: 482_000, score: 4.25, id: "abc-123" };
		expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
	});

	test("round-trips values that stress JSON encoding", () => {
		const payload = { title: "शुभ प्रभात", nested: { n: null }, list: [1, -2.5] };
		expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
	});

	test("produces URL-safe output needing no percent-encoding", () => {
		// Payload chosen to force '+' and '/' under standard base64.
		const cursor = encodeCursor({ v: "ÿÿþÿÿÿ" });
		expect(cursor).not.toContain("+");
		expect(cursor).not.toContain("/");
		expect(cursor).not.toContain("=");
		expect(encodeURIComponent(cursor)).toBe(cursor);
	});

	test("distinct payloads yield distinct cursors", () => {
		expect(encodeCursor({ id: "a" })).not.toBe(encodeCursor({ id: "b" }));
	});

	test("rejects a malformed cursor with a 400-class AppError", () => {
		expect(() => decodeCursor("not-a-cursor!!")).toThrow(AppError);
		try {
			decodeCursor("not-a-cursor!!");
		} catch (err) {
			expect((err as AppError).code).toBe("BAD_REQUEST");
		}
	});

	test("rejects valid base64 that does not contain JSON", () => {
		const notJson = Buffer.from("plain text", "utf8").toString("base64url");
		expect(() => decodeCursor(notJson)).toThrow(AppError);
	});

	test("rejects a cursor encoding a JSON scalar rather than an object", () => {
		const scalar = Buffer.from("42", "utf8").toString("base64url");
		expect(() => decodeCursor(scalar)).toThrow(AppError);
	});

	test("rejects an empty cursor", () => {
		expect(() => decodeCursor("")).toThrow(AppError);
	});
});
