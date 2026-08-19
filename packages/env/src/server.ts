import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		DATABASE_URL: z.string().min(1),
		// Only needed to run the test suite, so optional: production deploys must
		// not be forced to define a test database.
		TEST_DATABASE_URL: z.string().min(1).optional(),
		BETTER_AUTH_SECRET: z.string().min(32),
		BETTER_AUTH_URL: z.url(),
		CORS_ORIGIN: z.url(),
		PORT: z.coerce.number().int().min(1).max(65535).default(3000),

		// Verifies mobile sign-in tokens. Optional so the server still boots for
		// local work that does not touch mobile auth; POST /v1/auth/firebase
		// fails with a clear message when it is missing.
		FIREBASE_PROJECT_ID: z.string().min(1).optional(),

		// Web sign-in for designers, admins and super admins. Optional for the
		// same reason: the Google provider is registered only when both are set.
		GOOGLE_CLIENT_ID: z.string().min(1).optional(),
		GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

		// Email granted super_admin by `bun run db:seed`.
		SUPER_ADMIN_EMAIL: z.email().optional(),

		/**
		 * Password for the bootstrap super admin, if the account does not exist.
		 *
		 * Only used on a database with no super admin yet: it is how the very
		 * first panel account comes into being, since public sign-up is disabled
		 * and there is nobody to create it. Set it for the first seed, then
		 * change the password from inside the panel and remove it from the
		 * environment — a long-lived password in a deployment config is a
		 * credential sitting somewhere it does not need to be.
		 */
		SUPER_ADMIN_PASSWORD: z.string().min(12).optional(),

		// --- Cloudflare R2 (spec §6) ---
		// Optional as a group, for the same reason as the auth providers: the
		// server boots without them, and upload endpoints report the gap. All
		// four are needed together.
		R2_ACCOUNT_ID: z.string().min(1).optional(),
		R2_ACCESS_KEY_ID: z.string().min(1).optional(),
		R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
		R2_BUCKET: z.string().min(1).optional(),
		// --- Operational limits (spec §12) ---

		/**
		 * Whether `x-forwarded-for` and `cf-connecting-ip` may be believed.
		 *
		 * A client talking straight to this server sets those headers itself, so
		 * trusting them unconditionally turns per-address rate limiting into
		 * decoration: send a different address each request and no limit ever
		 * trips. Only a deployment that is genuinely behind a proxy which
		 * *overwrites* the header may turn this on. Defaults off, because the
		 * unsafe direction should require a deliberate act.
		 */
		TRUST_PROXY_HEADERS: z
			.enum(["true", "false"])
			.default("false")
			.transform((value) => value === "true"),

		/**
		 * Postgres connections this instance may hold.
		 *
		 * Default sized for a four-core machine: past about twice the core count
		 * more connections buy no throughput and cost latency. Raise it for a
		 * bigger database server, not because requests are queueing — queueing at
		 * the pool is the design.
		 */
		DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

		/**
		 * Longest a single statement may run before Postgres cancels it.
		 *
		 * A query with no ceiling holds its connection indefinitely; enough of
		 * them and the pool is exhausted and every request queues behind work
		 * nobody is waiting for any more.
		 */
		DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
			.number()
			.int()
			.min(100)
			.default(15_000),

		/** Largest request body accepted, in bytes. */
		MAX_REQUEST_BODY_BYTES: z.coerce
			.number()
			.int()
			.min(1024)
			.default(1024 * 1024),

		/**
		 * When the nightly job runs, as `HH:MM` in UTC.
		 *
		 * UTC deliberately, and not configurable to a local zone: the analytics
		 * rollup buckets by UTC calendar day, so a schedule in local time would
		 * drift against the day boundaries it exists to compute. Default is
		 * shortly after midnight UTC, which is early morning in India — after the
		 * day it summarises has closed, and before anyone looks at a dashboard.
		 */
		JOBS_SCHEDULE_UTC: z
			.string()
			.regex(/^\d{1,2}:\d{2}$/, 'Must look like "02:30"')
			.default("02:30"),

		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
	},
	runtimeEnv: process.env,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
	emptyStringAsUndefined: true,
});
