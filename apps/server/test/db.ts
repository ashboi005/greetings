/**
 * Test database harness (spec §13).
 *
 * Tests run against a real Postgres rather than a mock. The logic worth testing
 * here — feed ranking SQL, rollup arithmetic, partial unique constraints — only
 * exists in the database, so a mock would assert nothing.
 *
 * Requires `bun run db:up` and TEST_DATABASE_URL pointing at greetings_test.
 */

import * as schema from "@greetings/db/schema";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { clearReferenceCache } from "../src/lib/reference-cache";
import { invalidateAll } from "../src/lib/session-cache";

const url = process.env.TEST_DATABASE_URL;

if (!url) {
	throw new Error(
		"TEST_DATABASE_URL is not set. Copy apps/server/.env.example to .env, then run `bun run db:up`.",
	);
}

if (!/_test(\?|$)/.test(url)) {
	// truncateAll() deletes every row it can reach. Refusing any database whose
	// name does not end in _test makes it impossible to point this at dev data.
	throw new Error(
		`Refusing to run tests against ${url} — the database name must end in "_test".`,
	);
}

// Annotated explicitly: the inferred type references pg's Pool, which TypeScript
// cannot name portably from here.
export const testDb: NodePgDatabase<typeof schema> = drizzle(url, { schema });

/**
 * Empties every application table between tests.
 *
 * Discovers tables from the catalogue rather than a hand-maintained list, so a
 * new table added in a later milestone is cleaned automatically instead of
 * leaking rows into the next test. Drizzle's own migration bookkeeping is left
 * alone. CASCADE handles foreign keys; RESTART IDENTITY keeps bigserial ids
 * predictable across tests.
 */
export async function truncateAll(): Promise<void> {
	const result = await testDb.execute<{ tables: string | null }>(sql`
    SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '__drizzle%'
  `);

	const tables = result.rows[0]?.tables;
	if (!tables) return;

	await testDb.execute(
		sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`),
	);

	// Caches derived from the database have to go with it. Reference data is
	// held for a minute in normal operation; a test that wipes the tables and
	// re-seeds different rows would otherwise read the previous test's.
	clearReferenceCache();
	invalidateAll();
}
