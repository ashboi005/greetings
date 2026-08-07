import { db } from "@greetings/db";
import {
	CONTENT_STATUSES,
	content,
	contentAssets,
	contentTags,
	languages,
	regions,
	tags,
} from "@greetings/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { optionalEnum } from "../../lib/schema";
import type { ObjectStorage } from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
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

		.post(
			"/content/:id/upload-url",
			async ({ currentUser, params, body }) => {
				const designer = requireUser(currentUser);
				const draft = await loadOwnContent(params.id, designer.id);

				if (draft.status !== "draft" && draft.status !== "rejected") {
					throw conflict(
						`Cannot add images to content that is ${draft.status}.`,
					);
				}

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

				if (draft.status !== "draft" && draft.status !== "rejected") {
					throw conflict(
						`Cannot add images to content that is ${draft.status}.`,
					);
				}

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
				await db.insert(contentAssets).values({
					id,
					contentId: params.id,
					storageKey: body.storageKey,
					mimeType: object.contentType,
					width: body.width,
					height: body.height,
					bytes: object.size,
					checksum: body.checksum,
				});

				return { id, bytes: object.size, mimeType: object.contentType };
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

		.put(
			"/content/:id/tags",
			async ({ currentUser, params, body }) => {
				const designer = requireUser(currentUser);
				const draft = await loadOwnContent(params.id, designer.id);

				if (draft.status !== "draft" && draft.status !== "rejected") {
					throw conflict(`Cannot retag content that is ${draft.status}.`);
				}

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

async function assertLanguageExists(code: string) {
	const [row] = await db
		.select({ code: languages.code })
		.from(languages)
		.where(eq(languages.code, code))
		.limit(1);
	if (!row) throw badRequest(`Unknown language: ${code}`);
}

async function assertRegionExists(code: string) {
	const [row] = await db
		.select({ code: regions.code })
		.from(regions)
		.where(eq(regions.code, code))
		.limit(1);
	if (!row) throw badRequest(`Unknown region: ${code}`);
}
