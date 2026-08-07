import { relations } from "drizzle-orm";
import {
	bigserial,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { content } from "./content";
import { languages, regions } from "./profile";

/**
 * Download events (spec §4.5).
 *
 * The authoritative record of every download, kept as raw events rather than
 * counters so analytics can slice by region and time after the fact.
 * `content.downloadCount` is a denormalised total derived from these.
 *
 * `designerId` and `regionCode` are copied onto the row deliberately: it makes
 * every analytics query a single-table scan, and it freezes attribution at the
 * moment of the download, so a user later moving state does not rewrite
 * history.
 */
export const downloadSourceEnum = pgEnum("download_source", [
	"feed",
	"search",
	"detail",
]);

export const DOWNLOAD_SOURCES = downloadSourceEnum.enumValues;
export type DownloadSource = (typeof DOWNLOAD_SOURCES)[number];

export const downloadEvents = pgTable(
	"download_events",
	{
		// bigserial: this is the highest-volume table in the system.
		id: bigserial("id", { mode: "number" }).primaryKey(),
		contentId: text("content_id")
			.notNull()
			.references(() => content.id, { onDelete: "cascade" }),
		designerId: text("designer_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Null when the user downloaded before completing onboarding.
		regionCode: text("region_code").references(() => regions.code),
		languageCode: text("language_code").references(() => languages.code),
		source: downloadSourceEnum("source").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("download_events_designer_idx").on(table.designerId, table.createdAt),
		// Also serves the feed's recent-popularity term.
		index("download_events_content_idx").on(table.contentId, table.createdAt),
		index("download_events_region_idx").on(table.regionCode, table.createdAt),
		index("download_events_created_at_idx").on(table.createdAt),
	],
);

/**
 * Idempotency records for downloads (spec §8).
 *
 * Mobile networks drop responses, and a client that retries must not have the
 * download counted twice — these numbers are what designers are paid on. The
 * client sends an `Idempotency-Key`; a repeat within the replay window returns
 * the stored URL and records nothing.
 *
 * Keyed on (userId, key) rather than the key alone, so one client's key can
 * never collide with another's.
 */
export const downloadIdempotency = pgTable(
	"download_idempotency",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		contentId: text("content_id")
			.notNull()
			.references(() => content.id, { onDelete: "cascade" }),
		signedUrl: text("signed_url").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("download_idempotency_user_key_idx").on(
			table.userId,
			table.key,
		),
		// Lets the cleanup job find expired records without a scan.
		index("download_idempotency_created_at_idx").on(table.createdAt),
	],
);

export const downloadEventRelations = relations(downloadEvents, ({ one }) => ({
	content: one(content, {
		fields: [downloadEvents.contentId],
		references: [content.id],
	}),
	designer: one(user, {
		fields: [downloadEvents.designerId],
		references: [user.id],
		relationName: "downloadDesigner",
	}),
	user: one(user, {
		fields: [downloadEvents.userId],
		references: [user.id],
		relationName: "downloadUser",
	}),
}));
