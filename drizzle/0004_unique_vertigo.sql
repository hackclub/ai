CREATE INDEX "users_slack_id_idx" ON "users" USING btree ("slack_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_idv_verified_idx" ON "users" USING btree ("is_idv_verified");