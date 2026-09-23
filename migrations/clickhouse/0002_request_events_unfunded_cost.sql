-- migrate:up
ALTER TABLE request_events ADD COLUMN IF NOT EXISTS unfunded_cost_usd Decimal(20, 12) DEFAULT 0 AFTER billed_cost_usd;

-- migrate:down
-- Forward-only: fix mistakes with a new migration.
