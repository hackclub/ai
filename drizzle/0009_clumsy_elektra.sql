CREATE INDEX "request_logs_request_gin_idx" ON "request_logs" USING gin ("request");--> statement-breakpoint
CREATE INDEX "request_logs_response_gin_idx" ON "request_logs" USING gin ("response");