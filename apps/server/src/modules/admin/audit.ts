/**
 * Reading the audit trail (spec §4.4, §13).
 *
 * The records themselves are written by the code that does the work —
 * `transition()` writes a moderation action for every lifecycle move,
 * `applyRoleChange` writes a role change, resolving a report stamps the admin
 * onto it. None of that is optional or bolted on afterwards.
 *
 * This module is the other half: turning those rows into something a person can
 * read. Until now the history existed but was reachable only through psql, and
 * an audit trail nobody can read is a backup nobody has restored.
 *
 * Two deliberate choices:
 *
 *   - Actor identity is resolved here, not stored on the row. The log keeps
 *     ids; names and emails change, and an audit that recorded "Priya Sharma"
 *     would quietly rewrite itself when she changed her display name. The id is
 *     the fact; the name is a lookup.
 *
 *   - The per-content timeline merges four sources in the database rather than
 *     four round trips stitched together in TypeScript. It is one query, so the
 *     ordering is the database's and cannot disagree with itself.
 */

import { db } from "@greetings/db";
import { USER_ROLES } from "@greetings/db/schema";
import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest, notFound } from "../../lib/errors";
import { decodeCursor, encodeCursor } from "../../lib/pagination";
import { optionalEnum } from "../../lib/schema";
import { authGuard } from "../auth/session";

/** What a timeline entry can be. Mirrored in the OpenAPI description. */
const TIMELINE_KINDS = [
	"created",
	"submit",
	"approve",
	"reject",
	"remove",
	"restore",
	"hold",
	"reported",
	"report_resolved",
] as const;

interface TimelineRow {
	kind: (typeof TIMELINE_KINDS)[number];
	at: Date;
	actorId: string | null;
	actorName: string | null;
	actorEmail: string | null;
	actorRole: string | null;
	reason: string | null;
	note: string | null;
}

export function adminAuditRoutes() {
	return (
		new Elysia({ prefix: "/v1/admin" })
			.use(authGuard)

			.get(
				"/content/:id/audit",
				async ({ params }) => {
					const [item] = await db.execute(sql`
						SELECT
							c.id,
							c.title,
							c.status,
							c.visibility_hold      AS "visibilityHold",
							c.created_at           AS "createdAt",
							c.submitted_at         AS "submittedAt",
							c.published_at         AS "publishedAt",
							c.removed_at           AS "removedAt",
							c.rejection_reason     AS "rejectionReason",
							c.download_count       AS "downloadCount",
							c.designer_id          AS "designerId",
							d.name                 AS "designerName",
							d.email                AS "designerEmail",
							c.reviewed_at          AS "reviewedAt",
							c.reviewed_by          AS "reviewedById",
							r.name                 AS "reviewedByName"
						FROM content c
						JOIN "user" d ON d.id = c.designer_id
						LEFT JOIN "user" r ON r.id = c.reviewed_by
						WHERE c.id = ${params.id}
					`).then((result) => result.rows);

					if (!item) throw notFound("No such content.");

					// One query, four sources. Ordered by the database so the
					// timeline cannot disagree with itself across page loads.
					const timeline = await db.execute(sql`
						WITH entries AS (
							-- Creation is not a moderation action, but "who made this"
							-- is the first question anyone asks of an audit trail.
							SELECT
								'created'::text  AS kind,
								c.created_at     AS at,
								c.designer_id    AS actor_id,
								NULL::text       AS reason,
								NULL::text       AS note
							FROM content c
							WHERE c.id = ${params.id}

							UNION ALL

							SELECT
								ma.action::text,
								ma.created_at,
								ma.actor_id,
								ma.reason,
								NULL::text
							FROM moderation_actions ma
							WHERE ma.content_id = ${params.id}

							UNION ALL

							SELECT
								'reported'::text,
								rp.created_at,
								rp.reporter_id,
								rp.reason::text,
								rp.note
							FROM reports rp
							WHERE rp.content_id = ${params.id}

							UNION ALL

							SELECT
								'report_resolved'::text,
								rp.resolved_at,
								rp.resolved_by,
								rp.status::text,
								rp.resolution_note
							FROM reports rp
							WHERE rp.content_id = ${params.id}
								AND rp.resolved_at IS NOT NULL
						)
						SELECT
							e.kind,
							e.at,
							e.actor_id    AS "actorId",
							u.name        AS "actorName",
							u.email       AS "actorEmail",
							u.role::text  AS "actorRole",
							e.reason,
							e.note
						FROM entries e
						LEFT JOIN "user" u ON u.id = e.actor_id
						-- Newest first: an admin opening this is investigating what
						-- just happened, not reading a biography from the start.
						ORDER BY e.at DESC
					`).then((result) => result.rows as unknown as TimelineRow[]);

					return {
						content: item,
						timeline: timeline.map((row) => ({
							kind: row.kind,
							at: row.at,
							// Null actor is the system acting on its own — the automatic
							// hold once reports cross the threshold has no human behind it.
							actor: row.actorId
								? {
										id: row.actorId,
										name: row.actorName,
										email: row.actorEmail,
										role: row.actorRole,
									}
								: null,
							reason: row.reason,
							note: row.note,
						})),
					};
				},
				{
					requireRole: ["admin", "super_admin"],
					detail: {
						tags: ["Admin"],
						summary: "Everything that ever happened to one piece of content",
						description:
							"Merges creation, every lifecycle move, every report and every " +
							"report resolution into one timeline, newest first, with the " +
							"person behind each. `actor` is null where the system acted on " +
							"its own — currently only the automatic hold. Kinds: " +
							TIMELINE_KINDS.join(", ") +
							".",
					},
				},
			)

			.get(
				"/audit/roles",
				async ({ query }) => {
					const limit = query.limit ?? 50;
					const before = query.cursor ? decodeTimeCursor(query.cursor) : null;

					const rows = (
						await db.execute(sql`
							SELECT
								l.id,
								l.created_at    AS "at",
								l.from_role     AS "fromRole",
								l.to_role       AS "toRole",
								l.reason,
								l.actor_id      AS "actorId",
								a.name          AS "actorName",
								a.email         AS "actorEmail",
								l.target_user_id AS "targetId",
								tgt.name        AS "targetName",
								tgt.email       AS "targetEmail"
							FROM role_change_log l
							LEFT JOIN "user" a ON a.id = l.actor_id
							JOIN "user" tgt ON tgt.id = l.target_user_id
							${
								before
									? sql`WHERE (l.created_at, l.id) < (${before.at}::timestamp, ${before.id}::text)`
									: sql``
							}
							ORDER BY l.created_at DESC, l.id DESC
							LIMIT ${limit + 1}
						`)
					).rows as unknown as { id: string; at: Date }[];

					const page = rows.slice(0, limit);
					const last = page.at(-1);

					return {
						items: page,
						nextCursor:
							rows.length > limit && last
								? encodeCursor({
										t: new Date(last.at).toISOString(),
										i: last.id,
									})
								: null,
					};
				},
				{
					// Super admin only: this is the record of who handed out power,
					// and the only person who can hand it out should be the one
					// answerable for reading it.
					requireRole: ["super_admin"],
					query: t.Object({
						cursor: t.Optional(t.String()),
						limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
					}),
					detail: {
						tags: ["Admin"],
						summary: "Every role change ever made",
						description:
							"Newest first. `actor` is null for changes the system applied " +
							"itself: the bootstrap super admin from the seed script, and " +
							"role invites consumed at first sign-in.",
					},
				},
			)

			.get(
				"/audit/actions",
				async ({ query }) => {
					const limit = query.limit ?? 50;
					const before = query.cursor ? decodeTimeCursor(query.cursor) : null;

					const rows = (
						await db.execute(sql`
							SELECT
								ma.id,
								ma.created_at   AS "at",
								ma.action::text AS "action",
								ma.reason,
								ma.content_id   AS "contentId",
								c.title         AS "contentTitle",
								c.status::text  AS "contentStatus",
								ma.actor_id     AS "actorId",
								u.name          AS "actorName",
								u.role::text    AS "actorRole"
							FROM moderation_actions ma
							JOIN content c ON c.id = ma.content_id
							LEFT JOIN "user" u ON u.id = ma.actor_id
							WHERE (${query.action ?? null}::text IS NULL
							       OR ma.action::text = ${query.action ?? null}::text)
								AND (${query.actorId ?? null}::text IS NULL
								     OR ma.actor_id = ${query.actorId ?? null}::text)
								${
									before
										? sql`AND (ma.created_at, ma.id) < (${before.at}::timestamp, ${before.id}::text)`
										: sql``
								}
							ORDER BY ma.created_at DESC, ma.id DESC
							LIMIT ${limit + 1}
						`)
					).rows as unknown as { id: string; at: Date }[];

					const page = rows.slice(0, limit);
					const last = page.at(-1);

					return {
						items: page,
						nextCursor:
							rows.length > limit && last
								? encodeCursor({
										t: new Date(last.at).toISOString(),
										i: last.id,
									})
								: null,
					};
				},
				{
					requireRole: ["admin", "super_admin"],
					query: t.Object({
						action: optionalEnum(
							["submit", "approve", "reject", "remove", "restore", "hold"],
							{ description: "Filter to one kind of action" },
						),
						actorId: t.Optional(
							t.String({ description: "Filter to one moderator" }),
						),
						cursor: t.Optional(t.String()),
						limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
					}),
					detail: {
						tags: ["Admin"],
						summary: "Recent moderation activity across all content",
						description:
							"The platform-wide feed of approvals, rejections, removals and " +
							"holds. Filter by `actorId` to review one moderator's decisions.",
					},
				},
			)

			.get(
				"/users",
				async ({ query }) => {
					const limit = query.limit ?? 50;
					const term = query.q?.trim();

					const rows = await db.execute(sql`
						SELECT
							u.id,
							u.name,
							u.email,
							u.role::text            AS role,
							u.created_at            AS "createdAt",
							p.phone                 AS phone,
							p.region_code           AS "regionCode",
							p.onboarded_at          AS "onboardedAt",
							(SELECT COUNT(*)::int FROM content c WHERE c.designer_id = u.id)
								AS "contentCount",
							(SELECT MAX(l.created_at) FROM role_change_log l
								WHERE l.target_user_id = u.id)
								AS "roleChangedAt"
						FROM "user" u
						LEFT JOIN user_profiles p ON p.user_id = u.id
						WHERE (${query.role ?? null}::text IS NULL
						       OR u.role::text = ${query.role ?? null}::text)
							AND (${term ?? null}::text IS NULL
							     OR u.email ILIKE ${`%${term ?? ""}%`}
							     OR u.name ILIKE ${`%${term ?? ""}%`}
							     OR p.phone ILIKE ${`%${term ?? ""}%`})
						ORDER BY u.created_at DESC
						LIMIT ${limit}
					`);

					return rows.rows;
				},
				{
					requireRole: ["admin", "super_admin"],
					query: t.Object({
						q: t.Optional(
							t.String({
								maxLength: 100,
								description: "Match against name, email or phone",
							}),
						),
						role: optionalEnum(USER_ROLES, {
							description: "Filter to one role",
						}),
						limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
					}),
					detail: {
						tags: ["Admin"],
						summary: "Find a person, and see their role and content count",
						description:
							"Backs role assignment, which needs a way to find someone " +
							"before granting to them. Not paginated by cursor: this is a " +
							"lookup, and the answer to a search that returns hundreds of " +
							"people is a narrower search.",
					},
				},
			)
	);
}

/** Cursor for the two time-ordered audit feeds. */
function decodeTimeCursor(raw: string): { at: string; id: string } {
	const parsed = decodeCursor(raw);
	const at = parsed.t;
	const id = parsed.i;

	if (typeof at !== "string" || typeof id !== "string" || id.length === 0) {
		throw badRequest("Malformed cursor");
	}

	return { at, id };
}
