/**
 * Idempotent seeding of reference data and the bootstrap super admin.
 *
 * Safe to re-run: every write is an upsert, so this can be part of a deploy
 * step rather than a one-off someone has to remember.
 *
 *   bun run db:seed
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../index";
import { roleChangeLog, session, tags, user as userTable } from "../schema";
import { languages, regions } from "../schema/profile";
import { LANGUAGE_SEED, REGION_SEED } from "./reference";
import { TAG_SEED } from "./tags";

export async function seedReferenceData(): Promise<{
	regions: number;
	languages: number;
	tags: number;
}> {
	await db
		.insert(regions)
		.values([...REGION_SEED])
		.onConflictDoUpdate({
			target: regions.code,
			set: { name: sqlExcluded("name") },
		});

	await db
		.insert(languages)
		.values([...LANGUAGE_SEED])
		.onConflictDoUpdate({
			target: languages.code,
			set: {
				name: sqlExcluded("name"),
				nativeName: sqlExcluded("native_name"),
			},
		});

	// Keyed on slug, not id, so re-running never duplicates a tag and never
	// orphans content already tagged with it.
	await db
		.insert(tags)
		.values(
			TAG_SEED.map((tag) => ({
				id: `tag_${tag.slug}`,
				slug: tag.slug,
				label: tag.label,
				category: tag.category,
			})),
		)
		.onConflictDoUpdate({
			target: tags.slug,
			set: {
				label: sqlExcluded("label"),
				category: sqlExcluded("category"),
			},
		});

	return {
		regions: REGION_SEED.length,
		languages: LANGUAGE_SEED.length,
		tags: TAG_SEED.length,
	};
}

/**
 * Promotes the configured email to super admin (spec §4.1).
 *
 * The platform needs one super admin who was not granted the role by another
 * super admin. That account must already exist — sign in with Google first,
 * then run this.
 */
export async function seedSuperAdmin(
	email: string,
): Promise<{ promoted: boolean; reason?: string }> {
	const [target] = await db
		.select({ id: userTable.id, role: userTable.role })
		.from(userTable)
		.where(eq(userTable.email, email))
		.limit(1);

	if (!target) {
		return {
			promoted: false,
			reason: `No user with email ${email}. Sign in once, then re-run.`,
		};
	}

	if (target.role === "super_admin") {
		return { promoted: false, reason: "Already a super admin." };
	}

	await db.transaction(async (tx) => {
		await tx
			.update(userTable)
			.set({ role: "super_admin", updatedAt: new Date() })
			.where(eq(userTable.id, target.id));

		await tx.insert(roleChangeLog).values({
			id: crypto.randomUUID(),
			actorId: null,
			targetUserId: target.id,
			fromRole: target.role,
			toRole: "super_admin",
			reason: "Bootstrap super admin (seed script)",
			createdAt: new Date(),
		});

		// Authorisation reads the role out of the session, so a session issued
		// before this promotion still says `user`. The role-assignment route
		// revokes sessions for exactly this reason; the bootstrap path has to do
		// the same or the first super admin signs in, runs the seed, and is still
		// told there is nothing here for them.
		await tx.delete(session).where(eq(session.userId, target.id));
	});

	return { promoted: true };
}

function sqlExcluded(column: string) {
	return sql.raw(`excluded.${column}`);
}
