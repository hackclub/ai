-- A drainer claims rows with a lease instead of holding a transaction open
-- across the ClickHouse insert. A row whose lease expired is retried; a row
-- delivered twice is collapsed by ClickHouse's ReplacingMergeTree.
ALTER TABLE request_event_outbox
    ADD COLUMN claimed_at TIMESTAMPTZ;

-- The drain query orders by attempts then id and only wants undelivered rows.
-- The predicate must match MAX_DELIVERY_ATTEMPTS in src/analytics/request-events.ts.
CREATE INDEX request_event_outbox_pending_idx
    ON request_event_outbox (attempts, id)
    WHERE attempts < 25;

-- Parked rows are found by attempts and age for body stripping.
CREATE INDEX request_event_outbox_parked_idx
    ON request_event_outbox (created_at)
    WHERE attempts >= 25;
