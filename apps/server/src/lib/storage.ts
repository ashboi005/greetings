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

		async delete(key) {
			await client.file(key).delete();
		},
	};
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
