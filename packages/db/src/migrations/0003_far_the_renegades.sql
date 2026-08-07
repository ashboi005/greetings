CREATE TYPE "public"."download_source" AS ENUM('feed', 'search', 'detail');--> statement-breakpoint
CREATE TABLE "download_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"content_id" text NOT NULL,
	"designer_id" text NOT NULL,
	"user_id" text NOT NULL,
	"region_code" text,
	"language_code" text,
	"source" "download_source" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_designer_id_user_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_region_code_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_events_designer_idx" ON "download_events" USING btree ("designer_id","created_at");--> statement-breakpoint
CREATE INDEX "download_events_content_idx" ON "download_events" USING btree ("content_id","created_at");--> statement-breakpoint
CREATE INDEX "download_events_region_idx" ON "download_events" USING btree ("region_code","created_at");--> statement-breakpoint
CREATE INDEX "download_events_created_at_idx" ON "download_events" USING btree ("created_at");