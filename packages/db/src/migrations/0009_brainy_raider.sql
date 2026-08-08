DROP INDEX "content_feed_idx";--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "recent_downloads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "base_score" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content" ADD COLUMN "primary_asset_key" text;--> statement-breakpoint
CREATE INDEX "content_feed_score_idx" ON "content" USING btree ("base_score" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' AND visibility_hold = false;--> statement-breakpoint
CREATE INDEX "content_feed_region_idx" ON "content" USING btree ("region_code","primary_language","base_score" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' AND visibility_hold = false;--> statement-breakpoint
CREATE INDEX "content_feed_lang_idx" ON "content" USING btree ("primary_language","region_code","base_score" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' AND visibility_hold = false;--> statement-breakpoint
CREATE INDEX "content_published_at_idx" ON "content" USING btree ("published_at" DESC NULLS LAST) WHERE status = 'published' AND visibility_hold = false;