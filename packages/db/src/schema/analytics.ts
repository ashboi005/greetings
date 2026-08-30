import { relations } from "drizzle-orm";
import {
	bigserial,
	boolean,
	date,
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
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
		/**
		 * Whether the user personalised the image before sharing it.
		 *
		 * The overlay is composed on the device, so this is the only signal that
		 * the feature is being used at all. Defaults false, which is what every
		 * historical row means.
		 */
		customized: boolean("customized").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("download_events_designer_idx").on(table.designerId, table.createdAt),
		// Also serves the feed's recent-popularity term.
		index("download_events_content_idx").on(table.contentId, table.createdAt),
		index("download_events_region_idx").on(table.regionCode, table.createdAt),
		index("download_events_created_at_idx").on(table.createdAt),
		// The user's own download history. Without this the history screen is a
		// sequential scan of the largest table in the database — the other four
		// indexes lead with designer, content, region and time, none of which
		// helps a query filtered by user.
		index("download_events_user_idx").on(table.userId, table.createdAt),
	],
);

/**
 * Pre-aggregated daily download counts (spec §4.5, §9).
 *
 * Analytics read this for every date before today and aggregate
 * `download_events` live for today only, so a dashboard never scans the full
 * event history. The grain is (date, content, region) because region is the
 * finest breakdown the product asks for; anything coarser is a further
 * aggregation of these rows.
 *
 * `designerId` rides along denormalised for the same reason it does on the
 * events: per-designer analytics then never join.
 */
export const dailyContentStats = pgTable(
	"daily_content_stats",
	{
		statDate: date("stat_date").notNull(),
		contentId: text("content_id")
			.notNull()
			.references(() => content.id, { onDelete: "cascade" }),
		designerId: text("designer_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Empty string, not null, for downloads by users who never onboarded:
		// a nullable column cannot carry a primary key, and losing those rows
		// would make the rollup disagree with the raw events.
		regionCode: text("region_code").notNull(),
		downloads: integer("downloads").notNull(),
		uniqueUsers: integer("unique_users").notNull(),
		computedAt: timestamp("computed_at").defaultNow().notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.statDate, table.contentId, table.regionCode],
		}),
		index("daily_stats_designer_idx").on(table.designerId, table.statDate),
		index("daily_stats_date_idx").on(table.statDate),
	],
);

/** Stands in for a null region in the rollup's primary key. */
export const UNKNOWN_REGION = "";

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
