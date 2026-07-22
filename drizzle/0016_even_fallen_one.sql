CREATE TYPE "public"."review_status" AS ENUM('normal', 'flagged', 'strict', 'banned');--> statement-breakpoint
CREATE TABLE "content_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"violation_event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_log_id" uuid,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"content" text,
	"content_hash" text,
	"dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_flag_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"opt_in_forced_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "review_status" "review_status" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "violation_count_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "violation_count_month" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_violation_at" timestamp;--> statement-breakpoint
ALTER TABLE "content_violations" ADD CONSTRAINT "content_violations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_violations" ADD CONSTRAINT "content_violations_request_log_id_request_logs_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."request_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_flag_settings" ADD CONSTRAINT "user_flag_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "violations_user_created_idx" ON "content_violations" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "violations_request_log_idx" ON "content_violations" USING btree ("request_log_id");--> statement-breakpoint
CREATE INDEX "violations_event_id_idx" ON "content_violations" USING btree ("violation_event_id");--> statement-breakpoint
CREATE INDEX "flag_settings_user_idx" ON "user_flag_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_review_status_idx" ON "users" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "users_is_admin_idx" ON "users" USING btree ("is_admin");