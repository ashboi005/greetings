import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user, userRoleEnum } from "./auth";

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
