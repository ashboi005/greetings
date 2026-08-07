CREATE TABLE "daily_content_stats" (
	"stat_date" date NOT NULL,
	"content_id" text NOT NULL,
	"designer_id" text NOT NULL,
	"region_code" text NOT NULL,
	"downloads" integer NOT NULL,
	"unique_users" integer NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_content_stats_stat_date_content_id_region_code_pk" PRIMARY KEY("stat_date","content_id","region_code")
);
--> statement-breakpoint
ALTER TABLE "daily_content_stats" ADD CONSTRAINT "daily_content_stats_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_content_stats" ADD CONSTRAINT "daily_content_stats_designer_id_user_id_fk" FOREIGN KEY ("designer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_stats_designer_idx" ON "daily_content_stats" USING btree ("designer_id","stat_date");--> statement-breakpoint
CREATE INDEX "daily_stats_date_idx" ON "daily_content_stats" USING btree ("stat_date");