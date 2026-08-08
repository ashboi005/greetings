import { db } from "@greetings/db";
import { userLanguages, userProfiles } from "@greetings/db/schema";
import { eq } from "drizzle-orm";
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
export function feedRoutes() {
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
					items: page.map(toFeedItem),
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
						...toFeedItem(row),
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

async function loadPreferences(userId: string) {
	const [profile] = await db
		.select({ regionCode: userProfiles.regionCode })
		.from(userProfiles)
		.where(eq(userProfiles.userId, userId))
		.limit(1);

	const languages = await db
		.select({ code: userLanguages.languageCode })
		.from(userLanguages)
		.where(eq(userLanguages.userId, userId));

	return {
		regionCode: profile?.regionCode ?? null,
		languageCodes: languages.map((row) => row.code),
	};
}

function toFeedItem(row: {
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
}) {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		primaryLanguage: row.primaryLanguage,
		regionCode: row.regionCode,
		downloadCount: row.downloadCount,
		publishedAt: row.publishedAt,
		designer: { id: row.designerId, name: row.designerName },
		// The key, not a URL: bytes are only reachable through the tracked
		// download endpoint (spec §8), which is what keeps counts honest.
		storageKey: row.storageKey,
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
