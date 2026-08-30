CREATE TABLE "user_designs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"design_json" jsonb NOT NULL,
	"source_image_key" text,
	"preview_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_events" ADD COLUMN "customized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "designation" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "user_designs" ADD CONSTRAINT "user_designs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_designs_user_idx" ON "user_designs" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "download_events_user_idx" ON "download_events" USING btree ("user_id","created_at");