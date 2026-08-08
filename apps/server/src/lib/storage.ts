/**
 * Object storage for content images (spec §6).
 *
 * A port, so nothing under test reaches Cloudflare. The backend never handles
 * image bytes: designers PUT directly to R2 with a presigned URL, and readers
 * GET through a short-lived signed URL. The server only ever signs and
 * verifies.
 */

import { S3Client } from "bun";
import { AppError } from "./errors";

export interface StoredObject {
	size: number;
	contentType: string;
}

export interface ObjectStorage {
	/** A URL the client may PUT exactly one object to. */
	presignUpload(input: {
		key: string;
		contentType: string;
		expiresInSeconds: number;
	}): string;

	/** A short-lived URL for reading an object. */
	presignDownload(input: { key: string; expiresInSeconds: number }): string;

	/** Metadata for an uploaded object, or null when it does not exist. */
	stat(key: string): Promise<StoredObject | null>;

	/**
	 * Every key under a prefix.
	 *
	 * The bucket, not the database, is the authority on what was uploaded. A
	 * designer who presigns a URL, PUTs the file and then closes the tab leaves
	 * an object no row ever references — so a cleanup driven by `content_assets`
	 * cannot see it, and it would sit in the bucket being paid for forever.
	 */
	list(prefix: string): Promise<string[]>;

	delete(key: string): Promise<void>;
}

export interface R2Config {
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
	bucket: string;
}

/**
 * Cloudflare R2, via Bun's built-in S3 client.
 *
 * R2 speaks the S3 API, and Bun ships a client, so this needs no dependency.
 */
export function createR2Storage(config: R2Config): ObjectStorage {
	const client = new S3Client({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		bucket: config.bucket,
		endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
		// R2 ignores regions but the S3 signing algorithm requires one.
		region: "auto",
	});

	return {
		presignUpload({ key, contentType, expiresInSeconds }) {
			return client.file(key).presign({
				method: "PUT",
				expiresIn: expiresInSeconds,
				type: contentType,
			});
		},

		presignDownload({ key, expiresInSeconds }) {
			return client.file(key).presign({
				method: "GET",
				expiresIn: expiresInSeconds,
			});
		},

		async stat(key) {
			try {
				const info = await client.file(key).stat();
				return {
					size: info.size,
					contentType: info.type ?? "application/octet-stream",
				};
			} catch {
				// The SDK throws for a missing key; absence is a normal answer here.
				return null;
			}
		},

		async list(prefix) {
			const keys: string[] = [];
			let continuationToken: string | undefined;

			// Paged: S3 caps a listing at 1000 keys and reports the truncation
			// rather than failing, so a caller that ignores the token silently
			// cleans up a fraction of what it was asked to.
			do {
				const page = await client.list({
					prefix,
					continuationToken,
					maxKeys: 1000,
				});

				for (const object of page.contents ?? []) {
					if (object.key) keys.push(object.key);
				}

				continuationToken = page.isTruncated
					? page.nextContinuationToken
					: undefined;
			} while (continuationToken);

			return keys;
		},

		async delete(key) {
			await client.file(key).delete();
		},
	};
}

/** How long a panel's preview URL stays valid. */
export const PREVIEW_URL_TTL_SECONDS = 5 * 60;

/**
 * Attaches a short-lived viewing URL to each asset.
 *
 * Deliberately separate from the download endpoint. A reviewer has to see an
 * image to judge it and a designer has to see their own upload, and neither is
 * a download — routing those through the counted endpoint would inflate the
 * numbers designers are measured on with the clicks of the people assessing
 * them. The objects are still not public: this is a signed URL that expires.
 */
export function withPreviews<T extends { storageKey: string }>(
	assets: T[],
	storage: ObjectStorage,
): (T & { previewUrl: string })[] {
	return assets.map((asset) => ({
		...asset,
		previewUrl: storage.presignDownload({
			key: asset.storageKey,
			expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
		}),
	}));
}

/** The prefix every object for one piece of content lives under. */
export function contentPrefix(contentId: string): string {
	return `content/${contentId}/`;
}

/**
 * Deletes every object belonging to a piece of content.
 *
 * Driven by the bucket listing rather than by `content_assets`, so it also
 * catches uploads that were presigned and PUT but never confirmed. Returns what
 * it managed to do rather than throwing: a storage failure should not roll back
 * a database change the caller has already decided on, and the nightly sweep
 * retries whatever is left.
 */
export async function purgeContentObjects(
	storage: ObjectStorage,
	contentId: string,
): Promise<{ deleted: number; failed: number }> {
	let deleted = 0;
	let failed = 0;

	let keys: string[];
	try {
		keys = await storage.list(contentPrefix(contentId));
	} catch (cause) {
		console.warn(`Failed to list objects for ${contentId}:`, cause);
		return { deleted: 0, failed: 1 };
	}

	for (const key of keys) {
		try {
			await storage.delete(key);
			deleted++;
		} catch (cause) {
			console.warn(`Failed to delete object ${key}:`, cause);
			failed++;
		}
	}

	return { deleted, failed };
}

/**
 * Resolves storage for this process, failing clearly when it is unconfigured
 * rather than at import time — the server must still boot for work that does
 * not touch uploads.
 */
export function requireObjectStorage(
	config: Partial<R2Config>,
	override?: ObjectStorage,
): ObjectStorage {
	if (override) return override;

	const { accountId, accessKeyId, secretAccessKey, bucket } = config;
	if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
		throw new AppError(
			"INTERNAL",
			"Object storage is not configured on this server (R2_* environment variables are unset).",
		);
	}

	return createR2Storage({ accountId, accessKeyId, secretAccessKey, bucket });
}
