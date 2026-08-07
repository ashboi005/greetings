import { relations } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user, userRoleEnum } from "./auth";
import { content } from "./content";

/**
 * Audit trail for privileged actions (spec §4.4).
 *
 * Content moderation tables land in M3 alongside the content lifecycle; this
 * file starts with role changes, which M2 needs. Role escalation is the most
 * security-sensitive operation in the system, so every change is recorded with
 * who made it — including the seed script's bootstrap grant.
 */
export const roleChangeLog = pgTable(
	"role_change_log",
	{
		id: text("id").primaryKey(),
		// Null only for the bootstrap super admin, which no user grants.
		actorId: text("actor_id").references(() => user.id, {
			onDelete: "set null",
		}),
		targetUserId: text("target_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		fromRole: userRoleEnum("from_role").notNull(),
		toRole: userRoleEnum("to_role").notNull(),
		reason: text("reason"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("role_change_log_target_idx").on(table.targetUserId),
		index("role_change_log_created_at_idx").on(table.createdAt),
	],
);

/**
 * Every lifecycle move, recorded (spec §5).
 *
 * Written by `transition()` on each state change, so the history of a piece of
 * content is reconstructable: who submitted it, who approved it, who pulled it
 * down and why. Kept append-only — corrections are new rows, not edits.
 */
export const moderationActionEnum = pgEnum("moderation_action", [
	"submit",
	"approve",
	"reject",
	"remove",
	"restore",
	"hold",
]);

export const MODERATION_ACTIONS = moderationActionEnum.enumValues;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const moderationActions = pgTable(
	"moderation_actions",
	{
		id: text("id").primaryKey(),
		// Null when the system acted on its own — the automatic hold once
		// reports cross the threshold has no human actor.
		actorId: text("actor_id").references(() => user.id, {
			onDelete: "set null",
		}),
		contentId: text("content_id")
			.notNull()
			.references(() => content.id, { onDelete: "cascade" }),
		action: moderationActionEnum("action").notNull(),
		reason: text("reason"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("moderation_actions_content_idx").on(
			table.contentId,
			table.createdAt,
		),
		index("moderation_actions_actor_idx").on(table.actorId),
	],
);

export const moderationActionRelations = relations(
	moderationActions,
	({ one }) => ({
		actor: one(user, {
			fields: [moderationActions.actorId],
			references: [user.id],
		}),
		content: one(content, {
			fields: [moderationActions.contentId],
			references: [content.id],
		}),
	}),
);

export const roleChangeLogRelations = relations(roleChangeLog, ({ one }) => ({
	actor: one(user, {
		fields: [roleChangeLog.actorId],
		references: [user.id],
		relationName: "roleChangeActor",
	}),
	target: one(user, {
		fields: [roleChangeLog.targetUserId],
		references: [user.id],
		relationName: "roleChangeTarget",
	}),
}));
