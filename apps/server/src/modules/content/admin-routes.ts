import { db } from "@greetings/db";
import {
	CONTENT_STATUSES,
	type ContentStatus,
	content,
	user as userTable,
} from "@greetings/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { notFound } from "../../lib/errors";
import { optionalEnum } from "../../lib/schema";
import {
	type ObjectStorage,
	optionalObjectStorage,
	withPreviews,
} from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
import { availableActions, transition } from "./lifecycle";

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
						COALESCE(r.open_reports, 0) AS "openReports"
					FROM content c
					JOIN "user" u ON u.id = c.designer_id
					-- A grouped join rather than a correlated subquery per row. At
					-- a hundred rows that was a hundred index probes for a number
					-- that is almost always zero; this is one pass over the open
					-- reports, of which there are few by definition.
					LEFT JOIN (
						SELECT content_id, COUNT(*)::int AS open_reports
						FROM reports
						WHERE status = 'open'
						GROUP BY content_id
					) r ON r.content_id = c.id
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
				// One query for the review screen. It used to be three — the item,
				// then its images, then its history — which is the shape that turns
				// into a waterfall as soon as anything lists them.
				const result = await db.execute(sql`
					SELECT
						c.id,
						c.title,
						c.description,
						c.status::text       AS status,
						c.primary_language   AS "primaryLanguage",
						c.region_code        AS "regionCode",
						c.visibility_hold    AS "visibilityHold",
						c.rejection_reason   AS "rejectionReason",
						c.submitted_at       AS "submittedAt",
						c.published_at       AS "publishedAt",
						c.designer_id        AS "designerId",
						u.name               AS "designerName",
						COALESCE(a.assets, '[]'::json)  AS assets,
						COALESCE(h.history, '[]'::json) AS history
					FROM content c
					JOIN "user" u ON u.id = c.designer_id
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
						-- Actor names resolved here, not left as ids: a review screen
						-- showing "rejected by 6f2a…" tells the next admin nothing.
						-- Looked up rather than stored, so a display-name change never
						-- retroactively rewrites the log.
						SELECT json_agg(json_build_object(
							'action', ma.action::text,
							'reason', ma.reason,
							'actorId', ma.actor_id,
							'actorName', actor.name,
							'actorRole', actor.role::text,
							'createdAt', ma.created_at
						) ORDER BY ma.created_at DESC) AS history
						FROM moderation_actions ma
						LEFT JOIN "user" actor ON actor.id = ma.actor_id
						WHERE ma.content_id = c.id
					) h ON TRUE
					WHERE c.id = ${params.id}
				`);

				const row = result.rows[0] as
					| (Record<string, unknown> & {
							status: ContentStatus;
							assets: { storageKey: string }[];
					  })
					| undefined;

				if (!row) throw notFound("No such content.");

				return {
					...row,
					// Reviewers need to see the image. A signed preview rather than
					// the download endpoint, so assessing content never counts as
					// consuming it.
					assets: withPreviews(row.assets, optionalObjectStorage(storage)),
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
