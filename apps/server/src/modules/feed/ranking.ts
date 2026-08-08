/**
 * Feed ranking (spec §7).
 *
 *   score = 2.0 × (content language ∈ user's languages)
 *         + 1.5 × (content region = user's region)
 *         + 1.0 × (content region IS NULL)      -- global content
 *         + recency_decay(published_at, half-life 7d)
 *         + 0.5 × ln(1 + downloads in last 7 days)
 *
 * The global-content term is what guarantees a user in an underserved region
 * never sees an empty feed: every global item scores at least 1.0 plus its
 * recency, so there is always something to rank.
 */

import { badRequest } from "../../lib/errors";
import { decodeCursor, encodeCursor } from "../../lib/pagination";

export const WEIGHT_LANGUAGE = 2.0;
export const WEIGHT_REGION = 1.5;
export const WEIGHT_GLOBAL = 1.0;

// The recency and popularity weights live with the column they are written
// into, because the API, the nightly job and the demo seed all write it and
// three copies of a formula agree only until someone edits one.
export {
	POPULARITY_WINDOW_DAYS,
	RECENCY_HALF_LIFE_DAYS,
	WEIGHT_POPULARITY,
} from "@greetings/db/feed-score";

/**
 * The cursor is just a position in the ranking.
 *
 * It used to carry an hour-quantised clock as well. That existed because the
 * score was computed from `now()` on every request, so two pages of one paging
 * session ranked against slightly different clocks and items could slide across
 * the boundary — skipped or repeated. The score is now stored on the row and
 * refreshed nightly, so within a paging session the ordering simply does not
 * move, and there is no clock to pin.
 */
export interface FeedCursor {
	score: number;
	id: string;
}

export function encodeFeedCursor(cursor: FeedCursor): string {
	return encodeCursor({ s: cursor.score, i: cursor.id });
}

export function decodeFeedCursor(raw: string): FeedCursor {
	const parsed = decodeCursor(raw);

	const score = parsed.s;
	const id = parsed.i;

	if (
		typeof score !== "number" ||
		!Number.isFinite(score) ||
		typeof id !== "string" ||
		id.length === 0
	) {
		throw badRequest("Malformed cursor");
	}

	return { score, id };
}
