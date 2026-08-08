import { env } from "@greetings/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * The Postgres connection pool.
 *
 * Left to itself, `drizzle(url)` builds a pool with node-postgres defaults —
 * ten connections, no statement timeout, no bound on how long a request waits
 * for one. Each of those is fine until the day it is not, and the day it is not
 * is the day the site is busy.
 *
 * Sizing. More connections is not more throughput: past roughly twice the core
 * count, Postgres backends contend for the same CPUs and every query gets
 * slower while none get done sooner. The rule of thumb is
 * `(cores × 2) + effective spindles`, which on a four-core VPS with SSD is
 * about nine. Ten is the default here for that reason, not because it is a
 * round number, and `DATABASE_POOL_MAX` exists because the right answer is a
 * property of the machine.
 *
 * Under load this pool is where requests queue, and that is deliberate. Ten
 * queries running and the rest waiting finishes more work than two hundred
 * running at once, and it keeps the database responsive for the health check
 * that decides whether this instance is still alive.
 */
function createPool() {
	return new Pool({
		connectionString: env.DATABASE_URL,
		max: env.DATABASE_POOL_MAX,

		// How long a request may wait for a connection before being refused. The
		// alternative is an unbounded queue, where a burst leaves clients holding
		// sockets open for work whose caller gave up minutes ago. Failing fast
		// sheds that load; the error handler turns it into a 503-shaped answer
		// rather than a hang.
		connectionTimeoutMillis: 5_000,

		// Idle connections are closed rather than held forever, so a quiet
		// instance stops occupying slots other instances could use.
		idleTimeoutMillis: 30_000,

		options: [
			// A query with no ceiling holds its connection until it finishes or the
			// client disconnects — and a disconnected client does not stop the
			// query. Enough of those and the pool is full of work nobody wants.
			`-c statement_timeout=${env.DATABASE_STATEMENT_TIMEOUT_MS}`,

			// A transaction left open by a crashed process holds its locks and
			// pins the vacuum horizon indefinitely. Twice the statement timeout
			// gives a legitimate multi-statement transaction room.
			`-c idle_in_transaction_session_timeout=${env.DATABASE_STATEMENT_TIMEOUT_MS * 2}`,

			// Every timestamp column in this schema is `timestamp without time
			// zone`, and the analytics rollup buckets by UTC calendar day. Pinning
			// the session timezone makes the day boundary a property of the
			// application rather than of whatever the host's clock is set to — the
			// kind of difference that shows up as one day's numbers being wrong
			// months after the machine was provisioned.
			"-c timezone=UTC",
		].join(" "),
	});
}

export function createDb() {
	const pool = createPool();

	// An error on an idle connection — the database restarting, a network blip,
	// an idle timeout from the server side — is emitted on the pool. Without a
	// listener, node's default for an unhandled 'error' event is to crash the
	// process. The pool recovers on its own; the process would not.
	pool.on("error", (error) => {
		console.error("Idle Postgres client error:", error);
	});

	return drizzle(pool, { schema });
}

export const db = createDb();
