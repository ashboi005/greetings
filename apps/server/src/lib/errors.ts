/**
 * The single error vocabulary for the API (spec §12).
 *
 * Every failure leaves the server as `{ error: { code, message, details? } }`.
 * Codes are a closed set so the mobile and web clients can branch on `code`
 * rather than parsing prose or matching HTTP status alone.
 */

const CODE_STATUS = {
	BAD_REQUEST: 400,
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	PAYLOAD_TOO_LARGE: 413,
	UNPROCESSABLE: 422,
	RATE_LIMITED: 429,
	INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof CODE_STATUS;

export interface ErrorEnvelope {
	error: {
		code: ErrorCode;
		message: string;
		details?: unknown;
	};
}

/** An error that is safe to show a client: its message is deliberate, not incidental. */
export class AppError extends Error {
	readonly code: ErrorCode;
	readonly details?: unknown;

	constructor(code: ErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "AppError";
		this.code = code;
		this.details = details;
	}
}

export function statusForCode(code: ErrorCode): number {
	return CODE_STATUS[code];
}

/**
 * Convert anything thrown into a client-safe envelope.
 *
 * Only `AppError` messages reach the client. Everything else collapses to a
 * generic INTERNAL message, because incidental errors carry connection
 * strings, file paths, and driver internals that must not leave the server.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
	if (err instanceof AppError) {
		return {
			error: {
				code: err.code,
				message: err.message,
				...(err.details === undefined ? {} : { details: err.details }),
			},
		};
	}

	return { error: { code: "INTERNAL", message: "Internal server error" } };
}

// Convenience constructors for the codes used most often.
export const badRequest = (message: string, details?: unknown) =>
	new AppError("BAD_REQUEST", message, details);
export const unauthenticated = (message = "Authentication required") =>
	new AppError("UNAUTHENTICATED", message);
export const forbidden = (message = "Insufficient permissions") =>
	new AppError("FORBIDDEN", message);
export const notFound = (message = "Not found") =>
	new AppError("NOT_FOUND", message);
export const conflict = (message: string, details?: unknown) =>
	new AppError("CONFLICT", message, details);
export const tooManyRequests = (message = "Too many requests") =>
	new AppError("RATE_LIMITED", message);

/**
 * Reads the SQLSTATE off a thrown database error, or null if it is not one.
 *
 * Drizzle wraps driver errors, so the pg error carrying `code` sits somewhere
 * down the `cause` chain rather than on the thrown object. Code that maps a
 * constraint violation to a 4xx must walk the chain, or the violation escapes
 * as a 500.
 */
function pgErrorCode(cause: unknown): string | null {
	let current = cause;

	for (let depth = 0; current && depth < 5; depth++) {
		if (typeof current === "object" && "code" in current) {
			const code = (current as { code?: unknown }).code;
			// Only a SQLSTATE shape counts, and anything else keeps walking. Node
			// and Elysia both put their own string `code` on errors, so returning
			// the first one found would mask a real violation sitting deeper in the
			// chain — which is the bug this function exists to avoid.
			if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
		}
		current = (current as { cause?: unknown }).cause;
	}

	return null;
}

/** Detects a Postgres unique violation (SQLSTATE 23505). */
export function isUniqueViolation(cause: unknown): boolean {
	return pgErrorCode(cause) === "23505";
}

/**
 * Detects a Postgres foreign key violation (SQLSTATE 23503).
 *
 * This is how "you cannot delete this because something still points at it"
 * arrives. Relying on the constraint rather than a prior count is what makes
 * the check race-free: a row referenced between the count and the delete would
 * slip past any application-level guard.
 */
export function isForeignKeyViolation(cause: unknown): boolean {
	return pgErrorCode(cause) === "23503";
}
