CREATE TYPE "public"."user_role" AS ENUM('user', 'designer', 'admin', 'super_admin');--> statement-breakpoint
CREATE TABLE "role_change_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"target_user_id" text NOT NULL,
	"from_role" "user_role" NOT NULL,
	"to_role" "user_role" NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "languages" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"native_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"role" "user_role" NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"consumed_at" timestamp,
	"consumed_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "user_languages" (
	"user_id" text NOT NULL,
	"language_code" text NOT NULL,
	CONSTRAINT "user_languages_user_id_language_code_pk" PRIMARY KEY("user_id","language_code")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"phone" text,
	"display_name" text,
	"region_code" text,
	"onboarded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "role_change_log" ADD CONSTRAINT "role_change_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_change_log" ADD CONSTRAINT "role_change_log_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_invites" ADD CONSTRAINT "role_invites_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_invites" ADD CONSTRAINT "role_invites_consumed_by_user_id_user_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_languages" ADD CONSTRAINT "user_languages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_languages" ADD CONSTRAINT "user_languages_language_code_languages_code_fk" FOREIGN KEY ("language_code") REFERENCES "public"."languages"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_region_code_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_change_log_target_idx" ON "role_change_log" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "role_change_log_created_at_idx" ON "role_change_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_invites_email_unconsumed_idx" ON "role_invites" USING btree ("email") WHERE consumed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "role_invites_phone_unconsumed_idx" ON "role_invites" USING btree ("phone") WHERE consumed_at is null;--> statement-breakpoint
CREATE INDEX "role_invites_consumed_at_idx" ON "role_invites" USING btree ("consumed_at");