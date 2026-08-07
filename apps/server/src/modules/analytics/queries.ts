/**
 * Analytics queries (spec §9).
 *
 * Every query reads pre-aggregated rows for dates before today and aggregates
 * raw events for today only. That keeps a dashboard off the full event history
 * while still showing downloads from a minute ago — designers check their
 * numbers after posting, and a figure that only moves overnight reads as
 * broken.
 *
 * `designerId` is never taken from a client. Callers pass the session's own id,
 * or null for platform-wide queries that only a super admin can reach.
 */

import { db } from "@greetings/db";
import { sql } from "drizzle-orm";

export interface AnalyticsScope {
	/** Restricts every figure to one designer; null means platform-wide. */
	designerId: string | null;
	from: string;
	to: string;
	/** Today in UTC — the boundary between rolled-up and live data. */
	today: string;
}

/**
 * The two halves of every figure, as one relation.
 *
 * Rolled-up rows for `from..min(to, today-1)`, plus live events for today when
 * the range includes it.
 */
function unifiedRows(scope: AnalyticsScope) {
	const designerFilterRollup = scope.designerId
		? sql`AND s.designer_id = ${scope.designerId}`
		: sql``;
	const designerFilterEvents = scope.designerId
		? sql`AND de.designer_id = ${scope.designerId}`
		: sql``;

	return sql`
		SELECT
			s.stat_date        AS day,
			s.content_id       AS content_id,
			s.designer_id      AS designer_id,
			s.region_code      AS region_code,
			s.downloads        AS downloads,
			s.unique_users     AS unique_users
		FROM daily_content_stats s
		WHERE s.stat_date >= ${scope.from}::date
			AND s.stat_date <= LEAST(${scope.to}::date, ${scope.today}::date - 1)
			${designerFilterRollup}

		UNION ALL

		SELECT
			${scope.today}::date,
			de.content_id,
			de.designer_id,
			COALESCE(de.region_code, ''),
			COUNT(*)::int,
			COUNT(DISTINCT de.user_id)::int
		FROM download_events de
		WHERE ${scope.today}::date BETWEEN ${scope.from}::date AND ${scope.to}::date
			AND de.created_at >= ${scope.today}::date
			AND de.created_at < ${scope.today}::date + INTERVAL '1 day'
			${designerFilterEvents}
		GROUP BY de.content_id, de.designer_id, COALESCE(de.region_code, '')
	`;
}

export async function summary(scope: AnalyticsScope) {
	const result = await db.execute(sql`
		WITH rows AS (${unifiedRows(scope)})
		SELECT
			COALESCE(SUM(downloads), 0)::int        AS "totalDownloads",
			COUNT(DISTINCT content_id)::int         AS "contentWithDownloads",
			COUNT(DISTINCT region_code)
				FILTER (WHERE region_code <> '')::int AS "regionsReached"
		FROM rows
	`);

	return (
		(result.rows[0] as
			| {
					totalDownloads: number;
					contentWithDownloads: number;
					regionsReached: number;
			  }
			| undefined) ?? {
			totalDownloads: 0,
			contentWithDownloads: 0,
			regionsReached: 0,
		}
	);
}

export async function byContent(scope: AnalyticsScope, limit: number) {
	const result = await db.execute(sql`
		WITH rows AS (${unifiedRows(scope)})
		SELECT
			r.content_id                       AS "contentId",
			c.title                            AS title,
			c.status                           AS status,
			SUM(r.downloads)::int              AS downloads
		FROM rows r
		JOIN content c ON c.id = r.content_id
		GROUP BY r.content_id, c.title, c.status
		ORDER BY downloads DESC, "contentId"
		LIMIT ${limit}
	`);

	return result.rows;
}

export async function byRegion(scope: AnalyticsScope) {
	const result = await db.execute(sql`
		WITH rows AS (${unifiedRows(scope)})
		SELECT
			r.region_code                AS "regionCode",
			reg.name                     AS "regionName",
			SUM(r.downloads)::int        AS downloads
		FROM rows r
		LEFT JOIN regions reg ON reg.code = r.region_code
		GROUP BY r.region_code, reg.name
		ORDER BY downloads DESC, "regionCode"
	`);

	return result.rows;
}

export async function timeseries(scope: AnalyticsScope) {
	const result = await db.execute(sql`
		WITH rows AS (${unifiedRows(scope)})
		SELECT
			to_char(day, 'YYYY-MM-DD')   AS date,
			SUM(downloads)::int          AS downloads
		FROM rows
		GROUP BY day
		ORDER BY day ASC
	`);

	return result.rows;
}

/** Platform-wide totals for super admins (spec §9). */
export async function platformOverview(scope: AnalyticsScope) {
	const result = await db.execute(sql`
		WITH rows AS (${unifiedRows(scope)})
		SELECT
			(SELECT COUNT(*)::int FROM "user")                                   AS "totalUsers",
			(SELECT COUNT(*)::int FROM "user" WHERE role = 'designer')           AS "totalDesigners",
			(SELECT COUNT(*)::int FROM content WHERE status = 'published')       AS "publishedContent",
			(SELECT COUNT(*)::int FROM content WHERE status = 'pending_review')  AS "awaitingReview",
			(SELECT COUNT(*)::int FROM reports WHERE status = 'open')            AS "openReports",
			(SELECT COALESCE(SUM(downloads), 0)::int FROM rows)                  AS "downloadsInRange"
	`);

	return result.rows[0];
}

/** Per-designer performance, super admin only. */
export async function byDesigner(scope: AnalyticsScope, limit: number) {
	const result = await db.execute(sql`
		WITH rows AS (${unifiedRows(scope)})
		SELECT
			r.designer_id                    AS "designerId",
			u.name                           AS "designerName",
			SUM(r.downloads)::int            AS downloads,
			COUNT(DISTINCT r.content_id)::int AS "contentWithDownloads"
		FROM rows r
		JOIN "user" u ON u.id = r.designer_id
		GROUP BY r.designer_id, u.name
		ORDER BY downloads DESC, "designerId"
		LIMIT ${limit}
	`);

	return result.rows;
}
