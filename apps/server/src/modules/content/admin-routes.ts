import { db } from "@greetings/db";
import {
	CONTENT_STATUSES,
	content,
	contentAssets,
	moderationActions,
	user as userTable,
} from "@greetings/db/schema";
import { asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Elysia, t } from "elysia";
import { notFound } from "../../lib/errors";
import { optionalEnum } from "../../lib/schema";
import { type ObjectStorage, withPreviews } from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
import { availableActions, transition } from "./lifecycle";

/**
 * The moderator behind an action, as distinct from the designer who made the
 * content — both are rows in `user`, so the join needs two names.
 */
const actor = alias(userTable, "actor");

/**
 * Admin review of submitted content (spec §5).
 *
 * Nothing reaches an end user without passing through here.
 */
export function adminContentRoutes(storage: () => ObjectStorage) {
	return new Elysia({ prefix: "/v1/admin" })
		.use(authGuard)

		.get(
			"/content/queue",
			async ({ query }) => {
				const rows = await db
					.select({
						id: content.id,
						title: content.title,
						description: content.description,
						status: content.status,
						primaryLanguage: content.primaryLanguage,
						regionCode: content.regionCode,
						submittedAt: content.submittedAt,
						designerId: content.designerId,
						designerName: userTable.name,
					})
					.from(content)
					.innerJoin(userTable, eq(userTable.id, content.designerId))
					.where(eq(content.status, query.status ?? "pending_review"))
					// Oldest first: a newest-first queue starves whatever is at the
					// back, and designers are waiting on these.
					.orderBy(asc(content.submittedAt))
					.limit(query.limit ?? 50);

				return rows.map((row) => ({
					...row,
					availableActions: availableActions(row.status),
				}));
			},
			{
				requireRole: ["admin", "super_admin"],
				query: t.Object({
					status: optionalEnum(CONTENT_STATUSES, {
						description: "Defaults to pending_review",
					}),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Content awaiting review, oldest first",
				},
			},
		)

		.get(
			"/content",
			async ({ query }) => {
				const term = query.q?.trim();

				// Raw SQL rather than the builder: four independent optional
				// filters assembled with `and(...)` reads far worse than the
				// null-guard form, and this is the query an admin reaches for
				// when they need to find one specific item among everything.
				const rows = await db.execute(sql`
					SELECT
						c.id,
						c.title,
						c.status::text          AS status,
						c.primary_language      AS "primaryLanguage",
						c.region_code           AS "regionCode",
						c.visibility_hold       AS "visibilityHold",
						c.download_count        AS "downloadCount",
						c.created_at            AS "createdAt",
						c.submitted_at          AS "submittedAt",
						c.published_at          AS "publishedAt",
						c.designer_id           AS "designerId",
						u.name                  AS "designerName",
						(SELECT COUNT(*)::int FROM reports rp
							WHERE rp.content_id = c.id AND rp.status = 'open')
							AS "openReports"
					FROM content c
					JOIN "user" u ON u.id = c.designer_id
					WHERE (${query.status ?? null}::text IS NULL
					       OR c.status::text = ${query.status ?? null}::text)
						AND (${query.designerId ?? null}::text IS NULL
						     OR c.designer_id = ${query.designerId ?? null}::text)
						AND (${term ?? null}::text IS NULL
						     OR c.id = ${term ?? ""}
						     OR c.title ILIKE ${`%${term ?? ""}%`})
					ORDER BY c.created_at DESC
					LIMIT ${query.limit ?? 50}
				`);

				return rows.rows;
			},
			{
				requireRole: ["admin", "super_admin"],
				query: t.Object({
					q: t.Optional(
						t.String({
							maxLength: 200,
							description: "Match a title, or paste an exact content id",
						}),
					),
					status: optionalEnum(CONTENT_STATUSES, {
						description: "Filter to one status; omit for every status",
					}),
					designerId: t.Optional(t.String()),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Search all content, in any status",
					description:
						"The way in to a specific item: search by title or paste an id, " +
						"then open its audit trail. Unlike the review queue this spans " +
						"every status, including removed and draft.",
				},
			},
		)

		.get(
			"/content/:id",
			async ({ params }) => {
				const [row] = await db
					.select({
						id: content.id,
						title: content.title,
						description: content.description,
						status: content.status,
						primaryLanguage: content.primaryLanguage,
						regionCode: content.regionCode,
						visibilityHold: content.visibilityHold,
						rejectionReason: content.rejectionReason,
						submittedAt: content.submittedAt,
						publishedAt: content.publishedAt,
						designerId: content.designerId,
						designerName: userTable.name,
					})
					.from(content)
					.innerJoin(userTable, eq(userTable.id, content.designerId))
					.where(eq(content.id, params.id))
					.limit(1);

				if (!row) throw notFound("No such content.");

				const assets = await db
					.select({
						id: contentAssets.id,
						storageKey: contentAssets.storageKey,
						mimeType: contentAssets.mimeType,
						width: contentAssets.width,
						height: contentAssets.height,
						bytes: contentAssets.bytes,
					})
					.from(contentAssets)
					.where(eq(contentAssets.contentId, params.id));

				// Resolved to names, not left as ids: a review screen showing
				// "rejected by 6f2a…" tells the next admin nothing. Identity is
				// looked up rather than stored on the row, so a display-name
				// change does not retroactively rewrite the log.
				const history = await db
					.select({
						action: moderationActions.action,
						reason: moderationActions.reason,
						actorId: moderationActions.actorId,
						actorName: actor.name,
						actorRole: actor.role,
						createdAt: moderationActions.createdAt,
					})
					.from(moderationActions)
					.leftJoin(actor, eq(actor.id, moderationActions.actorId))
					.where(eq(moderationActions.contentId, params.id))
					.orderBy(desc(moderationActions.createdAt));

				return {
					...row,
					// Reviewers need to see the image. A signed preview rather than
					// the download endpoint, so assessing content never counts as
					// consuming it.
					assets: withPreviews(assets, storage()),
					history,
					availableActions: availableActions(row.status),
				};
			},
			{
				requireRole: ["admin", "super_admin"],
				detail: {
					tags: ["Admin"],
					summary: "One item with its images and moderation history",
				},
			},
		)

		.post(
			"/content/:id/approve",
			async ({ currentUser, params }) => {
				const admin = requireUser(currentUser);
				return db.transaction((tx) =>
					transition(tx, {
						contentId: params.id,
						action: "approve",
						actorId: admin.id,
					}),
				);
			},
			{
				requireRole: ["admin", "super_admin"],
				detail: { tags: ["Admin"], summary: "Approve and publish" },
			},
		)

		.post(
			"/content/:id/reject",
			async ({ currentUser, params, body }) => {
				const admin = requireUser(currentUser);
				return db.transaction((tx) =>
					transition(tx, {
						contentId: params.id,
						action: "reject",
						actorId: admin.id,
						reason: body.reason,
					}),
				);
			},
			{
				requireRole: ["admin", "super_admin"],
				body: t.Object({
					// Required: the designer has to know what to fix, and a
					// rejection without a reason generates a support conversation.
					reason: t.String({ minLength: 1, maxLength: 500 }),
				}),
				detail: { tags: ["Admin"], summary: "Reject with a reason" },
			},
		)

		.post(
			"/content/:id/remove",
			async ({ currentUser, params, body }) => {
				const admin = requireUser(currentUser);
				return db.transaction((tx) =>
					transition(tx, {
						contentId: params.id,
						action: "remove",
						actorId: admin.id,
						reason: body.reason,
					}),
				);
			},
			{
				requireRole: ["admin", "super_admin"],
				body: t.Object({
					reason: t.String({ minLength: 1, maxLength: 500 }),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Take content down",
				},
			},
		)

		.post(
			"/content/:id/restore",
			async ({ currentUser, params, body }) => {
				const admin = requireUser(currentUser);
				return db.transaction((tx) =>
					transition(tx, {
						contentId: params.id,
						action: "restore",
						actorId: admin.id,
						reason: body.reason,
					}),
				);
			},
			{
				requireRole: ["admin", "super_admin"],
				body: t.Object({
					reason: t.Optional(t.String({ maxLength: 500 })),
				}),
				detail: {
					tags: ["Admin"],
					summary: "Put removed content back",
				},
			},
		);
}
