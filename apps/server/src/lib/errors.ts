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
