/**
 * Removes abandoned drafts and the objects behind them (spec §6).
 *
 * A designer who starts an upload and walks away leaves a draft row and
 * possibly an R2 object. Neither is visible to anyone, but both cost storage
 * indefinitely, so anything untouched for a week is cleared out.
 *
 * Only `draft` is eligible. Rejected content is a designer's work in progress
 * and is theirs to resubmit or delete.
 */

import { db } from "@greetings/db";
import { content, downloadIdempotency } from "@greetings/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { type ObjectStorage, purgeContentObjects } from "../lib/storage";

export interface CleanupResult {
	draftsDeleted: number;
	objectsDeleted: number;
	objectsFailed: number;
}

export async function cleanupOrphanDrafts(
	storage: ObjectStorage,
	options: { olderThanDays?: number; now?: Date } = {},
): Promise<CleanupResult> {
	const olderThanDays = options.olderThanDays ?? 7;
	const cutoff = new Date(
		(options.now ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1000,
	);

	const stale = await db
		.select({ id: content.id })
		.from(content)
		.where(and(eq(content.status, "draft"), lt(content.updatedAt, cutoff)));

	if (stale.length === 0) {
		return { draftsDeleted: 0, objectsDeleted: 0, objectsFailed: 0 };
	}

	const ids = stale.map((row) => row.id);

	// Objects first: deleting the rows first would lose the keys, leaking the
	// objects forever. A failed delete here is retried on the next run, because
	// the row is only removed once its objects are gone.
	let objectsDeleted = 0;
	let objectsFailed = 0;
	const failedContent = new Set<string>();

	for (const contentId of ids) {
		// Listed from the bucket rather than read from content_assets. Every
		// upload starts with a presigned URL and only *some* end in a confirm
		// call — a designer who uploads and then closes the tab leaves an object
		// no row references. Working from the database would walk straight past
		// those and pay for them forever. The key prefix is what ties an object
		// to its draft, which is why it embeds the content id.
		const result = await purgeContentObjects(storage, contentId);
		objectsDeleted += result.deleted;
		objectsFailed += result.failed;

		// Keep the row when anything survived, so the keys are still findable
		// on the next run. Deleting it would strand them.
		if (result.failed > 0) failedContent.add(contentId);
	}

	const deletable = ids.filter((id) => !failedContent.has(id));
	if (deletable.length === 0) {
		return { draftsDeleted: 0, objectsDeleted, objectsFailed };
	}

	// content_assets cascades from content.
	const deleted = await db
		.delete(content)
		.where(inArray(content.id, deletable))
		.returning({ id: content.id });

	return { draftsDeleted: deleted.length, objectsDeleted, objectsFailed };
}

/**
 * Discards idempotency records that can no longer suppress anything.
 *
 * A row only matters inside the replay window (60 seconds). Keeping them
 * forever would grow the table by one row per download, which at this
 * product's expected volume is the fastest-growing table in the system after
 * the events themselves.
 *
 * Retained for an hour rather than exactly 60 seconds so the table doubles as
 * a short diagnostic trail when investigating a client's retry behaviour.
 */
export async function purgeExpiredIdempotencyKeys(
	options: { retainMinutes?: number; now?: Date } = {},
): Promise<{ purged: number }> {
	const retainMinutes = options.retainMinutes ?? 60;
	const cutoff = new Date(
		(options.now ?? new Date()).getTime() - retainMinutes * 60 * 1000,
	);

	const deleted = await db
		.delete(downloadIdempotency)
		.where(lt(downloadIdempotency.createdAt, cutoff))
		.returning({ id: downloadIdempotency.id });

	return { purged: deleted.length };
}
