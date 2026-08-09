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
import { eq, sql } from "drizzle-orm";
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

	if (input.idempotencyKey) {
		const claim = await claimIdempotencyKey({
			userId: input.userId,
			key: input.idempotencyKey,
			contentId: input.contentId,
			url,
		});

		if (!claim.fresh) {
			// A retry. Return exactly what the first attempt returned, and record
			// nothing — the whole point of the key.
			return {
				url: claim.storedUrl,
				expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
				recorded: false,
			};
		}
	}

	// The event and the counters, in one statement.
	//
	// This was a profile lookup, then BEGIN, an insert, an update and COMMIT —
	// five round trips on the single most frequent write in the product. A
	// data-modifying CTE runs in one implicit transaction, so it is exactly as
	// atomic and costs one.
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
	await db.execute(sql`
		WITH recorded AS (
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
		)
		UPDATE content SET
			download_count   = download_count + 1,
			recent_downloads = recent_downloads + 1,
			base_score       = ${bumpedBaseScore}
		WHERE id = ${input.contentId}
	`);

	return { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, recorded: true };
}

/**
 * Claims an idempotency key, or reports that it was already used.
 *
 * A single statement, because two retries can arrive concurrently: the upsert
 * refreshes the row only when the stored one has aged out of the window, and
 * returns nothing when it has not. "No rows returned" is therefore an exact
 * answer to "someone else already claimed this", with no read-then-write race.
 */
async function claimIdempotencyKey(input: {
	userId: string;
	key: string;
	contentId: string;
	url: string;
}): Promise<{ fresh: true } | { fresh: false; storedUrl: string }> {
	const claimed = await db
		.insert(downloadIdempotency)
		.values({
			id: crypto.randomUUID(),
			userId: input.userId,
			key: input.key,
			contentId: input.contentId,
			signedUrl: input.url,
		})
		.onConflictDoUpdate({
			target: [downloadIdempotency.userId, downloadIdempotency.key],
			set: {
				contentId: input.contentId,
				signedUrl: input.url,
				createdAt: new Date(),
			},
			setWhere: sql`${downloadIdempotency.createdAt} < now() - (${IDEMPOTENCY_WINDOW_SECONDS} || ' seconds')::interval`,
		})
		.returning({ id: downloadIdempotency.id });

	if (claimed.length > 0) return { fresh: true };

	const [existing] = await db
		.select({ signedUrl: downloadIdempotency.signedUrl })
		.from(downloadIdempotency)
		.where(
			sql`${downloadIdempotency.userId} = ${input.userId} AND ${downloadIdempotency.key} = ${input.key}`,
		)
		.limit(1);

	// The row must exist: nothing deletes it inside the window.
	return { fresh: false, storedUrl: existing?.signedUrl ?? input.url };
}
