import { db } from "@greetings/db";
import {
	CONTENT_STATUSES,
	content,
	contentAssets,
	contentTags,
	tags,
} from "@greetings/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { optionalEnum } from "../../lib/schema";
import {
	type ObjectStorage,
	optionalObjectStorage,
	purgeContentObjects,
	withPreviews,
} from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
import { knownLanguageCodes, knownRegionCodes } from "../profile/routes";
import { transition } from "./lifecycle";

/**
 * Designer content management (spec §6).
 *
 * The upload never passes through this server: it hands out a presigned URL,
 * the client PUTs to R2 directly, and then the server confirms the object
 * really landed before recording it.
 */

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * The states in which content is still the designer's to change.
 *
 * Both mean an admin has not (or no longer has) a decision standing on it, so
 * editing changes nothing anyone has relied on. Every mutating designer route
 * checks against this one list rather than repeating the pair.
 */
const EDITABLE_STATUSES = ["draft", "rejected"] as const;

function assertEditable(status: string, message?: string): void {
	if (!(EDITABLE_STATUSES as readonly string[]).includes(status)) {
		throw conflict(message ?? `Cannot change content that is ${status}.`, {
			status,
		});
	}
}

/**
 * Rechecks editability while atomically taking the content row lock.
 *
 * Route-level checks provide useful errors, but storage and validation work can
 * happen after them. This write is the transaction's first operation so a
 * concurrent submit either waits for the edit or wins and makes this return no
 * row; an image or tag set can never change after submission.
 */
async function claimEditableContent(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle's transaction type is not nameable here
	tx: any,
	input: {
		contentId: string;
		designerId: string;
		patch?: Record<string, unknown>;
	},
): Promise<void> {
	const [claimed] = await tx
		.update(content)
		.set({ ...input.patch, updatedAt: new Date() })
		.where(
			and(
				eq(content.id, input.contentId),
				eq(content.designerId, input.designerId),
				inArray(content.status, [...EDITABLE_STATUSES]),
			),
		)
		.returning({ id: content.id });

	if (!claimed) {
		throw conflict("Content is no longer editable.");
	}
}

export function designerContentRoutes(storage: () => ObjectStorage) {
	return new Elysia({ prefix: "/v1/designer" })
		.use(authGuard)

		.post(
			"/content",
			async ({ currentUser, body }) => {
				const designer = requireUser(currentUser);
				await assertLanguageExists(body.primaryLanguage);
				if (body.regionCode) await assertRegionExists(body.regionCode);

				const id = crypto.randomUUID();
				await db.insert(content).values({
					id,
					designerId: designer.id,
					title: body.title,
					description: body.description,
					primaryLanguage: body.primaryLanguage,
					regionCode: body.regionCode,
					status: "draft",
				});

				return { id, status: "draft" as const };
			},
			{
				requireRole: ["designer"],
				body: t.Object({
					title: t.String({ minLength: 1, maxLength: 200 }),
					description: t.Optional(t.String({ maxLength: 2000 })),
					primaryLanguage: t.String({ minLength: 2 }),
					regionCode: t.Optional(
						t.String({
							minLength: 2,
							description: "Omit for content relevant everywhere",
						}),
					),
				}),
				detail: {
					tags: ["Designer"],
					summary: "Create a draft",
				},
			},
		)

		.patch(
			"/content/:id",
			async ({ currentUser, params, body }) => {
				const designer = requireUser(currentUser);
				const existing = await loadOwnContent(params.id, designer.id);

				// Editable only before an admin has ruled on it. An approval is of
				// specific words and a specific image; letting the text change
				// afterwards would make review theatre — a designer could get an
				// innocuous title approved and then swap in anything.
				assertEditable(existing.status);

				if (body.primaryLanguage) {
					await assertLanguageExists(body.primaryLanguage);
				}
				// Explicit null clears the region, making the item global. That is
				// different from omitting the field, which leaves it alone.
				if (body.regionCode) await assertRegionExists(body.regionCode);

				const [updated] = await db
					.update(content)
					.set({
						...(body.title === undefined ? {} : { title: body.title }),
						...(body.description === undefined
							? {}
							: { description: body.description }),
						...(body.primaryLanguage === undefined
							? {}
							: { primaryLanguage: body.primaryLanguage }),
						...(body.regionCode === undefined
							? {}
							: { regionCode: body.regionCode }),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(content.id, params.id),
							eq(content.designerId, designer.id),
							// Re-checked in the UPDATE itself: the status read above
							// could have changed under a concurrent submit.
							inArray(content.status, EDITABLE_STATUSES),
						),
					)
					.returning({ id: content.id, status: content.status });

				if (!updated) {
					throw conflict("This content is no longer editable.");
				}

				return updated;
			},
			{
				requireRole: ["designer"],
				body: t.Object({
					title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
					description: t.Optional(
						t.Union([t.String({ maxLength: 2000 }), t.Null()]),
					),
					primaryLanguage: t.Optional(t.String({ minLength: 2 })),
					regionCode: t.Optional(
						t.Union([
							t.String({ minLength: 2 }),
							t.Null({ description: "Clears the region, making it global" }),
						]),
					),
				}),
				detail: {
					tags: ["Designer"],
					summary: "Edit a draft or a rejected item",
					description:
						"Only while the item is a draft or has been rejected. Omitted " +
						"fields are left alone; an explicit null clears description or " +
						"region. This is how a designer acts on a rejection reason.",
				},
			},
		)

		.delete(
			"/content/:id",
			async ({ currentUser, params }) => {
				const designer = requireUser(currentUser);
				const existing = await loadOwnContent(params.id, designer.id);

				// Anything an admin has seen leaves the designer's hands. Removing
				// live content is a moderation decision and has to leave an audit
				// row; a designer deleting their own row would erase it instead.
				assertEditable(
					existing.status,
					"Only a draft or a rejected item can be discarded. Ask an admin to take down published content.",
				);

				const [deleted] = await db
					.delete(content)
					.where(
						and(
							eq(content.id, params.id),
							eq(content.designerId, designer.id),
							inArray(content.status, EDITABLE_STATUSES),
						),
					)
					.returning({ id: content.id });

				if (!deleted) throw conflict("This content can no longer be deleted.");

				// After the row is gone, not before: a failure here leaves objects
				// for the nightly sweep, whereas failing first would leave a row the
				// designer has already been told is deleted. Same reason the missing
				// -storage case is tolerated: the delete has already happened.
				const objectStorage = optionalObjectStorage(storage);
				const purged = objectStorage
					? await purgeContentObjects(objectStorage, params.id)
					: { deleted: 0 };

				return { ok: true as const, objectsDeleted: purged.deleted };
			},
			{
				requireRole: ["designer"],
				detail: {
					tags: ["Designer"],
					summary: "Discard a draft or a rejected item",
					description:
						"Deletes the row and its uploaded images. Published content " +
						"cannot be deleted this way — that is an admin removal, which " +
						"is recorded.",
				},
			},
		)

		.post(
			"/content/:id/upload-url",
			async ({ currentUser, params, body }) => {
				const designer = requireUser(currentUser);
				const draft = await loadOwnContent(params.id, designer.id);

				assertEditable(
					draft.status,
					`Cannot add images to content that is ${draft.status}.`,
				);

				if (!ALLOWED_MIME.includes(body.mimeType as never)) {
					throw badRequest(
						`Unsupported image type. Allowed: ${ALLOWED_MIME.join(", ")}.`,
					);
				}

				if (body.bytes > MAX_UPLOAD_BYTES) {
					throw badRequest(
						`Image exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.`,
					);
				}

				// The key embeds the content id so an orphaned object is traceable
				// back to its draft, and a random suffix so a retried upload never
				// silently overwrites a confirmed one.
				const extension = body.mimeType.split("/")[1];
				const key = `content/${params.id}/${crypto.randomUUID()}.${extension}`;

				return {
					storageKey: key,
					uploadUrl: storage().presignUpload({
						key,
						contentType: body.mimeType,
						expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
					}),
					expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
				};
			},
			{
				requireRole: ["designer"],
				body: t.Object({
					mimeType: t.String({
						description: "image/jpeg, image/png or image/webp",
					}),
					bytes: t.Integer({ minimum: 1 }),
				}),
				detail: {
					tags: ["Designer"],
					summary: "Get a presigned URL to upload an image",
					description:
						"PUT the file to `uploadUrl` with the same Content-Type, then " +
						"confirm it with POST /v1/designer/content/{id}/assets.",
				},
			},
		)

		.post(
			"/content/:id/assets",
			async ({ currentUser, params, body }) => {
				const designer = requireUser(currentUser);
				const draft = await loadOwnContent(params.id, designer.id);

				assertEditable(
					draft.status,
					`Cannot add images to content that is ${draft.status}.`,
				);

				// The key must belong to this content: without this check a
				// designer could confirm someone else's object into their own post.
				if (!body.storageKey.startsWith(`content/${params.id}/`)) {
					throw badRequest("Storage key does not belong to this content.");
				}

				// Trust the object, not the client: the request body claims a size
				// and type, but only R2 knows what actually landed.
				const object = await storage().stat(body.storageKey);
				if (!object) {
					throw badRequest(
						"No uploaded object found for that key. PUT the file before confirming.",
					);
				}

				if (!ALLOWED_MIME.includes(object.contentType as never)) {
					throw badRequest(
						`Uploaded object is ${object.contentType}; expected one of ${ALLOWED_MIME.join(", ")}.`,
					);
				}

				if (object.size > MAX_UPLOAD_BYTES) {
					throw badRequest("Uploaded object exceeds the size limit.");
				}

				const id = crypto.randomUUID();

				// Confirming an image *replaces* whatever was there. An item shows
				// exactly one picture — the feed reads a single key off the content
				// row — so a second asset would be storage nobody ever sees, and a
				// designer who uploaded the wrong file would have no way to correct
				// it. This is only reachable while the item is a draft or rejected,
				// so nothing an admin has approved is being changed underneath them.
				const superseded = await db.transaction(async (tx) => {
					await claimEditableContent(tx, {
						contentId: params.id,
						designerId: designer.id,
						patch: { primaryAssetKey: body.storageKey },
					});

					const previous = await tx
						.delete(contentAssets)
						.where(eq(contentAssets.contentId, params.id))
						.returning({ storageKey: contentAssets.storageKey });

					await tx.insert(contentAssets).values({
						id,
						contentId: params.id,
						storageKey: body.storageKey,
						mimeType: object.contentType,
						width: body.width,
						height: body.height,
						bytes: object.size,
						checksum: body.checksum,
					});

					return previous.map((row) => row.storageKey);
				});

				// After the commit, and best-effort: the upload has succeeded as far
				// as the designer is concerned, and a storage hiccup here should not
				// turn that into a failure. Anything left behind is swept by the
				// nightly job, which lists the bucket rather than the database.
				for (const key of superseded) {
					try {
						await storage().delete(key);
					} catch (cause) {
						console.warn(`Could not delete superseded object ${key}:`, cause);
					}
				}

				return {
					id,
					bytes: object.size,
					mimeType: object.contentType,
					replaced: superseded.length,
				};
			},
			{
				requireRole: ["designer"],
				body: t.Object({
					storageKey: t.String({ minLength: 1 }),
					width: t.Integer({ minimum: 1 }),
					height: t.Integer({ minimum: 1 }),
					checksum: t.Optional(t.String()),
				}),
				detail: {
					tags: ["Designer"],
					summary: "Confirm an uploaded image",
				},
			},
		)

		.get(
			"/content/:id",
			async ({ currentUser, params }) => {
				const designer = requireUser(currentUser);

				// One query for a screen, not three. Assets and tags are aggregated
				// into JSON in the database rather than fetched in follow-up round
				// trips — the shape that reads fine for one item and becomes a
				// waterfall the moment anything lists them.
				//
				// Named columns rather than the whole row: it carries the generated
				// search vector and the feed's ranking internals, which no client
				// has any use for and which grow with the description.
				const result = await db.execute(sql`
					SELECT
						c.id,
						c.title,
						c.description,
						c.status::text        AS status,
						c.primary_language    AS "primaryLanguage",
						c.region_code         AS "regionCode",
						c.download_count      AS "downloadCount",
						c.visibility_hold     AS "visibilityHold",
						c.rejection_reason    AS "rejectionReason",
						c.submitted_at        AS "submittedAt",
						c.published_at        AS "publishedAt",
						c.created_at          AS "createdAt",
						COALESCE(a.assets, '[]'::json) AS assets,
						COALESCE(t.tags, '[]'::json)   AS tags
					FROM content c
					LEFT JOIN LATERAL (
						SELECT json_agg(json_build_object(
							'id', ca.id,
							'storageKey', ca.storage_key,
							'mimeType', ca.mime_type,
							'width', ca.width,
							'height', ca.height,
							'bytes', ca.bytes
						) ORDER BY ca.created_at) AS assets
						FROM content_assets ca WHERE ca.content_id = c.id
					) a ON TRUE
					LEFT JOIN LATERAL (
						SELECT json_agg(json_build_object(
							'id', tg.id, 'slug', tg.slug, 'label', tg.label
						) ORDER BY tg.label) AS tags
						FROM content_tags ct
						JOIN tags tg ON tg.id = ct.tag_id
						WHERE ct.content_id = c.id
					) t ON TRUE
					WHERE c.id = ${params.id} AND c.designer_id = ${designer.id}
				`);

				const row = result.rows[0] as
					| (Record<string, unknown> & { assets: { storageKey: string }[] })
					| undefined;

				if (!row) throw notFound("No such content.");

				return {
					...row,
					assets: withPreviews(row.assets, optionalObjectStorage(storage)),
				};
			},
			{
				requireRole: ["designer"],
				detail: {
					tags: ["Designer"],
					summary: "One of the caller's own items, with images and tags",
					description:
						"Assets carry a `previewUrl` valid for five minutes. Previews do " +
						"not count as downloads — looking at your own work is not a " +
						"download, and counting it would corrupt the numbers designers " +
						"are measured on.",
				},
			},
		)

		.put(
			"/content/:id/tags",
			async ({ currentUser, params, body }) => {
				const designer = requireUser(currentUser);
				const draft = await loadOwnContent(params.id, designer.id);

				assertEditable(
					draft.status,
					`Cannot retag content that is ${draft.status}.`,
				);

				const unique = [...new Set(body.tagIds)];
				const found = await db
					.select({ id: tags.id })
					.from(tags)
					.where(and(inArray(tags.id, unique), eq(tags.isActive, true)));

				if (found.length !== unique.length) {
					const known = new Set(found.map((f) => f.id));
					throw badRequest(
						`Unknown or inactive tags: ${unique.filter((id) => !known.has(id)).join(", ")}`,
					);
				}

				await db.transaction(async (tx) => {
					await claimEditableContent(tx, {
						contentId: params.id,
						designerId: designer.id,
					});

					await tx
						.delete(contentTags)
						.where(eq(contentTags.contentId, params.id));
					await tx
						.insert(contentTags)
						.values(unique.map((tagId) => ({ contentId: params.id, tagId })));
				});

				return { ok: true as const, count: unique.length };
			},
			{
				requireRole: ["designer"],
				body: t.Object({
					tagIds: t.Array(t.String(), { minItems: 1, maxItems: 20 }),
				}),
				detail: { tags: ["Designer"], summary: "Replace the tag set" },
			},
		)

		.post(
			"/content/:id/submit",
			async ({ currentUser, params }) => {
				const designer = requireUser(currentUser);

				// Checked before the transition so the designer gets a specific
				// complaint rather than a generic refusal.
				await assertSubmittable(params.id, designer.id);

				return db.transaction((tx) =>
					transition(tx, {
						contentId: params.id,
						action: "submit",
						actorId: designer.id,
						requireDesignerId: designer.id,
					}),
				);
			},
			{
				requireRole: ["designer"],
				detail: {
					tags: ["Designer"],
					summary: "Submit for review",
					description:
						"Requires a title, at least one confirmed image and at least one tag.",
				},
			},
		)

		.get(
			"/content",
			async ({ currentUser, query }) => {
				const designer = requireUser(currentUser);

				const rows = await db
					.select({
						id: content.id,
						title: content.title,
						status: content.status,
						primaryLanguage: content.primaryLanguage,
						regionCode: content.regionCode,
						downloadCount: content.downloadCount,
						rejectionReason: content.rejectionReason,
						submittedAt: content.submittedAt,
						publishedAt: content.publishedAt,
						createdAt: content.createdAt,
					})
					.from(content)
					.where(
						query.status
							? and(
									eq(content.designerId, designer.id),
									eq(content.status, query.status),
								)
							: eq(content.designerId, designer.id),
					)
					.orderBy(desc(content.createdAt))
					.limit(query.limit ?? 50);

				return rows;
			},
			{
				requireRole: ["designer"],
				query: t.Object({
					status: optionalEnum(CONTENT_STATUSES, {
						description: "Filter to one status; omit for all",
					}),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
				}),
				detail: {
					tags: ["Designer"],
					summary: "List the caller's own content",
				},
			},
		);
}

async function loadOwnContent(contentId: string, designerId: string) {
	const [row] = await db
		.select({ id: content.id, status: content.status })
		.from(content)
		.where(and(eq(content.id, contentId), eq(content.designerId, designerId)))
		.limit(1);

	// Deliberately the same answer as a genuinely missing row: telling a
	// designer that someone else's content exists is itself a disclosure.
	if (!row) throw notFound("No such content.");
	return row;
}

async function assertSubmittable(contentId: string, designerId: string) {
	const [row] = await db
		.select({ title: content.title })
		.from(content)
		.where(and(eq(content.id, contentId), eq(content.designerId, designerId)))
		.limit(1);

	if (!row) throw notFound("No such content.");
	if (!row.title.trim()) throw badRequest("A title is required before review.");

	const [asset] = await db
		.select({ id: contentAssets.id })
		.from(contentAssets)
		.where(eq(contentAssets.contentId, contentId))
		.limit(1);
	if (!asset) throw badRequest("At least one image is required before review.");

	const [tag] = await db
		.select({ tagId: contentTags.tagId })
		.from(contentTags)
		.where(eq(contentTags.contentId, contentId))
		.limit(1);
	if (!tag) throw badRequest("At least one tag is required before review.");
}

/**
 * Reference checks, served from the cache the reference endpoints already fill.
 *
 * These were a query each on the way in to creating or editing content. They
 * are two lists of a few dozen rows that change when someone runs a seed
 * script; holding them removes two round trips from every write.
 */
async function assertLanguageExists(code: string) {
	if (!(await knownLanguageCodes()).has(code)) {
		throw badRequest(`Unknown language: ${code}`);
	}
}

async function assertRegionExists(code: string) {
	if (!(await knownRegionCodes()).has(code)) {
		throw badRequest(`Unknown region: ${code}`);
	}
}
