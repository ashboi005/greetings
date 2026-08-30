/**
 * Presign-and-confirm for user-supplied images (spec §6, §16).
 *
 * The flow is the one the designer upload path established: the server signs a
 * URL, the client PUTs the bytes straight to R2, and the server then verifies
 * with a HEAD what actually landed rather than believing the client's claim
 * about it. Three new callers need it — the profile logo, and a design's source
 * image and its flattened preview — so it lives here instead of being written
 * out three more times.
 *
 * `modules/content/designer-routes.ts` still has its own copy. That one is
 * entangled with draft state transitions and asset replacement, and rewriting a
 * working, well-tested upload path to share code with a new one is a bad trade.
 */

import { badRequest } from "./errors";
import type { ObjectStorage } from "./storage";

/** What R2 will accept, matching the designer path. */
export const ALLOWED_IMAGE_MIME = [
	"image/jpeg",
	"image/png",
	"image/webp",
] as const;

/**
 * Long enough for a slow upload on a poor connection, short enough that a URL
 * copied out of a log is not a lasting grant.
 */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Extension for a mime type, so keys are recognisable in a bucket listing. */
function extensionFor(mimeType: string): string {
	return mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "bin";
}

/**
 * Validates an upload request and returns a key plus a signed PUT URL.
 *
 * `prefix` is what makes the confirm step safe: it embeds the owner, so
 * `assertKeyBelongsTo` can later refuse a key that belongs to someone else.
 */
export function presignImageUpload(input: {
	storage: ObjectStorage;
	/** Must end in "/" — e.g. `avatars/<userId>/`. */
	prefix: string;
	mimeType: string;
	bytes: number;
	maxBytes: number;
}): { storageKey: string; uploadUrl: string; expiresInSeconds: number } {
	if (!ALLOWED_IMAGE_MIME.includes(input.mimeType as never)) {
		throw badRequest(
			`Unsupported image type. Allowed: ${ALLOWED_IMAGE_MIME.join(", ")}.`,
		);
	}

	if (input.bytes > input.maxBytes) {
		throw badRequest(
			`Image exceeds the ${Math.round(input.maxBytes / 1024 / 1024)}MB limit.`,
		);
	}

	// Random suffix, never a fixed name like `avatar.png`: a replacement written
	// to the same key would be served stale from the CDN edge for as long as it
	// stays cached, and the user would see their old logo and assume it failed.
	const storageKey = `${input.prefix}${crypto.randomUUID()}.${extensionFor(input.mimeType)}`;

	return {
		storageKey,
		uploadUrl: input.storage.presignUpload({
			key: storageKey,
			contentType: input.mimeType,
			expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
		}),
		expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
	};
}

/**
 * Refuses a key that was not issued for this owner.
 *
 * Without it, a caller could confirm somebody else's object into their own
 * profile or design — the object keys are guessable enough to matter, and the
 * confirm step is otherwise happy to accept any key that exists.
 */
export function assertKeyBelongsTo(storageKey: string, prefix: string): void {
	if (!storageKey.startsWith(prefix)) {
		throw badRequest("Storage key does not belong to you.");
	}
}

/**
 * Confirms an object really landed, and is what it claimed to be.
 *
 * Trusts R2, not the request body. A client can say anything about the file it
 * uploaded; only the store knows the type and size of what actually arrived.
 */
export async function assertUploadedObject(input: {
	storage: ObjectStorage;
	storageKey: string;
	maxBytes: number;
}): Promise<void> {
	const object = await input.storage.stat(input.storageKey);

	if (!object) {
		throw badRequest(
			"No uploaded object found for that key. PUT the file before confirming.",
		);
	}

	if (!ALLOWED_IMAGE_MIME.includes(object.contentType as never)) {
		throw badRequest(
			`Uploaded object is ${object.contentType}; expected one of ${ALLOWED_IMAGE_MIME.join(", ")}.`,
		);
	}

	if (object.size > input.maxBytes) {
		throw badRequest("Uploaded object exceeds the size limit.");
	}
}
