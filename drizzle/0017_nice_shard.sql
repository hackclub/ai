-- Carry over existing bans to the new review_status column before dropping
-- the legacy boolean so no user loses their banned state.
UPDATE "users" SET "review_status" = 'banned' WHERE "is_banned" = true;
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_banned";
