import { Elysia } from "elysia";
import { AppError, statusForCode } from "./errors";

/**
 * Translates every thrown value into the API's error envelope (spec §12).
 *
 * Registered as a named plugin so it can be mounted on more than one Elysia
 * instance without running twice: unmatched-route 404s are handled by the
 * *outermost* instance, so the production entrypoint needs this as well as
 * `createApp()`. Elysia dedupes by `name`.
 */
export const errorHandler = new Elysia({ name: "error-handler" }).onError(
	{ as: "global" },
	({ code, error, set }) => {
		if (error instanceof AppError) {
			set.status = statusForCode(error.code);
			return {
				error: {
					code: error.code,
					message: error.message,
					...(error.details === undefined ? {} : { details: error.details }),
				},
			};
		}

		switch (code) {
			case "VALIDATION": {
				set.status = 422;
				// Widened to `unknown` deliberately: referencing Elysia's internal
				// ValueErrorWithSummary type here makes this plugin's inferred type
				// unnameable, which breaks declaration emit for every consumer.
				const details: unknown = "all" in error ? error.all : undefined;
				return {
					error: {
						code: "UNPROCESSABLE",
						message: "Request validation failed",
						details,
					},
				};
			}
			case "NOT_FOUND":
				set.status = 404;
				return { error: { code: "NOT_FOUND", message: "Not found" } };
			case "PARSE":
				set.status = 400;
				return {
					error: { code: "BAD_REQUEST", message: "Malformed request body" },
				};
			default:
				// The real cause belongs in the server log, never in the response.
				console.error("Unhandled error:", error);
				set.status = 500;
				return {
					error: { code: "INTERNAL", message: "Internal server error" },
				};
		}
	},
);
