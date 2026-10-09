-- migrate:up
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

-- A policy without an account is global: it applies to every account that
-- has no enabled policy of its own of the same kind (src/billing/policies.ts).
ALTER TABLE billing_funding_policies ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE billing_limit_policies ALTER COLUMN account_id DROP NOT NULL;

-- A global policy has one window per account per period.
ALTER TABLE billing_funding_windows
    DROP CONSTRAINT billing_funding_windows_policy_id_generation_window_start_key,
    ADD UNIQUE (policy_id, account_id, generation, window_start);
ALTER TABLE billing_limit_windows
    DROP CONSTRAINT billing_limit_windows_policy_id_generation_window_start_key,
    ADD UNIQUE (policy_id, account_id, generation, window_start);

-- Every account was given the same $3 daily allowance and, by hand, the same
-- "OpenRouter top-up wait" limit. Each becomes one global policy; existing
-- windows move to it so spend already counted in the current period stays.
CREATE TEMP TABLE converted_funding ON COMMIT DROP AS
SELECT id, effective_from
FROM billing_funding_policies
WHERE
    account_id IS NOT NULL
    AND name = 'Daily allowance'
    AND cadence = 'day'
    AND timezone = 'UTC'
    AND amount_usd = 3
    AND priority = 100
    AND generation = 1
    AND enabled
    AND effective_until IS NULL;

INSERT INTO billing_funding_policies (account_id, name, cadence, timezone, amount_usd, priority, effective_from)
SELECT NULL, 'Daily allowance', 'day', 'UTC', 3, 100,
    COALESCE((SELECT min(effective_from) FROM converted_funding), now());

UPDATE billing_funding_windows
SET policy_id = (SELECT id FROM billing_funding_policies WHERE account_id IS NULL)
WHERE policy_id IN (SELECT id FROM converted_funding);

DELETE FROM billing_funding_policies WHERE id IN (SELECT id FROM converted_funding);

CREATE TEMP TABLE global_limit ON COMMIT DROP AS
SELECT name, cadence, timezone, limit_usd, enabled, min(effective_from) AS effective_from
FROM billing_limit_policies
WHERE
    account_id IS NOT NULL
    AND name = 'OpenRouter top-up wait'
    AND generation = 1
    AND effective_until IS NULL
GROUP BY name, cadence, timezone, limit_usd, enabled
ORDER BY count(*) DESC
LIMIT 1;

CREATE TEMP TABLE converted_limits ON COMMIT DROP AS
SELECT policy.id
FROM billing_limit_policies AS policy
JOIN global_limit USING (name, cadence, timezone, limit_usd, enabled)
WHERE policy.account_id IS NOT NULL AND policy.generation = 1 AND policy.effective_until IS NULL;

INSERT INTO billing_limit_policies (account_id, name, cadence, timezone, limit_usd, enabled, effective_from)
SELECT NULL, name, cadence, timezone, limit_usd, enabled, effective_from FROM global_limit;

UPDATE billing_limit_windows
SET policy_id = (SELECT id FROM billing_limit_policies WHERE account_id IS NULL)
WHERE policy_id IN (SELECT id FROM converted_limits);

DELETE FROM billing_limit_policies WHERE id IN (SELECT id FROM converted_limits);

-- Discounts lower what a request is billed. A served_by discount applies
-- only when that upstream actually served the request.
CREATE TABLE pricing_discounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_pattern TEXT CHECK (length(model_pattern) BETWEEN 1 AND 200),
    served_by TEXT CHECK (length(served_by) BETWEEN 1 AND 100),
    percent_off NUMERIC(5, 2) NOT NULL CHECK (percent_off > 0 AND percent_off <= 100),
    note TEXT CHECK (length(note) <= 500),
    enabled BOOLEAN NOT NULL DEFAULT true,
    starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (model_pattern IS NOT NULL OR served_by IS NOT NULL),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE admin_audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('user', 'funding_policy', 'limit_policy', 'discount')),
    target_id TEXT NOT NULL,
    reason TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_events_target_idx ON admin_audit_events (target_type, target_id, created_at DESC);

-- migrate:down
-- Forward-only: fix mistakes with a new migration.
