CREATE TYPE "public"."content_status" AS ENUM('draft', 'pending_review', 'published', 'rejected', 'removed');--> statement-breakpoint
CREATE TYPE "public"."tag_category" AS ENUM('festival', 'language', 'region', 'theme', 'occasion');--> statement-breakpoint
CREATE TYPE "public"."moderation_action" AS ENUM('submit', 'approve', 'reject', 'remove', 'restore', 'hold');--> statement-breakpoint
CREATE TABLE "content" (
	"id" text PRIMARY KEY NOT NULL,
	"designer_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"primary_language" text NOT NULL,
	"region_code" text,
	"download_count" integer DEFAULT 0 NOT NULL,
	"visibility_hold" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp,
	"reviewed_at" timestamp,
	"reviewed_by" text,
	"rejection_reason" text,
	"published_at" timestamp,
	"removed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"title_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"content_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"checksum" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "content_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "content_tags" (
	"content_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "content_tags_content_id_tag_id_pk" PRIMARY KEY("content_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"category" "tag_category" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tags_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"content_id" text NOT NULL,
	"action" "moderation_action" NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_designer_id_user_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_primary_language_languages_code_fk" FOREIGN KEY ("primary_language") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_region_code_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content" ADD CONSTRAINT "content_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tags" ADD CONSTRAINT "content_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_feed_idx" ON "content" USING btree ("status","visibility_hold","published_at");--> statement-breakpoint
CREATE INDEX "content_designer_idx" ON "content" USING btree ("designer_id","created_at");--> statement-breakpoint
CREATE INDEX "content_review_queue_idx" ON "content" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "content_language_idx" ON "content" USING btree ("primary_language");--> statement-breakpoint
CREATE INDEX "content_region_idx" ON "content" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "content_title_tsv_idx" ON "content" USING gin ("title_tsv");--> statement-breakpoint
CREATE INDEX "content_title_trgm_idx" ON "content" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "content_assets_content_idx" ON "content_assets" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "content_tags_tag_idx" ON "content_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tags_category_idx" ON "tags" USING btree ("category","is_active");--> statement-breakpoint
CREATE INDEX "moderation_actions_content_idx" ON "moderation_actions" USING btree ("content_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_actor_idx" ON "moderation_actions" USING btree ("actor_id");