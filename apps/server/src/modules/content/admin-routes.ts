import { db } from "@greetings/db";
import {
	CONTENT_STATUSES,
	content,
	contentAssets,
	moderationActions,
	user as userTable,
} from "@greetings/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { notFound } from "../../lib/errors";
import { optionalEnum } from "../../lib/schema";
import { authGuard, requireUser } from "../auth/session";
import { availableActions, transition } from "./lifecycle";

/**
 * Admin review of submitted content (spec §5).
 *
 * Nothing reaches an end user without passing through here.
 */
export function adminContentRoutes() {
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

				const history = await db
					.select({
						action: moderationActions.action,
						reason: moderationActions.reason,
						actorId: moderationActions.actorId,
						createdAt: moderationActions.createdAt,
					})
					.from(moderationActions)
					.where(eq(moderationActions.contentId, params.id))
					.orderBy(desc(moderationActions.createdAt));

				return {
					...row,
					assets,
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
