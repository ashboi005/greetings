/**
 * My Designs — the user's own design studio (spec §16).
 *
 * A private, unreviewed, uncounted space: the user composes something in the
 * app's editor and it is saved here so they can come back to it. None of the
 * content machinery applies — no lifecycle, no approval, no feed, no download
 * counting — which is exactly why these are their own table rather than rows in
 * `content` carrying a flag.
 *
 * Two things are stored per design:
 *
 * - `designJson`, the editable scene. Opaque to the server on purpose: the
 *   renderer is Skia on the device, so validating the structure here would mean
 *   two definitions of a design that have to agree, and a deploy every time the
 *   editor gains a feature.
 * - `previewKey`, a flattened render. Without it the gallery would have to
 *   rebuild every design on the device just to draw a thumbnail, and sharing an
 *   old design would mean re-rendering it first.
 *
 * There is no delete, deliberately (spec §17). Everything here is scoped to the
 * calling user; a design belonging to someone else is a 404, not a 403, because
 * whether it exists is not the caller's business.
 */

import { db } from "@greetings/db";
import { userDesigns } from "@greetings/db/schema";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest, notFound } from "../../lib/errors";
import {
	cursorTimestamp,
	decodeCursor,
	encodeCursor,
} from "../../lib/pagination";
import type { ObjectStorage } from "../../lib/storage";
import { publicImageUrl } from "../../lib/storage";
import {
	ALLOWED_IMAGE_MIME,
	assertKeyBelongsTo,
	assertUploadedObject,
	presignImageUpload,
} from "../../lib/uploads";
import { authGuard, requireUser } from "../auth/session";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** One image per design, so this is a photo rather than a library. */
const MAX_DESIGN_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Ceiling on the scene graph.
 *
 * The server does not interpret `designJson`, so this is the only thing
 * standing between a bug in the editor and a row that breaks every list query
 * that reads it. Well above any real design; the global body limit is 1MB.
 */
export const MAX_DESIGN_JSON_BYTES = 256 * 1024;

const prefixFor = (designId: string) => `designs/${designId}/`;

function assertJsonSize(value: unknown): void {
	const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
	if (bytes > MAX_DESIGN_JSON_BYTES) {
		throw badRequest(
			`Design is ${Math.round(bytes / 1024)}KB; the limit is ${MAX_DESIGN_JSON_BYTES / 1024}KB.`,
		);
	}
}

/** Loads a design the caller owns, or 404s. */
async function loadOwnDesign(designId: string, userId: string) {
	const [row] = await db
		.select()
		.from(userDesigns)
		.where(and(eq(userDesigns.id, designId), eq(userDesigns.userId, userId)))
		.limit(1);

	// Deliberately 404 rather than 403 for someone else's design: a 403 would
	// confirm the id exists, which is a small leak with no upside.
	if (!row) throw notFound("No such design.");
	return row;
}

const designSummary = t.Object({
	id: t.String(),
	title: t.Union([t.String(), t.Null()]),
	previewUrl: t.Union([t.String(), t.Null()]),
	createdAt: t.String(),
	updatedAt: t.String(),
});

const designDetail = t.Composite([
	designSummary,
	t.Object({
		designJson: t.Unknown(),
		sourceImageUrl: t.Union([t.String(), t.Null()]),
	}),
]);

export function designRoutes(
	storage: () => ObjectStorage,
	options: { publicBaseUrl?: string } = {},
) {
	const summarise = (row: typeof userDesigns.$inferSelect) => ({
		id: row.id,
		title: row.title,
		previewUrl: publicImageUrl(row.previewKey, options.publicBaseUrl),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	});

	return new Elysia({ prefix: "/v1/me/designs" })
		.use(authGuard)

		.post(
			"",
			async ({ currentUser, body }) => {
				const user = requireUser(currentUser);
				assertJsonSize(body.designJson);

				const id = crypto.randomUUID();
				const now = new Date();

				const [row] = await db
					.insert(userDesigns)
					.values({
						id,
						userId: user.id,
						title: body.title ?? null,
						designJson: body.designJson,
						createdAt: now,
						updatedAt: now,
					})
					.returning();

				if (!row) throw badRequest("Could not save the design.");
				return {
					...summarise(row),
					designJson: row.designJson,
					sourceImageUrl: null,
				};
			},
			{
				requireRole: true,
				body: t.Object({
					title: t.Optional(t.String({ maxLength: 120 })),
					designJson: t.Unknown(),
				}),
				response: { 200: designDetail },
				detail: {
					tags: ["Designs"],
					summary: "Create a design",
					description:
						"Returns the id to attach an image and a preview to. designJson " +
						"is stored verbatim and never interpreted by the server.",
				},
			},
		)

		.get(
			"",
			async ({ currentUser, query }) => {
				const user = requireUser(currentUser);
				const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

				const cursor = query.cursor ? decodeCursor(query.cursor) : null;
				const after = cursor
					? {
							at: new Date(cursorTimestamp(cursor.t)),
							id: String(cursor.i ?? ""),
						}
					: null;

				const rows = await db
					.select()
					.from(userDesigns)
					.where(
						after
							? and(
									eq(userDesigns.userId, user.id),
									// Row-value ordering by hand: updatedAt is not unique, so
									// without the id tiebreak two designs saved in the same
									// millisecond can repeat or be skipped across a page.
									or(
										lt(userDesigns.updatedAt, after.at),
										and(
											eq(userDesigns.updatedAt, after.at),
											lt(userDesigns.id, after.id),
										),
									),
								)
							: eq(userDesigns.userId, user.id),
					)
					.orderBy(desc(userDesigns.updatedAt), desc(userDesigns.id))
					.limit(limit + 1);

				const page = rows.slice(0, limit);
				const last = page.at(-1);

				return {
					items: page.map(summarise),
					nextCursor:
						rows.length > limit && last
							? encodeCursor({ t: last.updatedAt.toISOString(), i: last.id })
							: null,
				};
			},
			{
				requireRole: true,
				query: t.Object({
					cursor: t.Optional(t.String()),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_LIMIT })),
				}),
				response: {
					200: t.Object({
						items: t.Array(designSummary),
						nextCursor: t.Union([t.String(), t.Null()]),
					}),
				},
				detail: {
					tags: ["Designs"],
					summary: "The caller's designs, most recently edited first",
					description:
						"Summaries only — designJson is omitted so a gallery of fifty " +
						"designs is not fifty scene graphs. Fetch one by id to edit it.",
				},
			},
		)

		.get(
			"/:id",
			async ({ currentUser, params }) => {
				const user = requireUser(currentUser);
				const row = await loadOwnDesign(params.id, user.id);

				return {
					...summarise(row),
					designJson: row.designJson,
					sourceImageUrl: publicImageUrl(
						row.sourceImageKey,
						options.publicBaseUrl,
					),
				};
			},
			{
				requireRole: true,
				params: t.Object({ id: t.String() }),
				response: { 200: designDetail },
				detail: { tags: ["Designs"], summary: "One design, ready to edit" },
			},
		)

		.patch(
			"/:id",
			async ({ currentUser, params, body }) => {
				const user = requireUser(currentUser);
				await loadOwnDesign(params.id, user.id);

				if (body.designJson === undefined && body.title === undefined) {
					throw badRequest("Provide a title or designJson to change.");
				}

				if (body.designJson !== undefined) assertJsonSize(body.designJson);

				const [row] = await db
					.update(userDesigns)
					.set({
						...(body.title !== undefined ? { title: body.title } : {}),
						...(body.designJson !== undefined
							? { designJson: body.designJson }
							: {}),
						updatedAt: new Date(),
					})
					.where(eq(userDesigns.id, params.id))
					.returning();

				if (!row) throw notFound("No such design.");

				return {
					...summarise(row),
					designJson: row.designJson,
					sourceImageUrl: publicImageUrl(
						row.sourceImageKey,
						options.publicBaseUrl,
					),
				};
			},
			{
				requireRole: true,
				params: t.Object({ id: t.String() }),
				body: t.Object({
					title: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
					designJson: t.Optional(t.Unknown()),
				}),
				response: { 200: designDetail },
				detail: {
					tags: ["Designs"],
					summary: "Rename a design or save an edit",
					description:
						"A PATCH: an omitted field is left alone. Send a new preview " +
						"afterwards, or the gallery keeps showing the old render.",
				},
			},
		)

		.post(
			"/:id/upload-url",
			async ({ currentUser, params, body }) => {
				const user = requireUser(currentUser);
				await loadOwnDesign(params.id, user.id);

				return presignImageUpload({
					storage: storage(),
					// Keyed by design, not by purpose, so both objects for a design sit
					// together and an orphan is traceable back to it.
					prefix: prefixFor(params.id),
					mimeType: body.mimeType,
					bytes: body.bytes,
					maxBytes: MAX_DESIGN_IMAGE_BYTES,
				});
			},
			{
				requireRole: true,
				params: t.Object({ id: t.String() }),
				body: t.Object({
					purpose: t.UnionEnum(["source", "preview"]),
					mimeType: t.String({ description: ALLOWED_IMAGE_MIME.join(", ") }),
					bytes: t.Integer({ minimum: 1 }),
				}),
				response: {
					200: t.Object({
						storageKey: t.String(),
						uploadUrl: t.String(),
						expiresInSeconds: t.Number(),
					}),
				},
				detail: {
					tags: ["Designs"],
					summary: "Sign a URL for a design's image or its flattened preview",
					description:
						"`source` is the one photo a design may use. `preview` is the " +
						"flattened render the gallery shows.",
				},
			},
		)

		.post(
			"/:id/assets",
			async ({ currentUser, params, body }) => {
				const user = requireUser(currentUser);
				await loadOwnDesign(params.id, user.id);

				assertKeyBelongsTo(body.storageKey, prefixFor(params.id));
				await assertUploadedObject({
					storage: storage(),
					storageKey: body.storageKey,
					maxBytes: MAX_DESIGN_IMAGE_BYTES,
				});

				const [row] = await db
					.update(userDesigns)
					.set({
						...(body.purpose === "source"
							? { sourceImageKey: body.storageKey }
							: { previewKey: body.storageKey }),
						updatedAt: new Date(),
					})
					.where(eq(userDesigns.id, params.id))
					.returning();

				if (!row) throw notFound("No such design.");

				return {
					...summarise(row),
					designJson: row.designJson,
					sourceImageUrl: publicImageUrl(
						row.sourceImageKey,
						options.publicBaseUrl,
					),
				};
			},
			{
				requireRole: true,
				params: t.Object({ id: t.String() }),
				body: t.Object({
					purpose: t.UnionEnum(["source", "preview"]),
					storageKey: t.String({ maxLength: 300 }),
				}),
				response: { 200: designDetail },
				detail: {
					tags: ["Designs"],
					summary: "Confirm an uploaded image or preview",
					description:
						"Replaces whatever was there. A design has one image and one " +
						"preview; the previous objects are left for the cleanup job.",
				},
			},
		);
}
