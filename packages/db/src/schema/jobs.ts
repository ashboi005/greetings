import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * A record of every scheduled run (spec §12.5).
 *
 * A job that runs unattended and leaves no trace has one failure mode nobody
 * notices: not running. The dashboards would keep showing yesterday's numbers,
 * the feed would keep ranking on stale popularity, and the first sign would be
 * someone asking why the analytics look wrong — weeks later.
 *
 * So each run writes a row before it starts and updates it when it ends. That
 * gives three things for the price of one table:
 *
 *   - "did it run last night, and did it work" is a query, not an archaeology
 *     exercise through container logs that rotated away.
 *   - the scheduler can catch up: on boot it looks at the last success and runs
 *     immediately if the machine was off when it was due.
 *   - a run that started and never finished is visible as a row with a
 *     `startedAt` and no `finishedAt`, which is exactly what a crash looks like.
 */
export const jobRuns = pgTable(
	"job_runs",
	{
		id: text("id").primaryKey(),
		/** Which job. `nightly` is the only scheduled one today. */
		name: text("name").notNull(),
		startedAt: timestamp("started_at").defaultNow().notNull(),
		/** Null while running, or forever if the process died mid-run. */
		finishedAt: timestamp("finished_at"),
		ok: boolean("ok"),
		/** A summary on success, the error message on failure. */
		detail: text("detail"),
	},
	(table) => [
		// "When did this job last succeed?" — the scheduler's catch-up question,
		// asked on every boot.
		index("job_runs_name_started_idx").on(table.name, table.startedAt),
	],
);
