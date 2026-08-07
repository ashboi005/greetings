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
import { content, contentAssets } from "@greetings/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { ObjectStorage } from "../lib/storage";

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

	const assets = await db
		.select({ storageKey: contentAssets.storageKey })
		.from(contentAssets)
		.where(inArray(contentAssets.contentId, ids));

	// Objects first: deleting the rows first would lose the keys, leaking the
	// objects forever. A failed delete here is retried on the next run, because
	// the row is only removed once its objects are gone.
	let objectsDeleted = 0;
	let objectsFailed = 0;
	const failedContent = new Set<string>();

	for (const asset of assets) {
		try {
			await storage.delete(asset.storageKey);
			objectsDeleted++;
		} catch (cause) {
			objectsFailed++;
			console.warn(`Failed to delete object ${asset.storageKey}:`, cause);
			// Key format is content/<contentId>/<uuid>.<ext>
			const contentId = asset.storageKey.split("/")[1];
			if (contentId) failedContent.add(contentId);
		}
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
