/**
 * Applies migrations. `bun run db:migrate`.
 *
 * Replaces a bare `drizzle-kit migrate` for two reasons, both learned the hard
 * way against a real deployment.
 *
 * **It creates `pg_trgm` first.** Two migrations build trigram indexes with
 * `gin_trgm_ops`, which needs that extension. Nothing in the migration history
 * creates it: locally it comes from scripts/init-db.sql, and in CI from an
 * explicit psql step. Neither runs against a production database, so a fresh one
 * failed at migration 0002 — the schema depended on something outside itself.
 * `IF NOT EXISTS` makes this a no-op everywhere it already exists.
 *
 * **It reports failures.** `drizzle-kit migrate` prints a spinner and exits 1
 * with the error swallowed, which is the worst possible behaviour for the one
 * command you run against production by hand.
 */

import { join } from "node:path";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// This runs with packages/db as its working directory, so the server's .env is
// not picked up automatically. Resolved from this file rather than the cwd so it
// works however the script is invoked, and dotenv never overrides a variable
// that is already set — which is what lets an inline DATABASE_URL win.
dotenv.config({ path: join(import.meta.dir, "../../../apps/server/.env") });

// `--test` targets TEST_DATABASE_URL instead, so the same runner serves both and
// there is only one place migrations can go wrong.
const useTestDatabase = process.argv.includes("--test");
const url = useTestDatabase
	? process.env.TEST_DATABASE_URL
	: process.env.DATABASE_URL;

if (!url) {
	console.error(
		useTestDatabase
			? "TEST_DATABASE_URL is not set."
			: "DATABASE_URL is not set.",
	);
	process.exit(1);
}

// The same guard the test harness uses. Migrating the development or production
// database because a flag was passed by mistake is the kind of error worth
// making impossible rather than unlikely.
if (useTestDatabase && !/_test(\?|$)/.test(url)) {
	console.error(
		`Refusing --test against ${url.replace(/:[^:@]*@/, ":***@")} — the database name must end in "_test".`,
	);
	process.exit(1);
}

// Named so the log says which database was touched, without printing the
// password that sits in the middle of the connection string.
function describe(connection: string): string {
	try {
		const parsed = new URL(connection);
		return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
	} catch {
		return "(unparseable DATABASE_URL)";
	}
}

const pool = new Pool({ connectionString: url, max: 1 });

try {
	console.log(`Migrating ${describe(url)}`);

	// Required by the trigram indexes below. Superuser is not needed for
	// pg_trgm on managed Postgres, but if this fails the message is worth
	// seeing rather than the index error three migrations later.
	await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

	await migrate(drizzle(pool), {
		migrationsFolder: join(import.meta.dir, "migrations"),
	});

	console.log("Migrations applied.");
} catch (cause) {
	console.error("\nMigration failed:");
	console.error(cause instanceof Error ? cause.message : cause);
	process.exitCode = 1;
} finally {
	await pool.end();
}
