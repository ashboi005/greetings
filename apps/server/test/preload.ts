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

// `app.handle()` has no socket, so there is no address to read; the suite
// distinguishes callers with x-forwarded-for instead. Production defaults this
// off, which is why it has to be set explicitly here rather than relied upon.
process.env.TRUST_PROXY_HEADERS = "true";

// Tests must not depend on whether the developer happens to have a CDN in their
// .env. Cleared here so `createApp()` with no options always means "no CDN", and
// the tests that exercise the CDN pass a base URL explicitly. Without this, the
// suite's results changed the day a real value was added to .env.
delete process.env.R2_PUBLIC_BASE_URL;
