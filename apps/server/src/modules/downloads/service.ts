/**
 * Tracked downloads (spec §8).
 *
 * This is the only route to image bytes. Objects are not publicly reachable,
 * so every download passes through here — which is what makes the counts
 * trustworthy rather than an undercount, and those counts are what designers
 * are measured on.
 */

import { db } from "@greetings/db";
import {
	content,
	contentAssets,
	type DownloadSource,
	downloadEvents,
	downloadIdempotency,
	userProfiles,
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

	const [asset] = await db
		.select({ storageKey: contentAssets.storageKey })
		.from(contentAssets)
		.where(eq(contentAssets.contentId, input.contentId))
		.orderBy(contentAssets.createdAt)
		.limit(1);

	if (!asset) throw notFound("This content has no image.");

	const url = input.storage.presignDownload({
		key: asset.storageKey,
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

	// Region comes from the profile, frozen onto the event, so analytics stay
	// correct if the user later moves.
	const [profile] = await db
		.select({ regionCode: userProfiles.regionCode })
		.from(userProfiles)
		.where(eq(userProfiles.userId, input.userId))
		.limit(1);

	await db.transaction(async (tx) => {
		await tx.insert(downloadEvents).values({
			contentId: input.contentId,
			designerId: item.designerId,
			userId: input.userId,
			regionCode: profile?.regionCode ?? null,
			// The language of what was downloaded, not of the user — a user may
			// prefer several, and the useful question is which content travels.
			languageCode: item.primaryLanguage,
			source: input.source,
		});

		// Incremented in SQL rather than read-modify-write, so concurrent
		// downloads cannot lose an increment.
		await tx
			.update(content)
			.set({ downloadCount: sql`${content.downloadCount} + 1` })
			.where(eq(content.id, input.contentId));
	});

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
