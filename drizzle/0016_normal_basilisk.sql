ALTER TABLE "users" ALTER COLUMN "spending_limit_usd" SET DEFAULT '3';--> statement-breakpoint
UPDATE "users" SET "spending_limit_usd" = '3' WHERE "spending_limit_usd" = '4';--> statement-breakpoint
