DROP INDEX "content_feed_region_idx";--> statement-breakpoint
DROP INDEX "content_feed_lang_idx";--> statement-breakpoint
CREATE INDEX "content_feed_region_idx" ON "content" USING btree ("region_code","base_score" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' AND visibility_hold = false;--> statement-breakpoint
CREATE INDEX "content_feed_lang_idx" ON "content" USING btree ("primary_language","base_score" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' AND visibility_hold = false;