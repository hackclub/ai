DROP INDEX IF EXISTS "request_logs_request_gin_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "request_logs_response_gin_idx";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "spending_limit_usd" SET DEFAULT '4';--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "is_unlimited" boolean DEFAULT false NOT NULL;
