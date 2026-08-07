/**
 * Opaque cursor encoding for keyset pagination (spec §12).
 *
 * Cursors are base64url-encoded JSON so they survive query strings untouched.
 * They are opaque by convention, not by cryptography: they carry no secrets,
 * and a tampered cursor can only produce an odd page, never a privilege
 * escalation, because every decoded value is bound as a query parameter.
 *
 * Callers own the shape. `decodeCursor` guarantees only that the result is a
 * JSON object; each module validates its own fields.
 */

import { badRequest } from "./errors";

export function encodeCursor(payload: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Record<string, unknown> {
	if (!cursor) {
		throw badRequest("Malformed cursor");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw badRequest("Malformed cursor");
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw badRequest("Malformed cursor");
	}

	return parsed as Record<string, unknown>;
}
