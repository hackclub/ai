-- migrate:up
-- When the request ended unsettled. Reconciliation measures the provider's
-- record delay from here: requests can run for hours, so created_at says
-- nothing about it, and deferRow bumps updated_at on every pass.
ALTER TABLE billing_reservations
    ADD COLUMN pending_since TIMESTAMPTZ;

-- Rows already pending get their last update, which is never earlier than
-- when they became pending, so their wait is never shortened.
UPDATE billing_reservations
SET pending_since = updated_at
WHERE state = 'pending_reconciliation';

-- migrate:down
-- Forward-only: fix mistakes with a new migration.
