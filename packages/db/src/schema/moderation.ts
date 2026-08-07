import { relations, sql } from "drizzle-orm";
import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user, userRoleEnum } from "./auth";
import { content } from "./content";

/** Partial-index predicate: only reports still awaiting an admin decision. */
const sqlOpenReports = sql`status = 'open'`;

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
 * User reports of inappropriate content (spec §4.4, §10).
 *
 * Reports are the only signal the platform has from the people actually
 * looking at the content, so the flow is deliberately low-friction: a reason
 * from a short list, and an optional note.
 */
export const reportReasonEnum = pgEnum("report_reason", [
	"inappropriate",
	"copyright",
	"spam",
	"wrong_info",
	"other",
]);

export const REPORT_REASONS = reportReasonEnum.enumValues;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const reportStatusEnum = pgEnum("report_status", [
	"open",
	"resolved_kept",
	"resolved_removed",
]);

export const REPORT_STATUSES = reportStatusEnum.enumValues;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const reports = pgTable(
	"reports",
	{
		id: text("id").primaryKey(),
		contentId: text("content_id")
			.notNull()
			.references(() => content.id, { onDelete: "cascade" }),
		reporterId: text("reporter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		reason: reportReasonEnum("reason").notNull(),
		note: text("note"),
		status: reportStatusEnum("status").default("open").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		resolvedAt: timestamp("resolved_at"),
		resolvedBy: text("resolved_by").references(() => user.id, {
			onDelete: "set null",
		}),
		resolutionNote: text("resolution_note"),
	},
	(table) => [
		// One *open* report per person per item. Partial rather than total, so
		// the same user may report again after a previous report was resolved —
		// content that was kept can still deteriorate, or be re-reported for a
		// different reason.
		uniqueIndex("reports_one_open_per_reporter_idx")
			.on(table.contentId, table.reporterId)
			.where(sqlOpenReports),
		// Drives the admin queue: open reports, worst first.
		index("reports_status_created_idx").on(table.status, table.createdAt),
		index("reports_content_idx").on(table.contentId, table.status),
	],
);

export const reportRelations = relations(reports, ({ one }) => ({
	content: one(content, {
		fields: [reports.contentId],
		references: [content.id],
	}),
	reporter: one(user, {
		fields: [reports.reporterId],
		references: [user.id],
		relationName: "reportReporter",
	}),
	resolver: one(user, {
		fields: [reports.resolvedBy],
		references: [user.id],
		relationName: "reportResolver",
	}),
}));

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
