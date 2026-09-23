-- migrate:up
-- Who made the request and to which endpoint, recorded at reserve so every settlement path
-- (live, provider error, reconciliation) can attribute its analytics event
-- from the row alone. No foreign keys, as with billing_accounts.owner_id:
-- billing never references identity tables, and reserve is the hot path.
ALTER TABLE billing_reservations
    ADD COLUMN user_id UUID,
    ADD COLUMN api_key_id UUID,
    ADD COLUMN endpoint TEXT;

-- Rows still awaiting settlement at deploy get the user from the account
-- owner, so their reconciled events are attributed. api_key_id and
-- endpoint stay NULL for them (reconciled events then carry endpoint "").
UPDATE billing_reservations AS r
SET user_id = a.owner_id
FROM billing_accounts AS a
WHERE r.account_id = a.id
  AND a.owner_type = 'user'
  AND r.state IN ('reserved', 'pending_reconciliation');

-- migrate:down
-- Forward-only: fix mistakes with a new migration.
