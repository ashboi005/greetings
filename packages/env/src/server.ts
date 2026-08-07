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

		// Email granted super_admin by `bun run seed:super-admin`.
		SUPER_ADMIN_EMAIL: z.email().optional(),

		// --- Cloudflare R2 (spec §6) ---
		// Optional as a group, for the same reason as the auth providers: the
		// server boots without them, and upload endpoints report the gap. All
		// four are needed together.
		R2_ACCOUNT_ID: z.string().min(1).optional(),
		R2_ACCESS_KEY_ID: z.string().min(1).optional(),
		R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
		R2_BUCKET: z.string().min(1).optional(),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
	},
	runtimeEnv: process.env,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
	emptyStringAsUndefined: true,
});
