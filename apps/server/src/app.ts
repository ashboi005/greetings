import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { auth } from "@greetings/auth";
import { db } from "@greetings/db";
import { env } from "@greetings/env/server";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { compression } from "./lib/compression";
import { csrfProtection } from "./lib/csrf-plugin";
import { errorHandler } from "./lib/error-plugin";
import { invalidateAll } from "./lib/session-cache";
import { type ObjectStorage, requireObjectStorage } from "./lib/storage";
import type { TokenVerifier } from "./lib/token-verifier";
import { adminAccountRoutes } from "./modules/admin/accounts";
import { adminAuditRoutes } from "./modules/admin/audit";
import { adminReferenceRoutes } from "./modules/admin/reference";
import { adminRoleRoutes } from "./modules/admin/roles";
import { analyticsRoutes } from "./modules/analytics/routes";
import { authRoutes } from "./modules/auth/routes";
import { adminContentRoutes } from "./modules/content/admin-routes";
import { designerContentRoutes } from "./modules/content/designer-routes";
import { designRoutes } from "./modules/designs/routes";
import { downloadRoutes } from "./modules/downloads/routes";
import { feedRoutes } from "./modules/feed/routes";
import { moderationRoutes } from "./modules/moderation/routes";
import { avatarRoutes } from "./modules/profile/avatar";
import { downloadHistoryRoutes } from "./modules/profile/history";
import { profileRoutes } from "./modules/profile/routes";

/**
 * Builds the application without binding a port, so tests can drive it with
 * `app.handle(new Request(...))` and never need a free socket.
 *
 * Deliberately free of observability wiring. `evlog/elysia` installs an
 * AsyncLocalStorage via enterWith() at import time, which permanently rebinds
 * the async context and stops Bun's test runner from ever marking the *next*
 * test complete. Logging is therefore layered on in index.ts, which also keeps
 * this factory independent of any particular logging transport.
 */
export interface AppOptions {
	/** Injected by tests so sign-in never calls Google. */
	tokenVerifier?: TokenVerifier;
	/** Injected by tests so uploads never reach Cloudflare. */
	objectStorage?: ObjectStorage;
	/**
	 * Public CDN origin for image URLs. Defaults to the environment.
	 *
	 * Injectable for the same reason as the two above: a route that reads the
	 * environment directly cannot be tested against both configured and
	 * unconfigured deployments in one suite, and image URLs are the field the
	 * mobile app depends on most.
	 */
	publicBaseUrl?: string;
}

export function createApp(options: AppOptions = {}) {
	// `in` rather than `??`, so passing `publicBaseUrl: undefined` explicitly
	// means "this deployment has no CDN" instead of silently falling through to
	// the environment. Omitting the key entirely still takes the environment.
	const publicBaseUrl =
		"publicBaseUrl" in options ? options.publicBaseUrl : env.R2_PUBLIC_BASE_URL;

	// Resolved on first use rather than at construction, so a server without R2
	// credentials still boots and only upload endpoints report the gap.
	let storage: ObjectStorage | undefined;
	const getStorage = () => {
		storage ??= requireObjectStorage(
			{
				accountId: env.R2_ACCOUNT_ID,
				accessKeyId: env.R2_ACCESS_KEY_ID,
				secretAccessKey: env.R2_SECRET_ACCESS_KEY,
				bucket: env.R2_BUCKET,
			},
			options.objectStorage,
		);
		return storage;
	};

	return (
		new Elysia()
			.use(errorHandler)
			// Before the routes, so every response passes through it.
			.use(compression)
			.use(
				cors({
					origin: env.CORS_ORIGIN,
					// PUT belongs here: /v1/me/profile and the tag replacement route
					// both use it, and a browser preflight for a method missing from
					// this list is refused before the request is ever made.
					methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
					allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
					credentials: true,
				}),
			)
			.use(
				openapi({
					path: "/docs",
					documentation: {
						info: {
							title: "Greetings API",
							version: "1.0.0",
							description:
								"Backend for Greetings. Mobile clients use the /v1 endpoints; web panels " +
								"additionally use the designer, admin and super-admin routes. This document " +
								"is generated from the route schemas and is the source of truth for clients.",
						},
						tags: [
							{ name: "Health", description: "Liveness and readiness probes" },
							{ name: "Auth", description: "Sign-in and session management" },
						],
					},
					// Better Auth mounts an untyped catch-all that documents itself
					// separately; it would otherwise show up as one opaque route.
					exclude: { paths: ["/api/auth/*"] },
				}),
			)
			// Registered before the auth handler so its routes are covered too.
			.use(csrfProtection([env.CORS_ORIGIN, env.BETTER_AUTH_URL]))
			.all("/api/auth/*", async ({ request, status }) => {
				if (["POST", "GET"].includes(request.method)) {
					const response = await auth.handler(request);

					// Sign-out, session revocation and account linking all happen
					// inside this handler and all can invalidate a cached session.
					// Rather than guess which route did what, any successful write
					// drops the cache: auth writes are rare next to reads, and
					// clearing a few thousand entries costs microseconds.
					if (request.method === "POST" && response.ok) invalidateAll();

					return response;
				}
				return status(405);
			})
			.get("/", () => "OK")
			.get(
				"/health",
				() => ({ status: "ok" as const, service: "greetings-server" }),
				{
					detail: {
						tags: ["Health"],
						summary: "Liveness probe (no dependencies)",
					},
				},
			)
			.get(
				"/health/ready",
				async ({ status }) => {
					try {
						await db.execute(sql`select 1`);
						return { status: "ready" as const, database: "up" as const };
					} catch {
						// Fail closed: reporting ready without a database would let a
						// deploy roll forward into a broken state.
						return status(503, {
							status: "not_ready" as const,
							database: "down" as const,
						});
					}
				},
				{
					detail: {
						tags: ["Health"],
						summary: "Readiness probe (checks database)",
					},
				},
			)
			.use(authRoutes(options.tokenVerifier))
			.use(profileRoutes({ publicBaseUrl }))
			.use(avatarRoutes(getStorage, { publicBaseUrl }))
			.use(downloadHistoryRoutes({ publicBaseUrl }))
			.use(designRoutes(getStorage, { publicBaseUrl }))
			.use(adminRoleRoutes())
			.use(adminAuditRoutes())
			.use(adminAccountRoutes())
			.use(adminReferenceRoutes())
			.use(designerContentRoutes(getStorage))
			.use(adminContentRoutes(getStorage))
			.use(feedRoutes({ publicBaseUrl }))
			.use(downloadRoutes(getStorage, { publicBaseUrl }))
			.use(moderationRoutes())
			.use(analyticsRoutes())
			// Registered last so earlier routes win; this catches only genuinely
			// unmatched paths. A real route rather than the NOT_FOUND branch of
			// onError because the evlog plugin drops the body of that response,
			// which turned production 404s into an empty 404 with no envelope.
			.all(
				"/*",
				({ status }) =>
					status(404, { error: { code: "NOT_FOUND", message: "Not found" } }),
				{
					detail: { hide: true },
				},
			)
	);
}

export type App = ReturnType<typeof createApp>;
