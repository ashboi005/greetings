/**
 * Drizzle config targeting the test database.
 *
 * Identical to drizzle.config.ts except for the connection URL, so migrations
 * are exercised against greetings_test by the same code path that runs them
 * against dev and production. Used by `bun run db:migrate:test`.
 */

import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({
	path: "../../apps/server/.env",
});

const url = process.env.TEST_DATABASE_URL;

if (!url) {
	throw new Error(
		"TEST_DATABASE_URL is not set. Copy apps/server/.env.example to apps/server/.env.",
	);
}

export default defineConfig({
	schema: "./src/schema",
	out: "./src/migrations",
	dialect: "postgresql",
	dbCredentials: { url },
});
