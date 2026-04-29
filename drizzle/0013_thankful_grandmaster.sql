ALTER TABLE "users" ADD COLUMN "openrouter_key" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "openrouter_key_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "openrouter_key_limit" numeric(10, 8);