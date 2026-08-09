import pg from "pg";

/**
 * Counts database statements, for the benchmark. NOT FOR PRODUCTION USE.
 *
 * Importing this module patches the Postgres driver process-wide. It is here so
 * `bun run bench` can measure query counts per endpoint honestly; nothing in
 * src/index.ts or src/jobs/run.ts imports it, so it never reaches a build.
 *
 * Patches BOTH entry points, which is the whole trick. Drizzle sends a plain
 * query through `Pool.query` and a transactional one through a checked-out
 * `Client.query`, and pg-pool replaces `client.query` per checkout — so a
 * counter on either one alone silently misses half the traffic and reports
 * flattering numbers.
 */

let count = 0;
let log: string[] = [];

function record(args: unknown[]) {
	count++;
	const first = args[0] as { text?: string } | string | undefined;
	const text = typeof first === "string" ? first : (first?.text ?? "?");
	log.push(String(text).replace(/\s+/g, " ").trim().slice(0, 70));
}

for (const target of [pg.Client, pg.Pool]) {
	const original = target.prototype.query;
	// biome-ignore lint/suspicious/noExplicitAny: measurement harness
	(target.prototype as any).query = function (this: unknown, ...args: any[]) {
		record(args);
		// biome-ignore lint/suspicious/noExplicitAny: measurement harness
		return (original as any).apply(this, args);
	};
}

export function resetQueryCount() {
	count = 0;
	log = [];
}
export function queryCount() {
	return count;
}
export function queryLog() {
	return [...log];
}
