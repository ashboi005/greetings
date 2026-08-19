CREATE TYPE "public"."reference_action" AS ENUM('create', 'update', 'activate', 'deactivate', 'delete');--> statement-breakpoint
CREATE TYPE "public"."reference_entity" AS ENUM('tag', 'language', 'region');--> statement-breakpoint
CREATE TABLE "reference_change_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"entity" "reference_entity" NOT NULL,
	"entity_key" text NOT NULL,
	"action" "reference_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "languages" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "regions" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reference_change_log" ADD CONSTRAINT "reference_change_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reference_change_log_entity_idx" ON "reference_change_log" USING btree ("entity","entity_key","created_at");--> statement-breakpoint
CREATE INDEX "reference_change_log_created_idx" ON "reference_change_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reference_change_log_actor_idx" ON "reference_change_log" USING btree ("actor_id");