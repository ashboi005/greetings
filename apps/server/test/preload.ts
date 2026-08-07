/**
 * Runs before every test file (wired via bunfig.toml).
 *
 * Repoints DATABASE_URL at the test database *before* any module reads the
 * environment. `packages/env` validates at import time and `packages/db`
 * builds its client from that snapshot, so doing this inside a test file would
 * be too late — the app would already hold a connection to the dev database.
 */

import "dotenv/config";

const testUrl = process.env.TEST_DATABASE_URL;

if (!testUrl) {
	throw new Error(
		"TEST_DATABASE_URL is not set. Copy apps/server/.env.example to .env, then run `bun run db:up`.",
	);
}

if (!/_test(\?|$)/.test(testUrl)) {
	throw new Error(
		`Refusing to run tests against ${testUrl} — the database name must end in "_test".`,
	);
}

process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = "test";
