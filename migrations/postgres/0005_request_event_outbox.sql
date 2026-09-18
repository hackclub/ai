-- Finalized request events wait here for the analytics worker, which copies
-- them to ClickHouse in batches and deletes them. The row is written in the
-- finalization transaction, so an event exists if and only if the charge
-- committed. This replaces enqueueing a Graphile Worker job per event: its
-- add_job issues NOTIFY, and PostgreSQL serializes every committing
-- transaction that notified through one database-wide lock held across the
-- WAL flush, which capped finalizations at roughly one commit at a time.

CREATE TABLE request_event_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
