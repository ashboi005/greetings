/**
 * The feed's stored ranking score (spec §7).
 *
 * This lives in the database package rather than the server because it is a
 * property of a column: `content.base_score` is written by the API, by the
 * nightly job and by the demo seed, and three copies of the formula would agree
 * right up until someone changed one of them.
 *
 * Only the viewer-independent half is here. The language and region weights are
 * added at query time, where they depend on who is asking.
 */

import { type SQL, sql } from "drizzle-orm";
import { db } from "./index";

/** How long it takes a piece of content to lose half its recency advantage. */
export const RECENCY_HALF_LIFE_DAYS = 7;

/** How far back the popularity term looks. */
export const POPULARITY_WINDOW_DAYS = 7;

/** Weight on log-scaled recent downloads. */
export const WEIGHT_POPULARITY = 0.5;

/** The popularity window as a SQL interval. */
export const popularityWindow = sql`(${sql.raw(String(POPULARITY_WINDOW_DAYS))} || ' days')::interval`;

/**
 * Recency decay plus popularity, in terms of a publication time and a count.
 *
 * Log-scaled popularity so a runaway hit does not flatten everything else: the
 * difference between ten downloads and a hundred matters, between a thousand
 * and ten thousand much less.
 */
export function baseScoreExpression(
	publishedAt: SQL,
	recentDownloads: SQL,
): SQL {
	return sql`
		POWER(
			0.5,
			GREATEST(EXTRACT(EPOCH FROM (now() - ${publishedAt})), 0)
				/ (${sql.raw(String(RECENCY_HALF_LIFE_DAYS))} * 86400)
		)
		+ ${sql.raw(String(WEIGHT_POPULARITY))} * LN(1 + ${recentDownloads})
	`;
}

/**
 * The score after one more download, for use inside the download's own update.
 *
 * Reads `recent_downloads + 1` rather than re-counting the events table: the
 * row being updated already holds the count, and counting again would put the
 * per-request aggregation back that this design exists to remove.
 */
export const bumpedBaseScore = baseScoreExpression(
	sql`published_at`,
	sql`recent_downloads + 1`,
);

/**
 * Scores one item, reading its own download history.
 *
 * Called inside the transaction that publishes or restores something, so an
 * item is never briefly live with a score of zero — which would bury it at the
 * bottom of every feed until the next nightly run.
 */
export async function scoreOne(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction type is not nameable here
	tx: any,
	contentId: string,
): Promise<void> {
	await tx.execute(sql`
		UPDATE content c
		SET recent_downloads = d.n,
		    base_score = ${baseScoreExpression(sql`c.published_at`, sql`d.n`)}
		FROM (
			SELECT COUNT(*)::int AS n
			FROM download_events
			WHERE content_id = ${contentId}
				AND created_at > now() - ${popularityWindow}
		) d
		WHERE c.id = ${contentId} AND c.published_at IS NOT NULL
	`);
}

/**
 * Recomputes every published item's score.
 *
 * One statement: the aggregation and the update both run in the database, so no
 * rows cross the wire. Idempotent, like every other job here — running it twice
 * produces the same numbers as running it once.
 *
 * Downloads bump the score as they happen, so this is not what keeps popularity
 * current. What it does is the part an increment cannot: retire downloads that
 * have aged out of the window, and re-apply recency decay.
 */
export async function refreshFeedScores(): Promise<{ rows: number }> {
	return db.transaction(async (tx) => {
		// The pool sets a statement timeout sized for a web request, which is the
		// right ceiling for anything a user is waiting on and the wrong one for a
		// batch that rewrites every published row. Raised for this transaction
		// only — `LOCAL` means it reverts when the transaction ends, so the
		// connection goes back to the pool with the request-path limit intact.
		// set_config rather than SET LOCAL: SET takes no bind parameters, and the
		// `true` argument is what makes it transaction-local.
		await tx.execute(
			sql`SELECT set_config('statement_timeout', ${BATCH_TIMEOUT}, true)`,
		);

		return runRefresh(tx);
	});
}

/** How long a batch job's statements may run. */
const BATCH_TIMEOUT = "10min";

// biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction type is not nameable here
async function runRefresh(tx: any): Promise<{ rows: number }> {
	const result = await tx.execute(sql`
		UPDATE content c
		SET recent_downloads = d.n,
		    base_score = ${baseScoreExpression(sql`c.published_at`, sql`d.n`)}
		FROM (
			SELECT
				pub.id,
				COALESCE(recent.n, 0) AS n
			FROM content pub
			LEFT JOIN (
				SELECT content_id, COUNT(*)::int AS n
				FROM download_events
				WHERE created_at > now() - ${popularityWindow}
				GROUP BY content_id
			) recent ON recent.content_id = pub.id
			WHERE pub.status = 'published' AND pub.published_at IS NOT NULL
		) d
		WHERE c.id = d.id
	`);

	return { rows: result.rowCount ?? 0 };
}
