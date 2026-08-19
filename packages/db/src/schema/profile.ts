import { relations, sql } from "drizzle-orm";
import {
	boolean,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user, userRoleEnum } from "./auth";

/**
 * Partial-index predicate: only invites still awaiting a first sign-in.
 *
 * A revoked invite is spent as far as uniqueness goes — the identifier is free
 * to be invited again — but the row survives, because a grant of privilege that
 * was withdrawn is exactly the kind of thing an audit needs to show.
 */
const unconsumed = sql`consumed_at is null and revoked_at is null`;

/**
 * Profile and reference data (spec §4.2).
 *
 * Region and language are not decoration: they drive feed personalisation
 * (§7) and are stamped onto every download event for analytics (§4.5).
 */

/**
 * Indian states and union territories, keyed by ISO 3166-2:IN code.
 *
 * Retired via `isActive` rather than deleted. A region code is stamped onto
 * every `download_events` row and held by `user_profiles`, so a delete would
 * either fail on a foreign key or destroy historical attribution. Retiring one
 * hides it from the pickers while every past download stays correctly
 * attributed, and a user already in that region keeps working.
 */
export const regions = pgTable("regions", {
	code: text("code").primaryKey(),
	name: text("name").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
});

/**
 * Languages content can be authored in, keyed by ISO 639-1 where one exists.
 *
 * Retired rather than deleted for the same reason as regions: `content`
 * references a primary language and `user_languages` holds per-user preferences.
 */
export const languages = pgTable("languages", {
	code: text("code").primaryKey(),
	name: text("name").notNull(),
	nativeName: text("native_name").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
});

export const userProfiles = pgTable("user_profiles", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	phone: text("phone").unique(),
	displayName: text("display_name"),
	regionCode: text("region_code").references(() => regions.code),
	// Null until onboarding completes. Feed and download attribution both need
	// a region, so this doubles as the "has this user finished onboarding" flag.
	onboardedAt: timestamp("onboarded_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

export const userLanguages = pgTable(
	"user_languages",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		languageCode: text("language_code")
			.notNull()
			.references(() => languages.code),
	},
	(table) => [primaryKey({ columns: [table.userId, table.languageCode] })],
);

/**
 * Roles granted to people who have not signed up yet (spec §4.1).
 *
 * A super admin invites by email or phone; the grant is applied automatically
 * at that person's first sign-in. Keeping this separate from `user` is what
 * lets a role be assigned before an account exists.
 */
export const roleInvites = pgTable(
	"role_invites",
	{
		id: text("id").primaryKey(),
		email: text("email"),
		phone: text("phone"),
		role: userRoleEnum("role").notNull(),
		invitedBy: text("invited_by")
			.notNull()
			.references(() => user.id),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		consumedAt: timestamp("consumed_at"),
		consumedByUserId: text("consumed_by_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		// Withdrawn before anyone signed in with it. Soft rather than a delete:
		// "a super admin offered someone admin and thought better of it" is a
		// fact the audit should keep.
		revokedAt: timestamp("revoked_at"),
		revokedBy: text("revoked_by").references(() => user.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		// At most one outstanding invite per identifier, so two super admins
		// racing cannot leave a second grant waiting to reapply later.
		uniqueIndex("role_invites_email_unconsumed_idx")
			.on(table.email)
			.where(unconsumed),
		uniqueIndex("role_invites_phone_unconsumed_idx")
			.on(table.phone)
			.where(unconsumed),
		index("role_invites_consumed_at_idx").on(table.consumedAt),
	],
);

export const regionRelations = relations(regions, ({ many }) => ({
	profiles: many(userProfiles),
}));

export const languageRelations = relations(languages, ({ many }) => ({
	userLanguages: many(userLanguages),
}));

export const userProfileRelations = relations(userProfiles, ({ one }) => ({
	user: one(user, { fields: [userProfiles.userId], references: [user.id] }),
	region: one(regions, {
		fields: [userProfiles.regionCode],
		references: [regions.code],
	}),
}));

export const userLanguageRelations = relations(userLanguages, ({ one }) => ({
	user: one(user, { fields: [userLanguages.userId], references: [user.id] }),
	language: one(languages, {
		fields: [userLanguages.languageCode],
		references: [languages.code],
	}),
}));
