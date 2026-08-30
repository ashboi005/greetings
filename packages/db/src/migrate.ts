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

/**
 * Timeouts, because the default is to wait forever.
 *
 * `ALTER TABLE ... ADD COLUMN` needs an ACCESS EXCLUSIVE lock, and a migration
 * that cannot get one does not fail — it queues, silently, printing nothing but
 * "Running...". Worse, a queued ACCESS EXCLUSIVE request blocks every *new*
 * reader of that table behind it, so a migration waiting politely on one lock
 * can stall the whole API.
 *
 * Measured for real: an abandoned run left a connection `idle in transaction`
 * holding a half-created type, and the next run blocked on it indefinitely with
 * no indication of why. `lock_timeout` turns that into an error naming the lock,
 * in three seconds.
 *
 * `lock_timeout` deliberately short: waiting for a lock is a signal that
 * something else holds it, and a person should decide what to do about that.
 * `statement_timeout` generous, because building an index on a large table is
 * slow work that genuinely should be allowed to finish.
 */
const pool = new Pool({
	connectionString: url,
	max: 1,
	options: "-c lock_timeout=3s -c statement_timeout=600s",

	// Keepalives, because a production database is usually reached through
	// something — a proxy, a NAT, a tunnel — that drops a quiet TCP connection
	// without telling either end. When that happens mid-migration the server sits
	// in `idle in transaction` holding locks, and this process waits forever for a
	// reply that can never arrive. The visible symptom is "Running..." and no
	// progress, which reads as a slow migration rather than a dead socket.
	//
	// Measured: two consecutive runs died exactly this way, each leaving a
	// half-finished transaction that blocked the next attempt.
	keepAlive: true,
	keepAliveInitialDelayMillis: 10_000,
	connectionTimeoutMillis: 15_000,
});

/**
 * Something a person can act on, whatever was thrown.
 *
 * `error.message` alone is not enough, which this script learned the hard way
 * twice. A `pg` connection failure carries an **empty** message — the useful
 * part is on `code`, `syscall` and `address` — so printing only the message
 * reproduced the exact silence this script was written to replace: "Migration
 * failed:" followed by a blank line.
 */
function describeFailure(cause: unknown): string {
	if (!(cause instanceof Error)) return String(cause);

	const err = cause as Error & {
		code?: string;
		detail?: string;
		hint?: string;
		address?: string;
		port?: number;
		syscall?: string;
	};

	const parts = [err.message, err.detail, err.hint].filter(
		(part): part is string => Boolean(part?.trim()),
	);

	if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
		parts.push(
			`Could not reach the database (${err.code}) at ${err.address ?? "?"}:${err.port ?? "?"}.`,
			"Is it running? For the local databases: bun run db:up",
		);
	} else if (err.code) {
		parts.push(`SQLSTATE/code: ${err.code}`);
	}

	// Never return nothing. An empty report is worse than a stack trace.
	return parts.length > 0 ? parts.join("\n") : (err.stack ?? String(err));
}

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
	console.error(describeFailure(cause));

	// 55P03 lock_not_available, 40P01 deadlock_detected. Both mean the schema
	// change was fine and something else was in the way, which is a completely
	// different problem from a broken migration — and the fix is never "edit the
	// SQL". Naming the query that finds the holder saves the next person the
	// twenty minutes it took to find it the first time.
	const code =
		typeof cause === "object" && cause && "code" in cause
			? (cause as { code?: unknown }).code
			: null;

	if (code === "55P03" || code === "40P01") {
		console.error(
			"\nThis is a lock conflict, not a bad migration. Something else is\n" +
				"holding the table — commonly an earlier run of this command that was\n" +
				"interrupted and left a connection `idle in transaction`.\n\n" +
				"Find it:\n" +
				"  SELECT pid, state, (now() - xact_start)::text AS age,\n" +
				"         left(query, 60) AS q\n" +
				"  FROM pg_stat_activity\n" +
				"  WHERE datname = current_database() AND state <> 'idle'\n" +
				"  ORDER BY xact_start;\n\n" +
				"Then, once you are sure it is abandoned:\n" +
				"  SELECT pg_terminate_backend(<pid>);\n\n" +
				"Terminating rolls its transaction back. Nothing this migration had\n" +
				"done is committed, so re-running afterwards is safe.",
		);
	}

	process.exitCode = 1;
} finally {
	await pool.end();
}
