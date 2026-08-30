/**
 * The user's own download history (spec §16).
 *
 * `download_events` has always recorded this; nothing read it back for the
 * person who did the downloading. The profile screen needs it, and it is the
 * one place a reader sees their own activity.
 *
 * Grouped by content rather than listed as raw events. A history screen that
 * shows the same image five times because someone re-shared it is noise, and
 * "when did I last take this" is the question the screen answers. Per-user
 * volume is hundreds of rows, so grouping costs nothing — this is not the
 * platform-wide analytics path, which reads pre-aggregated tables instead.
 */

import { db } from "@greetings/db";
import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
	cursorTimestamp,
	decodeCursor,
	encodeCursor,
} from "../../lib/pagination";
import { publicImageUrl } from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface HistoryRow {
	id: string;
	title: string;
	storageKey: string | null;
	designerId: string;
	designerName: string;
	lastDownloadedAt: Date;
	timesDownloaded: number;
}

export function downloadHistoryRoutes(
	options: { publicBaseUrl?: string } = {},
) {
	return new Elysia({ prefix: "/v1/me" }).use(authGuard).get(
		"/downloads",
		async ({ currentUser, query }) => {
			const user = requireUser(currentUser);
			const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

			const cursor = query.cursor ? decodeCursor(query.cursor) : null;
			const after = cursor
				? { at: cursorTimestamp(cursor.t), id: String(cursor.i ?? "") }
				: null;

			// The cursor predicate is a HAVING, not a WHERE: it compares against
			// MAX(created_at), which does not exist until after grouping. Row-value
			// comparison keeps the tiebreak on id exact, so two items downloaded in
			// the same millisecond cannot repeat or vanish across a page boundary.
			//
			// Reads the (user_id, created_at) index added alongside this endpoint.
			// Without it this is a sequential scan of the largest table in the
			// database, which is fine at one user and ruinous at a hundred thousand.
			const rows = await db.execute(sql`
				SELECT
					c.id                     AS id,
					c.title                  AS title,
					c.primary_asset_key      AS "storageKey",
					c.designer_id            AS "designerId",
					u.name                   AS "designerName",
					MAX(de.created_at)       AS "lastDownloadedAt",
					COUNT(*)::int            AS "timesDownloaded"
				FROM download_events de
				JOIN content c ON c.id = de.content_id
				JOIN "user" u ON u.id = c.designer_id
				WHERE de.user_id = ${user.id}
				GROUP BY c.id, c.title, c.primary_asset_key, c.designer_id, u.name
				${
					after
						? sql`HAVING (MAX(de.created_at), c.id) < (${after.at}::timestamp, ${after.id}::text)`
						: sql``
				}
				ORDER BY "lastDownloadedAt" DESC, c.id DESC
				LIMIT ${limit + 1}
			`);

			const all = rows.rows as unknown as HistoryRow[];
			const page = all.slice(0, limit);
			const last = page.at(-1);

			return {
				items: page.map((row) => ({
					id: row.id,
					title: row.title,
					designer: { id: row.designerId, name: row.designerName },
					imageUrl: publicImageUrl(row.storageKey, options.publicBaseUrl),
					lastDownloadedAt: new Date(row.lastDownloadedAt).toISOString(),
					timesDownloaded: Number(row.timesDownloaded),
				})),
				nextCursor:
					all.length > limit && last
						? encodeCursor({
								t: new Date(last.lastDownloadedAt).toISOString(),
								i: last.id,
							})
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
					items: t.Array(
						t.Object({
							id: t.String(),
							title: t.String(),
							designer: t.Object({ id: t.String(), name: t.String() }),
							imageUrl: t.Union([t.String(), t.Null()]),
							lastDownloadedAt: t.String(),
							timesDownloaded: t.Integer(),
						}),
					),
					nextCursor: t.Union([t.String(), t.Null()]),
				}),
			},
			detail: {
				tags: ["Profile"],
				summary: "Images this user has downloaded, most recent first",
				description:
					"One entry per image, not per download — `timesDownloaded` says how " +
					"often. Removed content still appears: it is the user's own history, " +
					"and a gap would be stranger than an entry.",
			},
		},
	);
}
