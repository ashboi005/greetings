/**
 * Tracked downloads (spec §8).
 *
 * This is the only route to image bytes. Objects are not publicly reachable,
 * so every download passes through here — which is what makes the counts
 * trustworthy rather than an undercount, and those counts are what designers
 * are measured on.
 */

import { db } from "@greetings/db";
import { bumpedBaseScore } from "@greetings/db/feed-score";
import {
	content,
	type DownloadSource,
	downloadIdempotency,
} from "@greetings/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { conflict, notFound } from "../../lib/errors";
import type { ObjectStorage } from "../../lib/storage";

/** How long a signed download URL stays valid. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * How long a repeated Idempotency-Key is treated as a retry rather than a new
 * download. Long enough to cover a mobile client's retry backoff, short enough
 * that a genuine second download minutes later is still counted.
 */
export const IDEMPOTENCY_WINDOW_SECONDS = 60;

export interface DownloadResult {
	url: string;
	expiresInSeconds: number;
	/** False when an Idempotency-Key replay returned a stored URL. */
	recorded: boolean;
}

export async function recordDownload(input: {
	contentId: string;
	userId: string;
	source: DownloadSource;
	idempotencyKey?: string;
	storage: ObjectStorage;
}): Promise<DownloadResult> {
	const [item] = await db
		.select({
			id: content.id,
			designerId: content.designerId,
			status: content.status,
			visibilityHold: content.visibilityHold,
			primaryLanguage: content.primaryLanguage,
			// The same key the feed showed. Reading it from here rather than
			// looking up content_assets separately is one fewer query on the
			// busiest write path, and — more importantly — makes it impossible
			// for the tile someone tapped and the file they receive to be
			// different images.
			storageKey: content.primaryAssetKey,
		})
		.from(content)
		.where(eq(content.id, input.contentId))
		.limit(1);

	if (!item) throw notFound("No such content.");

	// A removed or held item must not be downloadable even by someone holding
	// its id from a feed fetched moments earlier.
	if (item.status !== "published" || item.visibilityHold) {
		throw conflict("This content is not available for download.", {
			status: item.status,
		});
	}

	if (!item.storageKey) throw notFound("This content has no image.");

	const url = input.storage.presignDownload({
		key: item.storageKey,
		expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
	});

	// Claiming the key, recording the event and moving the counters are one
	// statement.
	//
	// They used to be two. The claim committed first, so a failure in the second
	// left a key that suppresses retries for a download that was never recorded:
	// the client is handed a URL and told `recorded: false`, and the designer is
	// never paid for it. A data-modifying CTE runs in one implicit transaction,
	// so either all of it happens or none of it does — and it still costs one
	// round trip on the busiest write in the product.
	//
	// `claimed` is the gate. When the key is new, or old enough to have aged out
	// of the replay window, the upsert returns a row and the two writes below it
	// proceed. When it is a live replay the upsert returns nothing, the EXISTS
	// guards are false, and neither write happens.
	//
	// The region is read inside the insert rather than fetched first. It is
	// frozen onto the event on purpose, so analytics stay correct when someone
	// later moves house; the LEFT JOIN keeps that true for a user who has not
	// onboarded, whose region is simply null.
	//
	// The counter is incremented in SQL rather than read-modify-write, so
	// concurrent downloads cannot lose one. The ranking score is bumped in the
	// same update: it could have been left to the nightly pass, but that would
	// mean a post taking off this morning is not ranked as popular until
	// tomorrow, and folding it in costs nothing — it is the same single row.
	const claimGate = input.idempotencyKey
		? sql`
			claimed AS (
				INSERT INTO download_idempotency (id, user_id, key, content_id, signed_url)
				VALUES (
					${crypto.randomUUID()},
					${input.userId},
					${input.idempotencyKey},
					${input.contentId},
					${url}
				)
				ON CONFLICT (user_id, key) DO UPDATE SET
					content_id = EXCLUDED.content_id,
					signed_url = EXCLUDED.signed_url,
					created_at = now()
				WHERE download_idempotency.created_at
					< now() - (${IDEMPOTENCY_WINDOW_SECONDS} || ' seconds')::interval
				RETURNING id
			),
		`
		: sql``;

	const gate = input.idempotencyKey
		? sql`WHERE EXISTS (SELECT 1 FROM claimed)`
		: sql``;
	const updateGate = input.idempotencyKey
		? sql`AND EXISTS (SELECT 1 FROM claimed)`
		: sql``;

	const result = await db.execute(sql`
		WITH ${claimGate}
		recorded AS (
			INSERT INTO download_events
				(content_id, designer_id, user_id, region_code, language_code, source)
			SELECT
				${input.contentId},
				${item.designerId},
				${input.userId},
				p.region_code,
				-- The language of what was downloaded, not of the user: a user may
				-- prefer several, and the useful question is which content travels.
				${item.primaryLanguage},
				${input.source}::download_source
			FROM (SELECT ${input.userId}::text AS uid) me
			LEFT JOIN user_profiles p ON p.user_id = me.uid
			${gate}
		)
		UPDATE content SET
			download_count   = download_count + 1,
			recent_downloads = recent_downloads + 1,
			base_score       = ${bumpedBaseScore}
		WHERE id = ${input.contentId}
			${updateGate}
		RETURNING id
	`);

	if (result.rows.length > 0) {
		return { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, recorded: true };
	}

	// Nothing was written, so this is a replay inside the window. Read back what
	// the first attempt stored and hand over exactly that.
	return replayDownload(input);
}

/**
 * Answers a repeated Idempotency-Key with the original result.
 *
 * Rejects the key being reused for *different* content. That is not a retry, it
 * is a client bug — and the old behaviour was to silently return the first
 * image's URL, so a user who asked for one picture received another and the
 * download went uncounted. A loud 409 is the only answer that cannot be
 * mistaken for success.
 */
async function replayDownload(input: {
	contentId: string;
	userId: string;
	idempotencyKey?: string;
}): Promise<DownloadResult> {
	const [stored] = await db
		.select({
			contentId: downloadIdempotency.contentId,
			signedUrl: downloadIdempotency.signedUrl,
		})
		.from(downloadIdempotency)
		.where(
			and(
				eq(downloadIdempotency.userId, input.userId),
				eq(downloadIdempotency.key, input.idempotencyKey ?? ""),
			),
		)
		.limit(1);

	// Nothing stored means the update matched no row for another reason — the
	// content vanished between the read above and this write. Say so rather than
	// inventing a success.
	if (!stored) throw notFound("No such content.");

	if (stored.contentId !== input.contentId) {
		throw conflict(
			"This Idempotency-Key was already used for different content. Use a new key for each download.",
			{ claimedFor: stored.contentId },
		);
	}

	return {
		url: stored.signedUrl,
		expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
		recorded: false,
	};
}
