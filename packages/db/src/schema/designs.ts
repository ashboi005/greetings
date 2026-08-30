import { relations } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * User-made designs — the "My Designs" studio (spec §16).
 *
 * Deliberately not `content`. These share a shape with published content and
 * nothing else: they are private to one user, never reviewed, never ranked,
 * never counted, and never seen by anyone else. Putting them in the same table
 * would mean every feed, search, moderation and analytics query growing a
 * predicate to exclude them — and the day one of those is forgotten, a private
 * draft appears in a stranger's feed.
 */
export const userDesigns = pgTable(
	"user_designs",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),

		title: text("title"),

		/**
		 * The editable scene: text, shapes, positions, colours, fonts.
		 *
		 * Opaque to the server, and intentionally so. The renderer is Skia on the
		 * device, so the backend validating this structure would mean two
		 * definitions of a design that have to agree — and the schema would have
		 * to be redeployed every time the editor gained a feature. Size is capped
		 * at the route instead.
		 */
		designJson: jsonb("design_json").notNull(),

		/** R2 key for the one image a design may use. Null for text-only designs. */
		sourceImageKey: text("source_image_key"),

		/**
		 * R2 key for the flattened render.
		 *
		 * Stored so the gallery and re-sharing do not need the device to rebuild
		 * the scene first. Null until the client has uploaded one.
		 */
		previewKey: text("preview_key"),

		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		// The gallery: one user's designs, most recently edited first.
		index("user_designs_user_idx").on(table.userId, table.updatedAt),
	],
);

export const userDesignRelations = relations(userDesigns, ({ one }) => ({
	owner: one(user, {
		fields: [userDesigns.userId],
		references: [user.id],
	}),
}));
