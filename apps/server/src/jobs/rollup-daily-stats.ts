/**
 * Nightly aggregation of download events (spec §9).
 *
 * Analytics read `daily_content_stats` for every date before today and
 * aggregate raw events only for today, so a dashboard never scans the full
 * event history.
 *
 * Every run is idempotent: recomputing a date replaces its rows rather than
 * adding to them, so a re-run after a failure, a backfill of an old date, and
 * two overlapping runs all converge on the same numbers. That property is what
 * makes this safe to schedule and safe to trigger by hand at 2am.
 */

import { db } from "@greetings/db";
import { dailyContentStats } from "@greetings/db/schema";
import { eq, sql } from "drizzle-orm";

export interface RollupResult {
	statDate: string;
	rows: number;
}

/** Formats a Date as the YYYY-MM-DD the rollup is keyed by, in UTC. */
export function toStatDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** The day before `now` — what a nightly run recomputes. */
export function previousDay(now: Date = new Date()): string {
	return toStatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * Recomputes one day's statistics from the raw events.
 *
 * A single INSERT ... SELECT ... ON CONFLICT DO UPDATE: the aggregation runs
 * in the database, so no event rows cross the wire, and the conflict clause
 * makes the write idempotent without a delete-then-insert that would leave the
 * table briefly empty for that date.
 */
export async function rollupDay(statDate: string): Promise<RollupResult> {
	const result = await db.execute(sql`
		INSERT INTO daily_content_stats
			(stat_date, content_id, designer_id, region_code, downloads, unique_users, computed_at)
		SELECT
			${statDate}::date,
			de.content_id,
			de.designer_id,
			-- Downloads from users who never onboarded still have to be counted,
			-- and the primary key cannot contain a null.
			COALESCE(de.region_code, ''),
			COUNT(*)::int,
			COUNT(DISTINCT de.user_id)::int,
			now()
		FROM download_events de
		WHERE de.created_at >= ${statDate}::date
			AND de.created_at < ${statDate}::date + INTERVAL '1 day'
		GROUP BY de.content_id, de.designer_id, COALESCE(de.region_code, '')
		ON CONFLICT (stat_date, content_id, region_code) DO UPDATE SET
			downloads = EXCLUDED.downloads,
			unique_users = EXCLUDED.unique_users,
			designer_id = EXCLUDED.designer_id,
			computed_at = EXCLUDED.computed_at
	`);

	// A recomputation that finds no events for a date must clear any rows left
	// from a previous run, or deleted content would keep reporting downloads.
	await pruneStaleRows(statDate);

	return { statDate, rows: result.rowCount ?? 0 };
}

/**
 * Removes rollup rows for a date that no longer have matching events.
 *
 * The upsert above can only add or update. If events were deleted — a piece of
 * content removed, a user's data erased — the stale aggregate would survive
 * and the rollup would disagree with the events it claims to summarise.
 */
async function pruneStaleRows(statDate: string): Promise<void> {
	await db.execute(sql`
		DELETE FROM daily_content_stats s
		WHERE s.stat_date = ${statDate}::date
			AND NOT EXISTS (
				SELECT 1 FROM download_events de
				WHERE de.content_id = s.content_id
					AND COALESCE(de.region_code, '') = s.region_code
					AND de.created_at >= ${statDate}::date
					AND de.created_at < ${statDate}::date + INTERVAL '1 day'
			)
	`);
}

/**
 * Recomputes a range of days, oldest first.
 *
 * Used to backfill after downtime, or to repair a date whose events arrived
 * late.
 */
export async function rollupRange(
	fromDate: string,
	toDate: string,
): Promise<RollupResult[]> {
	const results: RollupResult[] = [];

	for (
		let cursor = new Date(`${fromDate}T00:00:00Z`);
		cursor <= new Date(`${toDate}T00:00:00Z`);
		cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
	) {
		results.push(await rollupDay(toStatDate(cursor)));
	}

	return results;
}

/** Discards rollup rows for a date, used by tests and manual repair. */
export async function clearDay(statDate: string): Promise<void> {
	await db
		.delete(dailyContentStats)
		.where(eq(dailyContentStats.statDate, statDate));
}
