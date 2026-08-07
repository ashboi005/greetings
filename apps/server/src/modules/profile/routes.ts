import { db } from "@greetings/db";
import {
	languages,
	regions,
	TAG_CATEGORIES,
	tags,
	userLanguages,
	userProfiles,
} from "@greetings/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { badRequest, notFound } from "../../lib/errors";
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
			() =>
				db
					.select({ code: regions.code, name: regions.name })
					.from(regions)
					.orderBy(asc(regions.name)),
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
			() =>
				db
					.select({
						code: languages.code,
						name: languages.name,
						nativeName: languages.nativeName,
					})
					.from(languages)
					.orderBy(asc(languages.name)),
			{
				response: { 200: languageListResponse },
				detail: { tags: ["Reference"], summary: "Supported languages" },
			},
		)
		.get(
			"/tags",
			({ query }) =>
				db
					.select({
						id: tags.id,
						slug: tags.slug,
						label: tags.label,
						category: tags.category,
					})
					.from(tags)
					.where(
						query.category
							? and(eq(tags.isActive, true), eq(tags.category, query.category))
							: eq(tags.isActive, true),
					)
					.orderBy(asc(tags.category), asc(tags.label)),
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

				const [profile] = await db
					.select({
						displayName: userProfiles.displayName,
						phone: userProfiles.phone,
						regionCode: userProfiles.regionCode,
						onboardedAt: userProfiles.onboardedAt,
					})
					.from(userProfiles)
					.where(eq(userProfiles.userId, userId))
					.limit(1);

				const chosen = await db
					.select({ code: userLanguages.languageCode })
					.from(userLanguages)
					.where(eq(userLanguages.userId, userId));

				return {
					displayName: profile?.displayName ?? null,
					phone: profile?.phone ?? null,
					regionCode: profile?.regionCode ?? null,
					languages: chosen.map((c) => c.code),
					onboarded: Boolean(profile?.onboardedAt),
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

				await assertRegionExists(body.regionCode);
				await assertLanguagesExist(body.languages);

				const now = new Date();

				await db.transaction(async (tx) => {
					await tx
						.insert(userProfiles)
						.values({
							userId,
							displayName: body.displayName,
							regionCode: body.regionCode,
							onboardedAt: now,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: userProfiles.userId,
							set: {
								displayName: body.displayName,
								regionCode: body.regionCode,
								// Keep the first onboarding timestamp: later edits are
								// profile changes, not a second onboarding.
								onboardedAt: sql`coalesce(${userProfiles.onboardedAt}, ${now})`,
								updatedAt: now,
							},
						});

					// Replace wholesale: the client always sends the complete set,
					// so a diff would be more code for the same result.
					await tx
						.delete(userLanguages)
						.where(eq(userLanguages.userId, userId));
					await tx.insert(userLanguages).values(
						body.languages.map((code) => ({
							userId,
							languageCode: code,
						})),
					);
				});

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

async function assertRegionExists(code: string): Promise<void> {
	const [row] = await db
		.select({ code: regions.code })
		.from(regions)
		.where(eq(regions.code, code))
		.limit(1);
	if (!row) throw notFound(`Unknown region: ${code}`);
}

async function assertLanguagesExist(codes: string[]): Promise<void> {
	const unique = [...new Set(codes)];
	const found = await db
		.select({ code: languages.code })
		.from(languages)
		.where(inArray(languages.code, unique));

	if (found.length !== unique.length) {
		const known = new Set(found.map((f) => f.code));
		const missing = unique.filter((c) => !known.has(c));
		throw badRequest(`Unknown language codes: ${missing.join(", ")}`);
	}
}
