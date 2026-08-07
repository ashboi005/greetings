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
export const WEIGHT_POPULARITY = 0.5;
export const RECENCY_HALF_LIFE_DAYS = 7;
export const POPULARITY_WINDOW_DAYS = 7;

/** Seconds per bucket. See `currentBucket`. */
const BUCKET_SECONDS = 3600;

/**
 * Quantises "now" to the top of the hour.
 *
 * Score depends on the current time through recency decay, so a cursor issued
 * one second ago would rank against a slightly different clock and pages would
 * drift — items sliding across the boundary get skipped or repeated. Freezing
 * the reference time to the hour makes the ordering deterministic for the life
 * of a paging session, and the cursor carries the bucket so later pages score
 * against exactly the same clock as the first.
 */
export function currentBucket(now: Date = new Date()): number {
	return Math.floor(now.getTime() / 1000 / BUCKET_SECONDS);
}

export function bucketToDate(bucket: number): Date {
	return new Date(bucket * BUCKET_SECONDS * 1000);
}

export interface FeedCursor {
	bucket: number;
	score: number;
	id: string;
}

export function encodeFeedCursor(cursor: FeedCursor): string {
	return encodeCursor({ b: cursor.bucket, s: cursor.score, i: cursor.id });
}

export function decodeFeedCursor(raw: string): FeedCursor {
	const parsed = decodeCursor(raw);

	const bucket = parsed.b;
	const score = parsed.s;
	const id = parsed.i;

	if (
		typeof bucket !== "number" ||
		!Number.isFinite(bucket) ||
		typeof score !== "number" ||
		!Number.isFinite(score) ||
		typeof id !== "string" ||
		id.length === 0
	) {
		throw badRequest("Malformed cursor");
	}

	return { bucket, score, id };
}
