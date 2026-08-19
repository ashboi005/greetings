import { relations, sql } from "drizzle-orm";
import {
	index,
	jsonb,
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
		// Every report submission counts this reporter's recent reports to
		// enforce the hourly limit. Without this the check seq-scans the whole
		// table, and it is the one query that runs on the way *in* to reporting.
		index("reports_reporter_created_idx").on(table.reporterId, table.createdAt),
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
		// The platform-wide audit feed, newest first.
		index("moderation_actions_created_idx").on(table.createdAt),
	],
);

/** What kind of reference row a taxonomy edit touched. */
export const referenceEntityEnum = pgEnum("reference_entity", [
	"tag",
	"language",
	"region",
]);

export const REFERENCE_ENTITIES = referenceEntityEnum.enumValues;
export type ReferenceEntity = (typeof REFERENCE_ENTITIES)[number];

export const referenceActionEnum = pgEnum("reference_action", [
	"create",
	"update",
	"activate",
	"deactivate",
	"delete",
]);

export const REFERENCE_ACTIONS = referenceActionEnum.enumValues;
export type ReferenceAction = (typeof REFERENCE_ACTIONS)[number];

/**
 * Audit trail for taxonomy edits (spec §4.4).
 *
 * Tags, languages and regions used to change only when someone ran a seed
 * script, so a change was implicitly attributable to a deploy. Now admins edit
 * them from the panel, which makes "who renamed this tag, and to what" a real
 * question — the same question the content timeline already answers for posts.
 *
 * `before` and `after` hold the whole row as JSON rather than named columns.
 * The three entities have different shapes, and a log that had to grow a column
 * every time one of them did would be a log nobody updates.
 */
export const referenceChangeLog = pgTable(
	"reference_change_log",
	{
		id: text("id").primaryKey(),
		// Null for changes made by a seed script, which has no signed-in actor.
		actorId: text("actor_id").references(() => user.id, {
			onDelete: "set null",
		}),
		entity: referenceEntityEnum("entity").notNull(),
		/** Primary key of the touched row: a tag id, or a language/region code. */
		entityKey: text("entity_key").notNull(),
		action: referenceActionEnum("action").notNull(),
		/** Null on create. */
		before: jsonb("before"),
		/** Null on delete. */
		after: jsonb("after"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		// "Show me everything that happened to this tag."
		index("reference_change_log_entity_idx").on(
			table.entity,
			table.entityKey,
			table.createdAt,
		),
		// The newest-first feed the audit page reads.
		index("reference_change_log_created_idx").on(table.createdAt),
		index("reference_change_log_actor_idx").on(table.actorId),
	],
);

export const referenceChangeLogRelations = relations(
	referenceChangeLog,
	({ one }) => ({
		actor: one(user, {
			fields: [referenceChangeLog.actorId],
			references: [user.id],
		}),
	}),
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
