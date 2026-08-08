DROP INDEX "role_invites_email_unconsumed_idx";--> statement-breakpoint
DROP INDEX "role_invites_phone_unconsumed_idx";--> statement-breakpoint
ALTER TABLE "role_invites" ADD COLUMN "revoked_at" timestamp;--> statement-breakpoint
ALTER TABLE "role_invites" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "role_invites" ADD CONSTRAINT "role_invites_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_stale_draft_idx" ON "content" USING btree ("updated_at") WHERE status = 'draft';--> statement-breakpoint
CREATE INDEX "content_created_at_idx" ON "content" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_created_idx" ON "moderation_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_created_idx" ON "reports" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_invites_email_unconsumed_idx" ON "role_invites" USING btree ("email") WHERE consumed_at is null and revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "role_invites_phone_unconsumed_idx" ON "role_invites" USING btree ("phone") WHERE consumed_at is null and revoked_at is null;