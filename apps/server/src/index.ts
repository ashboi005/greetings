import { env } from "@greetings/env/server";
import { Elysia } from "elysia";
import { initLogger } from "evlog";
import { identifyUser } from "evlog/better-auth";
import { evlog } from "evlog/elysia";
import { createFsDrain } from "evlog/fs";
import { createApp } from "./app";
import { errorHandler } from "./lib/error-plugin";
import { getSessionOnce } from "./modules/auth/session";

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

const app = new Elysia()
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
		// Deliberately not evlog's createAuthMiddleware: that resolves the
		// session itself, so logging silently doubled the auth cost of every
		// request. `identifyUser` takes an already-resolved session, and
		// getSessionOnce is shared with the authorisation guard — one lookup
		// serves both.
		if (!new URL(request.url).pathname.startsWith("/api/auth")) {
			const session = await getSessionOnce(request);
			// Anonymous requests have nothing to identify; the log still records
			// the request itself.
			if (session) identifyUser(log, session, { maskEmail: true });
		}
		return {};
	})
	.use(createApp())
	.listen(
		{
			port: env.PORT,
			// Bun buffers a request body in memory before any handler or schema
			// sees it, so without a ceiling a few large POSTs are an out-of-memory
			// kill rather than a 413. Nothing legitimate approaches this: images go
			// straight to R2 and never pass through this process, so the largest
			// real body is a content description.
			maxRequestBodySize: env.MAX_REQUEST_BODY_BYTES,
		},
		({ hostname, port }) => {
			console.log(`Server running on http://${hostname}:${port}`);
			console.log(`API docs at    http://${hostname}:${port}/docs`);
		},
	);

const server = app.server;
if (!server) throw new Error("Server failed to start");
const running = server;

/**
 * Stop taking new work, finish what is in flight, then exit.
 *
 * A container restart or a deploy sends SIGTERM. Without this the process dies
 * mid-request: a download that was counted but never returned a URL, a
 * transaction rolled back after the client saw a socket close. Bun's `stop(true)`
 * closes the listener and waits for open requests to finish.
 *
 * The timer is the backstop. If something is genuinely stuck, exiting late is
 * worse than exiting hard — the orchestrator will send SIGKILL anyway, and doing
 * it ourselves at least runs the exit path.
 */
function shutdown(signal: string) {
	console.log(`${signal} received, finishing in-flight requests`);

	const forceExit = setTimeout(() => {
		console.error("Shutdown timed out, exiting anyway");
		process.exit(1);
	}, 10_000);
	// Do not let the timer itself keep the process alive once draining is done.
	forceExit.unref?.();

	running
		.stop(true)
		.then(() => {
			clearTimeout(forceExit);
			console.log("Shutdown complete");
			process.exit(0);
		})
		.catch((error) => {
			console.error("Error during shutdown:", error);
			process.exit(1);
		});
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
