-- Limit holds get the same "never empty" check as funding and credit holds:
-- the engine deletes a hold once both amounts reach zero, so an empty row is
-- always a bug. Idempotent, because Docker's initdb applies this file before
-- the migration runner does.
DELETE FROM billing_reservation_limit_holds
WHERE reserved_usd = 0 AND committed_usd = 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'billing_reservation_limit_holds_nonempty'
    ) THEN
        ALTER TABLE billing_reservation_limit_holds
            ADD CONSTRAINT billing_reservation_limit_holds_nonempty
            CHECK (reserved_usd > 0 OR committed_usd > 0);
    END IF;
END
$$;
