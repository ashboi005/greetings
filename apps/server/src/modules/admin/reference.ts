/**
 * Taxonomy management for admins (spec §4.6).
 *
 * Tags, languages and regions were seed-only: adding a festival meant a deploy.
 * That is wrong for the one part of the data model that is genuinely editorial —
 * the tag list is how designers describe content and how readers filter it, and
 * it should move when the calendar does, not when someone runs a script.
 *
 * Three properties hold across everything here:
 *
 * 1. **Retire, do not delete.** Every one of these rows is referenced by content
 *    or by analytics history. Deleting is allowed only when nothing points at
 *    the row; otherwise the answer is `isActive: false`, which hides it from the
 *    pickers and the public lists while leaving history intact.
 * 2. **Every change is logged.** `reference_change_log` records who changed what,
 *    with the whole row before and after. Renaming a tag changes what thousands
 *    of posts appear to be about, so it belongs on the record.
 * 3. **The read cache is dropped on write.** Public reference endpoints are
 *    cached for a minute in process; without invalidation an admin would edit a
 *    tag and watch nothing happen, which reads as a broken save.
 *
 * These routes deliberately serve uncached, unfiltered data — including inactive
 * rows — because an editor has to see what they are editing. The public
 * endpoints in modules/profile stay cached and active-only.
 */

import { db } from "@greetings/db";
import {
	content,
	contentTags,
	languages,
	REFERENCE_ENTITIES,
	referenceChangeLog,
	regions,
	TAG_CATEGORIES,
	tags,
	type UserRole,
	userLanguages,
	userProfiles,
} from "@greetings/db/schema";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import {
	badRequest,
	conflict,
	isForeignKeyViolation,
	isUniqueViolation,
	notFound,
} from "../../lib/errors";
import { clearReferenceCache } from "../../lib/reference-cache";
import { optionalEnum } from "../../lib/schema";
import { authGuard, requireUser } from "../auth/session";

/** Curating the taxonomy is a content job, so admins do it, not only super admins. */
const CURATORS: UserRole[] = ["admin", "super_admin"];

/**
 * Lowercase, hyphen-separated, no leading or trailing hyphen.
 *
 * Slugs are the stable human-readable handle for a tag. Nothing filters by them
 * today — the feed matches on tag id — but they end up in URLs and in the
 * designer's mental model, so they are held to a shape rather than free text.
 */
const SLUG_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

/** ISO 639-1 where one exists, or a longer lowercase code where it does not. */
const LANGUAGE_CODE_PATTERN = "^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$";

/** ISO 3166-2:IN style, e.g. `IN-MH`. */
const REGION_CODE_PATTERN = "^[A-Z]{2}-[A-Z0-9]{2,3}$";

type Curator = { id: string };

/**
 * Records a taxonomy change.
 *
 * Takes the transaction so the log entry and the change commit together: a
 * rename that succeeded without a log entry, or a log entry for a rename that
 * rolled back, are both worse than no log at all.
 */
async function logChange(
	tx: Pick<typeof db, "insert">,
	entry: {
		actor: Curator;
		entity: "tag" | "language" | "region";
		entityKey: string;
		action: "create" | "update" | "activate" | "deactivate" | "delete";
		before?: unknown;
		after?: unknown;
	},
): Promise<void> {
	await tx.insert(referenceChangeLog).values({
		id: crypto.randomUUID(),
		actorId: entry.actor.id,
		entity: entry.entity,
		entityKey: entry.entityKey,
		action: entry.action,
		before: entry.before ?? null,
		after: entry.after ?? null,
		createdAt: new Date(),
	});
}

/**
 * Which `action` an update should be logged as.
 *
 * An activation or a retirement is the change an auditor scans for, so it gets
 * its own verb instead of hiding inside a generic "update" alongside a typo fix.
 */
function actionFor(
	wasActive: boolean,
	isActive: boolean,
): "update" | "activate" | "deactivate" {
	if (wasActive === isActive) return "update";
	return isActive ? "activate" : "deactivate";
}

/** Rejects a PATCH that would change nothing. */
function requireSomeField(body: object): void {
	const provided = Object.values(body).filter((v) => v !== undefined);
	if (provided.length === 0) {
		throw badRequest("Provide at least one field to change.");
	}
}

const tagRow = t.Object({
	id: t.String(),
	slug: t.String(),
	label: t.String(),
	category: t.UnionEnum(TAG_CATEGORIES),
	isActive: t.Boolean(),
	/** How many content items carry this tag, published or not. */
	usageCount: t.Integer(),
});

const languageRow = t.Object({
	code: t.String(),
	name: t.String(),
	nativeName: t.String(),
	isActive: t.Boolean(),
	/** Content items authored in this language. */
	contentCount: t.Integer(),
});

const regionRow = t.Object({
	code: t.String(),
	name: t.String(),
	isActive: t.Boolean(),
	/** Content items targeted at this region. Global content counts for none. */
	contentCount: t.Integer(),
});

export function adminReferenceRoutes() {
	return (
		new Elysia({ prefix: "/v1/admin/reference" })
			.use(authGuard)

			// ---------------------------------------------------------------- tags

			.get(
				"/tags",
				async () => {
					// Left join so a tag nobody has used yet still appears, with zero.
					// An inner join would hide exactly the tags an editor most wants to
					// review after adding them.
					const rows = await db
						.select({
							id: tags.id,
							slug: tags.slug,
							label: tags.label,
							category: tags.category,
							isActive: tags.isActive,
							usageCount: count(contentTags.contentId),
						})
						.from(tags)
						.leftJoin(contentTags, eq(contentTags.tagId, tags.id))
						.groupBy(
							tags.id,
							tags.slug,
							tags.label,
							tags.category,
							tags.isActive,
						)
						.orderBy(asc(tags.category), asc(tags.label));

					return rows.map((row) => ({
						...row,
						usageCount: Number(row.usageCount),
					}));
				},
				{
					requireRole: CURATORS,
					response: { 200: t.Array(tagRow) },
					detail: {
						tags: ["Admin"],
						summary: "Every tag, including retired ones, with usage counts",
						description:
							"Uncached and unfiltered, unlike the public GET /v1/tags: an " +
							"editor needs to see retired tags to bring them back.",
					},
				},
			)

			.post(
				"/tags",
				async ({ currentUser, body }) => {
					const actor = requireUser(currentUser);
					const id = crypto.randomUUID();

					const row = {
						id,
						slug: body.slug,
						label: body.label,
						category: body.category,
						isActive: body.isActive ?? true,
					};

					try {
						await db.transaction(async (tx) => {
							await tx.insert(tags).values({ ...row, createdAt: new Date() });
							await logChange(tx, {
								actor,
								entity: "tag",
								entityKey: id,
								action: "create",
								after: row,
							});
						});
					} catch (cause) {
						if (isUniqueViolation(cause)) {
							throw conflict(
								`A tag with the slug "${body.slug}" already exists. If it is retired, reactivate it instead.`,
							);
						}
						throw cause;
					}

					clearReferenceCache();
					return { ...row, usageCount: 0 };
				},
				{
					requireRole: CURATORS,
					body: t.Object({
						slug: t.String({
							pattern: SLUG_PATTERN,
							minLength: 1,
							maxLength: 64,
							description: "Lowercase and hyphenated, e.g. happy-diwali",
						}),
						label: t.String({ minLength: 1, maxLength: 80 }),
						category: t.UnionEnum(TAG_CATEGORIES),
						isActive: t.Optional(t.Boolean()),
					}),
					response: { 200: tagRow },
					detail: { tags: ["Admin"], summary: "Create a tag" },
				},
			)

			.patch(
				"/tags/:id",
				async ({ currentUser, params, body }) => {
					const actor = requireUser(currentUser);
					requireSomeField(body);

					const updated = await db
						.transaction(async (tx) => {
							// Locked for the duration, so two admins editing the same tag
							// cannot interleave into a log that shows an impossible history —
							// the same reason the content edit path takes a row lock.
							const [before] = await tx
								.select()
								.from(tags)
								.where(eq(tags.id, params.id))
								.limit(1)
								.for("update");

							if (!before) throw notFound("No such tag.");

							const after = {
								id: before.id,
								slug: body.slug ?? before.slug,
								label: body.label ?? before.label,
								category: body.category ?? before.category,
								isActive: body.isActive ?? before.isActive,
							};

							await tx
								.update(tags)
								.set({
									slug: after.slug,
									label: after.label,
									category: after.category,
									isActive: after.isActive,
								})
								.where(eq(tags.id, params.id));

							await logChange(tx, {
								actor,
								entity: "tag",
								entityKey: params.id,
								action: actionFor(before.isActive, after.isActive),
								before: {
									id: before.id,
									slug: before.slug,
									label: before.label,
									category: before.category,
									isActive: before.isActive,
								},
								after,
							});

							return after;
						})
						.catch((cause: unknown) => {
							if (isUniqueViolation(cause)) {
								throw conflict("Another tag already uses that slug.");
							}
							throw cause;
						});

					clearReferenceCache();

					const [{ used } = { used: 0 }] = await db
						.select({ used: count() })
						.from(contentTags)
						.where(eq(contentTags.tagId, params.id));

					return { ...updated, usageCount: Number(used) };
				},
				{
					requireRole: CURATORS,
					params: t.Object({ id: t.String() }),
					body: t.Object({
						slug: t.Optional(
							t.String({ pattern: SLUG_PATTERN, minLength: 1, maxLength: 64 }),
						),
						label: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
						// optionalEnum, not t.Optional(t.UnionEnum(...)): the latter
						// resolves an absent value to the first member. Here that meant a
						// request changing only the label arrived carrying
						// `category: "festival"`, and silently recategorised the tag.
						category: optionalEnum(TAG_CATEGORIES),
						isActive: t.Optional(t.Boolean()),
					}),
					response: { 200: tagRow },
					detail: {
						tags: ["Admin"],
						summary: "Rename, recategorise, or retire a tag",
						description:
							"Setting isActive false removes the tag from the public list and " +
							"from designer pickers. Content already carrying it keeps it.",
					},
				},
			)

			.delete(
				"/tags/:id",
				async ({ currentUser, params }) => {
					const actor = requireUser(currentUser);

					await db.transaction(async (tx) => {
						const [before] = await tx
							.select()
							.from(tags)
							.where(eq(tags.id, params.id))
							.limit(1)
							.for("update");

						if (!before) throw notFound("No such tag.");

						// This count is load-bearing, not a nicety. `content_tags.tag_id`
						// is ON DELETE CASCADE, so Postgres would not refuse this delete —
						// it would quietly strip the tag from every post that had it. The
						// row lock above plus this check inside the transaction is what
						// makes refusing reliable.
						const [{ used } = { used: 0 }] = await tx
							.select({ used: count() })
							.from(contentTags)
							.where(eq(contentTags.tagId, params.id));

						if (Number(used) > 0) {
							throw conflict(
								`This tag is on ${used} item${Number(used) === 1 ? "" : "s"}. Retire it instead of deleting, so those items keep their history.`,
								{ usageCount: Number(used) },
							);
						}

						await tx.delete(tags).where(eq(tags.id, params.id));
						await logChange(tx, {
							actor,
							entity: "tag",
							entityKey: params.id,
							action: "delete",
							before: {
								id: before.id,
								slug: before.slug,
								label: before.label,
								category: before.category,
								isActive: before.isActive,
							},
						});
					});

					clearReferenceCache();
					return { ok: true as const };
				},
				{
					requireRole: CURATORS,
					params: t.Object({ id: t.String() }),
					response: { 200: t.Object({ ok: t.Boolean() }) },
					detail: {
						tags: ["Admin"],
						summary: "Delete an unused tag",
						description:
							"Refused with 409 once any content carries the tag. Correcting a " +
							"just-created mistake is the case this exists for.",
					},
				},
			)

			// ----------------------------------------------------------- languages

			.get(
				"/languages",
				async () => {
					const rows = await db
						.select({
							code: languages.code,
							name: languages.name,
							nativeName: languages.nativeName,
							isActive: languages.isActive,
							contentCount: count(content.id),
						})
						.from(languages)
						.leftJoin(content, eq(content.primaryLanguage, languages.code))
						.groupBy(
							languages.code,
							languages.name,
							languages.nativeName,
							languages.isActive,
						)
						.orderBy(asc(languages.name));

					return rows.map((row) => ({
						...row,
						contentCount: Number(row.contentCount),
					}));
				},
				{
					requireRole: CURATORS,
					response: { 200: t.Array(languageRow) },
					detail: {
						tags: ["Admin"],
						summary: "Every language, including retired ones",
					},
				},
			)

			.post(
				"/languages",
				async ({ currentUser, body }) => {
					const actor = requireUser(currentUser);
					const row = {
						code: body.code,
						name: body.name,
						nativeName: body.nativeName,
						isActive: body.isActive ?? true,
					};

					try {
						await db.transaction(async (tx) => {
							await tx.insert(languages).values(row);
							await logChange(tx, {
								actor,
								entity: "language",
								entityKey: row.code,
								action: "create",
								after: row,
							});
						});
					} catch (cause) {
						if (isUniqueViolation(cause)) {
							throw conflict(
								`Language "${body.code}" already exists. If it is retired, reactivate it instead.`,
							);
						}
						throw cause;
					}

					clearReferenceCache();
					return { ...row, contentCount: 0 };
				},
				{
					requireRole: CURATORS,
					body: t.Object({
						code: t.String({
							pattern: LANGUAGE_CODE_PATTERN,
							description: "ISO 639-1 where one exists, e.g. hi, mr, ta",
						}),
						name: t.String({ minLength: 1, maxLength: 80 }),
						nativeName: t.String({
							minLength: 1,
							maxLength: 80,
							description: "The name as its own speakers write it, e.g. हिन्दी",
						}),
						isActive: t.Optional(t.Boolean()),
					}),
					response: { 200: languageRow },
					detail: { tags: ["Admin"], summary: "Add a language" },
				},
			)

			.patch(
				"/languages/:code",
				async ({ currentUser, params, body }) => {
					const actor = requireUser(currentUser);
					requireSomeField(body);

					const updated = await db.transaction(async (tx) => {
						const [before] = await tx
							.select()
							.from(languages)
							.where(eq(languages.code, params.code))
							.limit(1)
							.for("update");

						if (!before) throw notFound("No such language.");

						const after = {
							code: before.code,
							name: body.name ?? before.name,
							nativeName: body.nativeName ?? before.nativeName,
							isActive: body.isActive ?? before.isActive,
						};

						await tx
							.update(languages)
							.set({
								name: after.name,
								nativeName: after.nativeName,
								isActive: after.isActive,
							})
							.where(eq(languages.code, params.code));

						await logChange(tx, {
							actor,
							entity: "language",
							entityKey: params.code,
							action: actionFor(before.isActive, after.isActive),
							before,
							after,
						});

						return after;
					});

					clearReferenceCache();

					const [{ used } = { used: 0 }] = await db
						.select({ used: count() })
						.from(content)
						.where(eq(content.primaryLanguage, params.code));

					return { ...updated, contentCount: Number(used) };
				},
				{
					requireRole: CURATORS,
					params: t.Object({ code: t.String() }),
					body: t.Object({
						name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
						nativeName: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
						isActive: t.Optional(t.Boolean()),
					}),
					response: { 200: languageRow },
					detail: {
						tags: ["Admin"],
						summary: "Rename or retire a language",
						description:
							"The code is immutable: content and user preferences reference it, " +
							"so changing it would orphan them. Retire and add instead.",
					},
				},
			)

			.delete(
				"/languages/:code",
				async ({ currentUser, params }) => {
					const actor = requireUser(currentUser);

					try {
						await db.transaction(async (tx) => {
							const [before] = await tx
								.select()
								.from(languages)
								.where(eq(languages.code, params.code))
								.limit(1)
								.for("update");

							if (!before) throw notFound("No such language.");

							// Unlike tags, both referencing tables restrict rather than
							// cascade, so the delete below fails on its own if anything
							// points here. Checking first only buys a better message.
							const [{ used } = { used: 0 }] = await tx
								.select({ used: count() })
								.from(content)
								.where(eq(content.primaryLanguage, params.code));

							const [{ prefs } = { prefs: 0 }] = await tx
								.select({ prefs: count() })
								.from(userLanguages)
								.where(eq(userLanguages.languageCode, params.code));

							if (Number(used) > 0 || Number(prefs) > 0) {
								throw conflict(
									`This language is used by ${used} content item${Number(used) === 1 ? "" : "s"} and ${prefs} user preference${Number(prefs) === 1 ? "" : "s"}. Retire it instead.`,
									{ contentCount: Number(used), userCount: Number(prefs) },
								);
							}

							await tx.delete(languages).where(eq(languages.code, params.code));
							await logChange(tx, {
								actor,
								entity: "language",
								entityKey: params.code,
								action: "delete",
								before,
							});
						});
					} catch (cause) {
						if (isForeignKeyViolation(cause)) {
							throw conflict(
								"Something still references this language. Retire it instead of deleting.",
							);
						}
						throw cause;
					}

					clearReferenceCache();
					return { ok: true as const };
				},
				{
					requireRole: CURATORS,
					params: t.Object({ code: t.String() }),
					response: { 200: t.Object({ ok: t.Boolean() }) },
					detail: { tags: ["Admin"], summary: "Delete an unused language" },
				},
			)

			// ------------------------------------------------------------- regions

			.get(
				"/regions",
				async () => {
					const rows = await db
						.select({
							code: regions.code,
							name: regions.name,
							isActive: regions.isActive,
							contentCount: count(content.id),
						})
						.from(regions)
						.leftJoin(content, eq(content.regionCode, regions.code))
						.groupBy(regions.code, regions.name, regions.isActive)
						.orderBy(asc(regions.name));

					return rows.map((row) => ({
						...row,
						contentCount: Number(row.contentCount),
					}));
				},
				{
					requireRole: CURATORS,
					response: { 200: t.Array(regionRow) },
					detail: {
						tags: ["Admin"],
						summary: "Every region, including retired ones",
					},
				},
			)

			.post(
				"/regions",
				async ({ currentUser, body }) => {
					const actor = requireUser(currentUser);
					const row = {
						code: body.code,
						name: body.name,
						isActive: body.isActive ?? true,
					};

					try {
						await db.transaction(async (tx) => {
							await tx.insert(regions).values(row);
							await logChange(tx, {
								actor,
								entity: "region",
								entityKey: row.code,
								action: "create",
								after: row,
							});
						});
					} catch (cause) {
						if (isUniqueViolation(cause)) {
							throw conflict(
								`Region "${body.code}" already exists. If it is retired, reactivate it instead.`,
							);
						}
						throw cause;
					}

					clearReferenceCache();
					return { ...row, contentCount: 0 };
				},
				{
					requireRole: CURATORS,
					body: t.Object({
						code: t.String({
							pattern: REGION_CODE_PATTERN,
							description: "ISO 3166-2:IN style, e.g. IN-MH",
						}),
						name: t.String({ minLength: 1, maxLength: 80 }),
						isActive: t.Optional(t.Boolean()),
					}),
					response: { 200: regionRow },
					detail: { tags: ["Admin"], summary: "Add a region" },
				},
			)

			.patch(
				"/regions/:code",
				async ({ currentUser, params, body }) => {
					const actor = requireUser(currentUser);
					requireSomeField(body);

					const updated = await db.transaction(async (tx) => {
						const [before] = await tx
							.select()
							.from(regions)
							.where(eq(regions.code, params.code))
							.limit(1)
							.for("update");

						if (!before) throw notFound("No such region.");

						const after = {
							code: before.code,
							name: body.name ?? before.name,
							isActive: body.isActive ?? before.isActive,
						};

						await tx
							.update(regions)
							.set({ name: after.name, isActive: after.isActive })
							.where(eq(regions.code, params.code));

						await logChange(tx, {
							actor,
							entity: "region",
							entityKey: params.code,
							action: actionFor(before.isActive, after.isActive),
							before,
							after,
						});

						return after;
					});

					clearReferenceCache();

					const [{ used } = { used: 0 }] = await db
						.select({ used: count() })
						.from(content)
						.where(eq(content.regionCode, params.code));

					return { ...updated, contentCount: Number(used) };
				},
				{
					requireRole: CURATORS,
					params: t.Object({ code: t.String() }),
					body: t.Object({
						name: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
						isActive: t.Optional(t.Boolean()),
					}),
					response: { 200: regionRow },
					detail: {
						tags: ["Admin"],
						summary: "Rename or retire a region",
						description:
							"The code is immutable: it is stamped onto every download event, " +
							"and changing it would rewrite history that already happened.",
					},
				},
			)

			.delete(
				"/regions/:code",
				async ({ currentUser, params }) => {
					const actor = requireUser(currentUser);

					try {
						await db.transaction(async (tx) => {
							const [before] = await tx
								.select()
								.from(regions)
								.where(eq(regions.code, params.code))
								.limit(1)
								.for("update");

							if (!before) throw notFound("No such region.");

							// Deliberately not counting download_events. That table is the
							// large one and it also references this code; the delete below
							// will fail on its own constraint if history exists, and the
							// catch turns that into the same 409. Counting it here would
							// add a scan of the biggest table in the database to every
							// attempted delete.
							const [{ used } = { used: 0 }] = await tx
								.select({ used: count() })
								.from(content)
								.where(eq(content.regionCode, params.code));

							const [{ profiles } = { profiles: 0 }] = await tx
								.select({ profiles: count() })
								.from(userProfiles)
								.where(eq(userProfiles.regionCode, params.code));

							if (Number(used) > 0 || Number(profiles) > 0) {
								throw conflict(
									`This region is used by ${used} content item${Number(used) === 1 ? "" : "s"} and ${profiles} user${Number(profiles) === 1 ? "" : "s"}. Retire it instead.`,
									{ contentCount: Number(used), userCount: Number(profiles) },
								);
							}

							await tx.delete(regions).where(eq(regions.code, params.code));
							await logChange(tx, {
								actor,
								entity: "region",
								entityKey: params.code,
								action: "delete",
								before,
							});
						});
					} catch (cause) {
						if (isForeignKeyViolation(cause)) {
							throw conflict(
								"Download history still references this region. Retire it instead of deleting.",
							);
						}
						throw cause;
					}

					clearReferenceCache();
					return { ok: true as const };
				},
				{
					requireRole: CURATORS,
					params: t.Object({ code: t.String() }),
					response: { 200: t.Object({ ok: t.Boolean() }) },
					detail: { tags: ["Admin"], summary: "Delete an unused region" },
				},
			)

			// ------------------------------------------------------------- history

			.get(
				"/log",
				async ({ query }) => {
					const filters = [
						query.entity ? eq(referenceChangeLog.entity, query.entity) : null,
						query.entityKey
							? eq(referenceChangeLog.entityKey, query.entityKey)
							: null,
					].filter((f) => f !== null);

					const rows = await db
						.select({
							id: referenceChangeLog.id,
							entity: referenceChangeLog.entity,
							entityKey: referenceChangeLog.entityKey,
							action: referenceChangeLog.action,
							before: referenceChangeLog.before,
							after: referenceChangeLog.after,
							createdAt: referenceChangeLog.createdAt,
							actorId: referenceChangeLog.actorId,
						})
						.from(referenceChangeLog)
						.where(filters.length > 0 ? and(...filters) : undefined)
						.orderBy(
							desc(referenceChangeLog.createdAt),
							desc(referenceChangeLog.id),
						)
						.limit(query.limit ?? 50);

					return rows.map((row) => ({
						...row,
						createdAt: row.createdAt.toISOString(),
					}));
				},
				{
					requireRole: CURATORS,
					query: t.Object({
						// Same trap as the PATCH above: t.Optional(t.UnionEnum(...)) would
						// default an absent filter to "tag", so an unfiltered history
						// request would silently show tag changes only.
						entity: optionalEnum(REFERENCE_ENTITIES),
						entityKey: t.Optional(t.String({ maxLength: 100 })),
						limit: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
					}),
					detail: {
						tags: ["Admin"],
						summary: "Recent taxonomy changes, newest first",
						description:
							"Filter by entity and entityKey to get the full history of one " +
							"tag, language or region.",
					},
				},
			)
	);
}
