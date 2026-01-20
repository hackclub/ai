DROP INDEX "request_logs_user_timestamp_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "spending_limit_usd" numeric(10, 8) DEFAULT '8';--> statement-breakpoint
CREATE INDEX "request_logs_user_timestamp_cost_idx" ON "request_logs" USING btree ("user_id","timestamp" DESC NULLS LAST,"cost");
