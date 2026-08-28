import { db } from "@greetings/db";
import { sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest } from "../../lib/errors";
import {
	cursorTimestamp,
	decodeCursor,
	encodeCursor,
} from "../../lib/pagination";
import {
	errorResponse,
	feedResponse,
	searchResponse,
} from "../../lib/responses";
import { publicImageUrl } from "../../lib/storage";
import { authGuard, requireUser } from "../auth/session";
import { queryFeed, querySearch } from "./queries";
import { decodeFeedCursor, encodeFeedCursor } from "./ranking";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Feed and search for mobile users (spec §7).
 *
 * Both are available to any signed-in user. Designers and admins can call them
 * too — there is no reason to forbid it, and the mobile app is the only client
 * that will.
 */
export function feedRoutes(options: { publicBaseUrl?: string } = {}) {
	return new Elysia({ prefix: "/v1" })
		.use(authGuard)

		.get(
			"/feed",
			async ({ currentUser, query }) => {
				const user = requireUser(currentUser);
				const limit = query.limit ?? DEFAULT_LIMIT;

				const cursor = query.cursor ? decodeFeedCursor(query.cursor) : null;

				const { regionCode, languageCodes } = await loadPreferences(user.id);

				// One extra row tells us whether another page exists without a
				// second count query.
				const rows = await queryFeed({
					regionCode,
					languageCodes,
					limit: limit + 1,
					after: cursor ? { score: cursor.score, id: cursor.id } : undefined,
				});

				const page = rows.slice(0, limit);
				const last = page.at(-1);

				return {
					items: page.map((row) => toFeedItem(row, options.publicBaseUrl)),
					nextCursor:
						rows.length > limit && last
							? encodeFeedCursor({ score: last.score, id: last.id })
							: null,
				};
			},
			{
				requireRole: true,
				query: t.Object({
					cursor: t.Optional(t.String()),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_LIMIT })),
				}),
				response: { 200: feedResponse, 400: errorResponse, 401: errorResponse },
				detail: {
					tags: ["Feed"],
					summary: "Personalised feed of published content",
					description:
						"Ranked by the caller's languages and region, recency and recent " +
						"popularity, always mixed with global content. Pass `nextCursor` " +
						"back as `cursor` for the following page.",
				},
			},
		)

		.get(
			"/search",
			async ({ query }) => {
				const limit = query.limit ?? DEFAULT_LIMIT;
				const cursor = query.cursor
					? decodeSearchCursor(query.cursor)
					: undefined;

				const rows = await querySearch({
					query: query.q,
					tagIds: query.tags ? query.tags.split(",").filter(Boolean) : [],
					languageCode: query.language,
					regionCode: query.region,
					limit: limit + 1,
					after: cursor,
				});

				const page = rows.slice(0, limit);
				const last = page.at(-1);

				return {
					items: page.map(({ rank, ...row }) => ({
						...toFeedItem(row, options.publicBaseUrl),
						rank,
					})),
					nextCursor:
						rows.length > limit && last
							? encodeCursor({
									r: last.rank,
									p: new Date(last.publishedAt).toISOString(),
									i: last.id,
								})
							: null,
				};
			},
			{
				requireRole: true,
				query: t.Object({
					q: t.Optional(t.String({ maxLength: 100 })),
					tags: t.Optional(
						t.String({ description: "Comma-separated tag ids" }),
					),
					language: t.Optional(t.String({ minLength: 2 })),
					region: t.Optional(t.String({ minLength: 2 })),
					cursor: t.Optional(t.String()),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_LIMIT })),
				}),
				response: {
					200: searchResponse,
					400: errorResponse,
					401: errorResponse,
				},
				detail: {
					tags: ["Feed"],
					summary: "Search published content by title and tags",
					description:
						"Full-text match with a fuzzy fallback, so a misspelled query " +
						"still returns results. Omit `q` to browse by filters alone.",
				},
			},
		);
}

/**
 * The viewer's region and languages, in one round trip.
 *
 * These were two queries, which on the single busiest endpoint in the product
 * is two round trips and two connection checkouts for one answer. The outer
 * select is what guarantees a row even for someone who has never onboarded —
 * both joins then miss and the defaults below apply.
 */
async function loadPreferences(userId: string) {
	const result = await db.execute(sql`
		SELECT
			p.region_code AS "regionCode",
			COALESCE(
				array_agg(ul.language_code) FILTER (WHERE ul.language_code IS NOT NULL),
				'{}'
			) AS languages
		FROM (SELECT ${userId}::text AS uid) me
		LEFT JOIN user_profiles p ON p.user_id = me.uid
		LEFT JOIN user_languages ul ON ul.user_id = me.uid
		GROUP BY p.region_code
	`);

	const row = result.rows[0] as
		| { regionCode: string | null; languages: string[] }
		| undefined;

	return {
		regionCode: row?.regionCode ?? null,
		languageCodes: row?.languages ?? [],
	};
}

function toFeedItem(
	row: {
		id: string;
		title: string;
		description: string | null;
		primaryLanguage: string;
		regionCode: string | null;
		downloadCount: number;
		publishedAt: Date;
		designerId: string;
		designerName: string;
		storageKey: string | null;
	},
	publicBaseUrl: string | undefined,
) {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		primaryLanguage: row.primaryLanguage,
		regionCode: row.regionCode,
		downloadCount: row.downloadCount,
		publishedAt: row.publishedAt,
		designer: { id: row.designerId, name: row.designerName },
		// The key is kept because it is a stable cache key and useful in logs.
		storageKey: row.storageKey,
		// Built here rather than sent to the client as a base URL plus a key.
		// It costs nothing — string work, no signing, no network, no per-item
		// query — and it keeps the bucket layout a server detail, so moving
		// objects or changing the CDN host does not need an app release.
		//
		// This is for *display*. Saving an image still goes through the download
		// endpoint, which is what records it (spec §8).
		imageUrl: publicImageUrl(row.storageKey, publicBaseUrl),
	};
}

function decodeSearchCursor(raw: string) {
	const parsed = decodeCursor(raw);
	const rank = parsed.r;
	const id = parsed.i;

	if (
		typeof rank !== "number" ||
		!Number.isFinite(rank) ||
		typeof id !== "string" ||
		id.length === 0
	) {
		throw badRequest("Malformed cursor");
	}

	// Validated rather than passed straight through: it is bound into a
	// ::timestamp cast, and a string Postgres cannot parse would surface as a
	// 500 rather than the 400 a tampered cursor deserves.
	return { rank, publishedAt: cursorTimestamp(parsed.p), id };
}
