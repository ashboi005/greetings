import { auth } from "@greetings/auth";
import { env } from "@greetings/env/server";
import { Elysia } from "elysia";
import { initLogger } from "evlog";
import {
	type BetterAuthInstance,
	createAuthMiddleware,
} from "evlog/better-auth";
import { evlog } from "evlog/elysia";
import { createFsDrain } from "evlog/fs";
import { createApp } from "./app";
import { errorHandler } from "./lib/error-plugin";

/**
 * Production entrypoint: observability wrapped around the app.
 *
 * The evlog Elysia plugin is imported here and nowhere else. It installs an
 * AsyncLocalStorage at module scope, which breaks Bun's test runner, so
 * `createApp()` in app.ts stays free of it and the tests import that instead.
 */

initLogger({
	env: { service: "greetings-server" },
});

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
	exclude: ["/api/auth/**"],
	maskEmail: true,
});

new Elysia()
	// Also mounted here, not just inside createApp(): unmatched routes are
	// handled by the outermost instance, so without this a 404 would escape as
	// Elysia's default body instead of the API's envelope.
	.use(errorHandler)
	.use(
		evlog({
			drain: env.NODE_ENV === "development" ? createFsDrain() : undefined,
		}),
	)
	.derive({ as: "global" }, async ({ request, log }) => {
		await identifyUser(log, request.headers, new URL(request.url).pathname);
		return {};
	})
	.use(createApp())
	.listen(env.PORT, ({ hostname, port }) => {
		console.log(`Server running on http://${hostname}:${port}`);
		console.log(`API docs at    http://${hostname}:${port}/docs`);
	});
