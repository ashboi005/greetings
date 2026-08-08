/**
 * The scheduler (spec §12.5).
 *
 * A scheduled job has a failure mode ordinary tests miss: not running, or
 * running twice. Both are asserted here.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { jobRuns } from "@greetings/db/schema";
import { desc, eq } from "drizzle-orm";
import {
	isCatchUpDue,
	nextRunAt,
	parseScheduleTime,
	pruneJobRuns,
	runLocked,
} from "../src/jobs/schedule";
import { testDb, truncateAll } from "./db";

beforeEach(async () => {
	await truncateAll();
});

describe("parsing the schedule", () => {
	test("accepts a time", () => {
		expect(parseScheduleTime("02:30")).toEqual({ hour: 2, minute: 30 });
		expect(parseScheduleTime("2:05")).toEqual({ hour: 2, minute: 5 });
		expect(parseScheduleTime("23:59")).toEqual({ hour: 23, minute: 59 });
	});

	test("refuses anything that would silently mean midnight", () => {
		// A typo here would otherwise be discovered by noticing the job has been
		// running at an odd hour for a month.
		for (const bad of ["", "midnight", "25:00", "02:70", "0230", "2:5"]) {
			expect(() => parseScheduleTime(bad)).toThrow();
		}
	});
});

describe("the next run time", () => {
	const at = { hour: 2, minute: 30 };

	test("is later today when the time has not passed", () => {
		const now = new Date("2026-08-08T01:00:00Z");
		expect(nextRunAt(at, now).toISOString()).toBe("2026-08-08T02:30:00.000Z");
	});

	test("is tomorrow when it has", () => {
		const now = new Date("2026-08-08T03:00:00Z");
		expect(nextRunAt(at, now).toISOString()).toBe("2026-08-09T02:30:00.000Z");
	});

	test("is tomorrow when it is exactly now", () => {
		// Strictly after, or a run finishing inside its own minute would fire
		// again immediately.
		const now = new Date("2026-08-08T02:30:00Z");
		expect(nextRunAt(at, now).toISOString()).toBe("2026-08-09T02:30:00.000Z");
	});

	test("does not drift with how long a run took", () => {
		// The bug in `sleep(86400)`: each run's duration is added to the next
		// wait, so "nightly at 2:30" slides later every day.
		let now = new Date("2026-08-08T02:29:59Z");
		const fired: string[] = [];

		for (let day = 0; day < 5; day++) {
			const due = nextRunAt(at, now);
			fired.push(due.toISOString().slice(11, 19));
			// Pretend the run took eleven minutes.
			now = new Date(due.getTime() + 11 * 60 * 1000);
		}

		expect(new Set(fired)).toEqual(new Set(["02:30:00"]));
	});

	test("survives a restart at an awkward hour", () => {
		// Restarting at 23:00 must not move the schedule to 23:00.
		const now = new Date("2026-08-08T23:00:00Z");
		expect(nextRunAt(at, now).toISOString()).toBe("2026-08-09T02:30:00.000Z");
	});
});

describe("catching up after downtime", () => {
	test("is due when nothing has succeeded recently", async () => {
		expect(await isCatchUpDue("nightly")).toBe(true);
	});

	test("is not due when a run succeeded within the window", async () => {
		await runLocked("nightly", async () => "done");
		expect(await isCatchUpDue("nightly")).toBe(false);
	});

	test("is still due when the only recent run failed", async () => {
		await expect(
			runLocked("nightly", async () => {
				throw new Error("database went away");
			}),
		).rejects.toThrow("database went away");

		// A failed run is not a run. Treating it as one would mean a single bad
		// night quietly skips the catch-up that would have fixed it.
		expect(await isCatchUpDue("nightly")).toBe(true);
	});

	test("is due again once the last success ages out", async () => {
		await runLocked("nightly", async () => "done");

		await testDb
			.update(jobRuns)
			.set({ startedAt: new Date(Date.now() - 30 * 3600 * 1000) })
			.where(eq(jobRuns.name, "nightly"));

		expect(await isCatchUpDue("nightly")).toBe(true);
	});
});

describe("the run record", () => {
	test("records what a successful run did", async () => {
		await runLocked("nightly", async () => "rolled up 2026-08-07 (3 rows)");

		const [row] = await testDb
			.select()
			.from(jobRuns)
			.orderBy(desc(jobRuns.startedAt))
			.limit(1);

		expect(row?.ok).toBe(true);
		expect(row?.detail).toBe("rolled up 2026-08-07 (3 rows)");
		expect(row?.finishedAt).not.toBeNull();
	});

	test("records a failure before letting it propagate", async () => {
		await expect(
			runLocked("nightly", async () => {
				throw new Error("R2 unreachable");
			}),
		).rejects.toThrow();

		const [row] = await testDb
			.select()
			.from(jobRuns)
			.orderBy(desc(jobRuns.startedAt))
			.limit(1);

		// The whole point of the table: a job that failed at 2am is visible at
		// 9am without going looking through container logs that have rotated.
		expect(row?.ok).toBe(false);
		expect(row?.detail).toContain("R2 unreachable");
	});

	test("is pruned once it is old enough to tell nobody anything", async () => {
		await runLocked("nightly", async () => "old");
		await testDb
			.update(jobRuns)
			.set({ startedAt: new Date(Date.now() - 200 * 24 * 3600 * 1000) });

		expect((await pruneJobRuns()).purged).toBe(1);
		expect(await testDb.select().from(jobRuns)).toHaveLength(0);
	});
});

describe("the lock", () => {
	test("stops a second run starting while one is in flight", async () => {
		let started = 0;
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		const first = runLocked("nightly", async () => {
			started++;
			await held;
			return "first";
		});

		// Give the first run time to take the lock.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const second = await runLocked("nightly", async () => {
			started++;
			return "second";
		});

		release?.();
		await first;

		// A rescore rewrites every published row. Two at once is waste at best
		// and lock contention at worst, so the loser skips rather than queues.
		expect(second.ran).toBe(false);
		expect(started).toBe(1);
	});

	test("releases the lock so the next run can take it", async () => {
		await runLocked("nightly", async () => "first");
		const second = await runLocked("nightly", async () => "second");

		// A lock that leaked would make every subsequent night a no-op — a
		// failure that looks exactly like the scheduler working fine.
		expect(second.ran).toBe(true);
	});

	test("releases the lock even when the work throws", async () => {
		await expect(
			runLocked("nightly", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow();

		const after = await runLocked("nightly", async () => "recovered");
		expect(after.ran).toBe(true);
	});
});
