import { describe, expect, test } from "bun:test";
import { AppError, statusForCode, toErrorEnvelope } from "./errors";

describe("AppError", () => {
	test("carries its code, message and optional details", () => {
		const err = new AppError("CONFLICT", "Content is not in draft", {
			status: "published",
		});
		expect(err.code).toBe("CONFLICT");
		expect(err.message).toBe("Content is not in draft");
		expect(err.details).toEqual({ status: "published" });
		expect(err).toBeInstanceOf(Error);
	});
});

describe("statusForCode", () => {
	test.each([
		["BAD_REQUEST", 400],
		["UNAUTHENTICATED", 401],
		["FORBIDDEN", 403],
		["NOT_FOUND", 404],
		["CONFLICT", 409],
		["PAYLOAD_TOO_LARGE", 413],
		["UNPROCESSABLE", 422],
		["RATE_LIMITED", 429],
		["INTERNAL", 500],
	] as const)("maps %s to HTTP %i", (code, status) => {
		expect(statusForCode(code)).toBe(status);
	});
});

describe("toErrorEnvelope", () => {
	test("wraps an AppError in the documented shape", () => {
		const envelope = toErrorEnvelope(
			new AppError("NOT_FOUND", "No such content"),
		);
		expect(envelope).toEqual({
			error: { code: "NOT_FOUND", message: "No such content" },
		});
	});

	test("includes details only when present", () => {
		const withDetails = toErrorEnvelope(
			new AppError("BAD_REQUEST", "Invalid", { field: "title" }),
		);
		expect(withDetails.error.details).toEqual({ field: "title" });
		expect(
			Object.hasOwn(
				toErrorEnvelope(new AppError("BAD_REQUEST", "Invalid")).error,
				"details",
			),
		).toBe(false);
	});

	test("maps an unknown error to INTERNAL without leaking its message", () => {
		const envelope = toErrorEnvelope(
			new Error("connection string postgres://user:hunter2@host"),
		);
		expect(envelope.error.code).toBe("INTERNAL");
		expect(envelope.error.message).toBe("Internal server error");
		expect(JSON.stringify(envelope)).not.toContain("hunter2");
	});

	test("maps a thrown non-Error value to INTERNAL", () => {
		expect(toErrorEnvelope("something odd").error.code).toBe("INTERNAL");
	});
});
