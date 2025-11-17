DROP INDEX "api_keys_key_idx";--> statement-breakpoint
DROP INDEX "api_keys_revoked_at_idx";--> statement-breakpoint
DROP INDEX "request_logs_api_key_id_idx";--> statement-breakpoint
DROP INDEX "request_logs_user_id_idx";--> statement-breakpoint
DROP INDEX "request_logs_slack_id_idx";--> statement-breakpoint
DROP INDEX "request_logs_timestamp_idx";--> statement-breakpoint
DROP INDEX "sessions_token_idx";--> statement-breakpoint
DROP INDEX "users_slack_id_idx";--> statement-breakpoint
CREATE INDEX "api_keys_key_revoked_idx" ON "api_keys" USING btree ("key","revoked_at");--> statement-breakpoint
CREATE INDEX "request_logs_user_timestamp_idx" ON "request_logs" USING btree ("user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_apikey_timestamp_idx" ON "request_logs" USING btree ("api_key_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "request_logs_slack_timestamp_idx" ON "request_logs" USING btree ("slack_id","timestamp" DESC NULLS LAST);