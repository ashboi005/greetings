CREATE TABLE "download_idempotency" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"content_id" text NOT NULL,
	"signed_url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_idempotency" ADD CONSTRAINT "download_idempotency_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_idempotency" ADD CONSTRAINT "download_idempotency_content_id_content_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."content"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "download_idempotency_user_key_idx" ON "download_idempotency" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "download_idempotency_created_at_idx" ON "download_idempotency" USING btree ("created_at");