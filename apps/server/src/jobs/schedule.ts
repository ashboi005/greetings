/**
 * Running the nightly job on a schedule (spec §12.5).
 *
 * Three things this is deliberately not:
 *
 * **Not `sleep 86400` in a loop.** That drifts — each run's duration is added
 * to the next wait — and it resets on every deploy, so "nightly at 2am" quietly
 * becomes "whenever the container last restarted". The next occurrence of a
 * wall-clock time is computed instead, so a restart at 23:00 still fires at
 * 02:30 and not at 23:00 the following night.
 *
 * **Not a timer inside the API server.** The job rewrites every published row;
 * running a copy per web instance is waste at best and lock contention at
 * worst, and it ties the schedule to how the API happens to be scaled.
 *
 * **Not a cron entry on the host.** That works, and if you would rather use one
 * it is a supported option (see the README) — but it lives outside the repo,
 * outside the image, and outside review, which is how a schedule silently
 * differs between two environments.
 *
 * What it is: one long-lived process, in the same image as the server, holding
 * a database lock while it works and recording what it did.
 */

import { db } from "@greetings/db";
import { jobRuns } from "@greetings/db/schema";
import { env } from "@greetings/env/server";
import { and, desc, eq, gte, sql } from "drizzle-orm";

/** How long after the due time a missed run is still worth catching up. */
const CATCH_UP_WINDOW_HOURS = 20;

/**
 * A lock key for `pg_try_advisory_lock`, which takes a bigint rather than a
 * name. Any stable arbitrary number will do; this one is "greetings nightly".
 */
const NIGHTLY_LOCK_KEY = 776_2025_01n;

export interface ScheduleTime {
	hour: number;
	minute: number;
}

/**
 * Parses `HH:MM`, rejecting anything that would silently mean midnight.
 *
 * A typo in a schedule is not the kind of thing that should be discovered by
 * noticing the job ran at an odd hour for a month.
 */
export function parseScheduleTime(value: string): ScheduleTime {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match?.[1] || !match[2]) {
		throw new Error(
			`JOBS_SCHEDULE_UTC must look like "02:30", got "${value}".`,
		);
	}

	const hour = Number(match[1]);
	const minute = Number(match[2]);

	if (hour > 23 || minute > 59) {
		throw new Error(`JOBS_SCHEDULE_UTC is not a real time: "${value}".`);
	}

	return { hour, minute };
}

/**
 * The next time the job is due, strictly after `from`.
 *
 * UTC throughout, matching the rest of the system: every timestamp column is
 * `timestamp without time zone`, the analytics rollup buckets by UTC calendar
 * day, and connections pin `timezone=UTC`. A schedule in local time would drift
 * against the day boundaries it exists to compute.
 */
export function nextRunAt(at: ScheduleTime, from: Date = new Date()): Date {
	const next = new Date(from);
	next.setUTCHours(at.hour, at.minute, 0, 0);
	// `setUTCHours` on a time already past today rolls backwards, so push a day.
	if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
	return next;
}

/**
 * Whether a run is owed right now because the machine was not running when it
 * was due.
 *
 * Bounded by a window, so a container that has been off for a month does not
 * come up and immediately do a month of nothing useful — the rollup is
 * recomputed from raw events either way, and a manual backfill is the right
 * tool for a long outage.
 */
export async function isCatchUpDue(
	name: string,
	now: Date = new Date(),
): Promise<boolean> {
	const since = new Date(now.getTime() - CATCH_UP_WINDOW_HOURS * 3600 * 1000);

	const [recent] = await db
		.select({ id: jobRuns.id })
		.from(jobRuns)
		.where(
			and(
				eq(jobRuns.name, name),
				eq(jobRuns.ok, true),
				gte(jobRuns.startedAt, since),
			),
		)
		.orderBy(desc(jobRuns.startedAt))
		.limit(1);

	return !recent;
}

export interface RunRecord {
	ok: boolean;
	detail: string;
}

/**
 * Runs a job under a lock, recording the attempt either way.
 *
 * The lock is a Postgres session advisory lock, so it is released when the
 * connection closes — including when the process is killed, which a lock held
 * in a table would not be. Two schedulers, or a run overrunning into the next
 * window, therefore cannot overlap: the second one finds the lock held and
 * skips rather than queueing behind work that is already being done.
 */
export async function runLocked(
	name: string,
	work: () => Promise<string>,
): Promise<{ ran: boolean; record?: RunRecord }> {
	// A dedicated connection: an advisory lock belongs to the session that took
	// it, and a pooled query would take it on whichever connection was free and
	// then hand that connection back still holding it.
	const client = await db.$client.connect();

	try {
		const locked = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS acquired",
			[NIGHTLY_LOCK_KEY.toString()],
		);

		if (!locked.rows[0]?.acquired) {
			console.log(`Skipping ${name}: another run holds the lock.`);
			return { ran: false };
		}

		const id = crypto.randomUUID();
		await db.insert(jobRuns).values({ id, name, startedAt: new Date() });

		try {
			const detail = await work();
			await db
				.update(jobRuns)
				.set({ finishedAt: new Date(), ok: true, detail })
				.where(eq(jobRuns.id, id));
			return { ran: true, record: { ok: true, detail } };
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			// Recorded before rethrowing: a failure nobody can see afterwards is
			// the thing this table exists to prevent.
			await db
				.update(jobRuns)
				.set({ finishedAt: new Date(), ok: false, detail })
				.where(eq(jobRuns.id, id));
			throw cause;
		}
	} finally {
		// Releasing explicitly rather than relying on the connection closing, so
		// the next run is not blocked by a pooled connection lingering.
		await client
			.query("SELECT pg_advisory_unlock($1)", [NIGHTLY_LOCK_KEY.toString()])
			.catch(() => {});
		client.release();
	}
}

/** Prunes run records that are no longer telling anyone anything. */
export async function pruneJobRuns(
	retainDays = 90,
): Promise<{ purged: number }> {
	const cutoff = new Date(Date.now() - retainDays * 24 * 3600 * 1000);
	const deleted = await db
		.delete(jobRuns)
		.where(sql`${jobRuns.startedAt} < ${cutoff}`)
		.returning({ id: jobRuns.id });
	return { purged: deleted.length };
}

/**
 * The scheduler loop.
 *
 * Resolves when `signal` aborts, so SIGTERM stops it between runs rather than
 * mid-write.
 */
export async function runSchedule(
	work: () => Promise<string>,
	options: { signal: AbortSignal; name?: string } = {
		signal: new AbortController().signal,
	},
): Promise<void> {
	const name = options.name ?? "nightly";
	const at = parseScheduleTime(env.JOBS_SCHEDULE_UTC);

	console.log(
		`Scheduler started: ${name} runs daily at ${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")} UTC`,
	);

	// A missed window is made up on boot. A machine that was off overnight
	// otherwise leaves a permanent hole in the analytics, because the rollup
	// only ever recomputes the day it is asked for.
	if (await isCatchUpDue(name)) {
		console.log(
			`No successful ${name} in the last ${CATCH_UP_WINDOW_HOURS}h — running now.`,
		);
		await attempt(name, work);
	}

	while (!options.signal.aborted) {
		const due = nextRunAt(at);
		const waitMs = due.getTime() - Date.now();
		console.log(`Next ${name} run at ${due.toISOString()}`);

		if (!(await sleep(waitMs, options.signal))) return;

		await attempt(name, work);
	}
}

/** Runs once, letting a failure be logged rather than end the scheduler. */
async function attempt(name: string, work: () => Promise<string>) {
	try {
		const result = await runLocked(name, work);
		if (result.ran) console.log(`${name} finished: ${result.record?.detail}`);
	} catch (cause) {
		// Deliberately swallowed. A scheduler that exits on the first bad night
		// turns one failed run into every subsequent run failing too, and the
		// failure is already recorded in job_runs for anyone looking.
		console.error(`${name} failed:`, cause);
	}
}

/** Sleeps, or returns false if aborted first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);

	return new Promise((resolve) => {
		const timer = setTimeout(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
				// `setTimeout` caps at ~24.9 days; a daily schedule is well inside it.
			},
			Math.max(ms, 0),
		);

		function onAbort() {
			clearTimeout(timer);
			resolve(false);
		}

		signal.addEventListener("abort", onAbort, { once: true });
	});
}
