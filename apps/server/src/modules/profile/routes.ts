import { db } from "@greetings/db";
import { languages, regions, TAG_CATEGORIES, tags } from "@greetings/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest, notFound } from "../../lib/errors";
import {
	cachedReference,
	REFERENCE_CACHE_CONTROL,
} from "../../lib/reference-cache";
import {
	errorResponse,
	languageListResponse,
	okResponse,
	profileResponse,
	regionListResponse,
	tagListResponse,
} from "../../lib/responses";
import { optionalEnum } from "../../lib/schema";
import { authGuard, requireUser } from "../auth/session";

/**
 * Profile and onboarding (spec §4.2).
 *
 * Onboarding is not cosmetic: the region chosen here is stamped onto every
 * download event for analytics, and both region and languages drive feed
 * ranking. A user without a region gets only global content.
 */
export function profileRoutes() {
	return new Elysia({ prefix: "/v1" })
		.use(authGuard)
		.get(
			"/regions",
			({ set }) => {
				set.headers["cache-control"] = REFERENCE_CACHE_CONTROL;
				// Key is "regions:active", not "regions": the validation helper below
				// caches the *unfiltered* list under its own key. Two loaders sharing
				// one key means whichever runs first wins, and the losing caller
				// silently gets the other's rows — here that would have leaked
				// retired regions into the public picker.
				return cachedReference("regions:active", () =>
					db
						.select({ code: regions.code, name: regions.name })
						.from(regions)
						// Retired regions stay in the table because history references
						// them, but they must not appear in an onboarding picker.
						.where(eq(regions.isActive, true))
						.orderBy(asc(regions.name)),
				);
			},
			{
				response: { 200: regionListResponse },
				detail: {
					tags: ["Reference"],
					summary: "Indian states and union territories",
				},
			},
		)
		.get(
			"/languages",
			({ set }) => {
				set.headers["cache-control"] = REFERENCE_CACHE_CONTROL;
				// "languages:active" for the same reason as regions above.
				return cachedReference("languages:active", () =>
					db
						.select({
							code: languages.code,
							name: languages.name,
							nativeName: languages.nativeName,
						})
						.from(languages)
						.where(eq(languages.isActive, true))
						.orderBy(asc(languages.name)),
				);
			},
			{
				response: { 200: languageListResponse },
				detail: { tags: ["Reference"], summary: "Supported languages" },
			},
		)
		.get(
			"/tags",
			async ({ query, set }) => {
				set.headers["cache-control"] = REFERENCE_CACHE_CONTROL;

				// Cached whole and filtered in memory. There are 38 tags; a cache
				// entry per category would be four times the bookkeeping to avoid
				// filtering an array that fits in a cache line or two.
				const all = await cachedReference("tags", () =>
					db
						.select({
							id: tags.id,
							slug: tags.slug,
							label: tags.label,
							category: tags.category,
						})
						.from(tags)
						.where(eq(tags.isActive, true))
						.orderBy(asc(tags.category), asc(tags.label)),
				);

				return query.category
					? all.filter((tag) => tag.category === query.category)
					: all;
			},
			{
				query: t.Object({
					category: optionalEnum(TAG_CATEGORIES),
				}),
				response: { 200: tagListResponse },
				detail: {
					tags: ["Reference"],
					summary: "Tags designers may apply and users may filter by",
				},
			},
		)
		.get(
			"/me/profile",
			async ({ currentUser }) => {
				const userId = requireUser(currentUser).id;

				// One round trip, not two. The outer select guarantees a row even
				// for someone who has never onboarded, so the joins simply miss and
				// the defaults below apply.
				const result = await db.execute(sql`
					SELECT
						p.display_name  AS "displayName",
						p.phone         AS phone,
						p.region_code   AS "regionCode",
						p.onboarded_at  AS "onboardedAt",
						COALESCE(
							array_agg(ul.language_code) FILTER (WHERE ul.language_code IS NOT NULL),
							'{}'
						) AS languages
					FROM (SELECT ${userId}::text AS uid) me
					LEFT JOIN user_profiles p ON p.user_id = me.uid
					LEFT JOIN user_languages ul ON ul.user_id = me.uid
					GROUP BY p.display_name, p.phone, p.region_code, p.onboarded_at
				`);

				const row = result.rows[0] as
					| {
							displayName: string | null;
							phone: string | null;
							regionCode: string | null;
							onboardedAt: Date | null;
							languages: string[];
					  }
					| undefined;

				return {
					displayName: row?.displayName ?? null,
					phone: row?.phone ?? null,
					regionCode: row?.regionCode ?? null,
					languages: row?.languages ?? [],
					onboarded: Boolean(row?.onboardedAt),
				};
			},
			{
				requireRole: true,
				response: { 200: profileResponse, 401: errorResponse },
				detail: { tags: ["Profile"], summary: "The caller's own profile" },
			},
		)
		.put(
			"/me/profile",
			async ({ currentUser, body }) => {
				const userId = requireUser(currentUser).id;

				// Validated against the reference cache rather than the database:
				// these are two lists of a few dozen rows that this process already
				// holds, so checking them costs nothing and still names exactly what
				// was wrong — which a foreign-key violation would not.
				await assertRegionExists(body.regionCode);
				await assertLanguagesExist(body.languages);

				const now = new Date();
				const chosen = [...new Set(body.languages)];

				// One statement for the whole write. Data-modifying CTEs run inside
				// a single implicit transaction, so this is as atomic as the explicit
				// BEGIN/COMMIT it replaces while costing one round trip instead of
				// five — and onboarding is a path every single user walks once.
				//
				// The insert and the delete touch disjoint rows on purpose: adding
				// the new set with DO NOTHING and then removing anything outside it
				// avoids deleting and re-inserting the same key in one statement,
				// which is the case Postgres does not define cleanly.
				await db.execute(sql`
					WITH upserted AS (
						INSERT INTO user_profiles
							(user_id, display_name, region_code, onboarded_at, created_at, updated_at)
						VALUES (
							${userId},
							${body.displayName ?? null},
							${body.regionCode},
							${now},
							${now},
							${now}
						)
						ON CONFLICT (user_id) DO UPDATE SET
							display_name = EXCLUDED.display_name,
							region_code  = EXCLUDED.region_code,
							-- Keep the first onboarding timestamp: later edits are
							-- profile changes, not a second onboarding.
							onboarded_at = COALESCE(user_profiles.onboarded_at, EXCLUDED.onboarded_at),
							updated_at   = EXCLUDED.updated_at
					),
					added AS (
						INSERT INTO user_languages (user_id, language_code)
						SELECT ${userId}, code FROM unnest(${sql.param(chosen)}::text[]) AS code
						ON CONFLICT DO NOTHING
					)
					DELETE FROM user_languages
					WHERE user_id = ${userId}
						AND language_code <> ALL(${sql.param(chosen)}::text[])
				`);

				return { ok: true as const };
			},
			{
				requireRole: true,
				body: t.Object({
					displayName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
					regionCode: t.String({
						minLength: 2,
						description: "Region code from GET /v1/regions",
					}),
					languages: t.Array(t.String({ minLength: 2 }), {
						minItems: 1,
						maxItems: 10,
						description: "Preferred language codes from GET /v1/languages",
					}),
				}),
				response: {
					200: okResponse,
					400: errorResponse,
					401: errorResponse,
					404: errorResponse,
				},
				detail: {
					tags: ["Profile"],
					summary: "Complete or update onboarding",
					description:
						"Sets the region and preferred languages that drive feed ranking " +
						"and download analytics.",
				},
			},
		);
}

/**
 * Reference lookups, served from the same cache the endpoints use.
 *
 * These used to be a query each on the way in to every profile write. They are
 * two lists of a few dozen rows that never change; holding them costs a few
 * kilobytes and removes two round trips from the path every user walks once.
 */
/**
 * Every code that exists, retired ones included.
 *
 * Deliberately unfiltered, and deliberately under a different cache key from the
 * public lists. Validation and display want different answers: a picker must not
 * offer a retired region, but someone whose region was retired after they chose
 * it must still be able to save their profile. Rejecting their existing code
 * would lock them out of editing their own display name.
 */
export async function knownRegionCodes(): Promise<Set<string>> {
	const rows = await cachedReference("regions:all", () =>
		db.select({ code: regions.code }).from(regions),
	);
	return new Set(rows.map((row) => row.code));
}

/** Every language code, retired included — see knownRegionCodes. */
export async function knownLanguageCodes(): Promise<Set<string>> {
	const rows = await cachedReference("languages:all", () =>
		db.select({ code: languages.code }).from(languages),
	);
	return new Set(rows.map((row) => row.code));
}

async function assertRegionExists(code: string): Promise<void> {
	if (!(await knownRegionCodes()).has(code)) {
		throw notFound(`Unknown region: ${code}`);
	}
}

async function assertLanguagesExist(codes: string[]): Promise<void> {
	const known = await knownLanguageCodes();
	const missing = [...new Set(codes)].filter((code) => !known.has(code));

	if (missing.length > 0) {
		throw badRequest(`Unknown language codes: ${missing.join(", ")}`);
	}
}
