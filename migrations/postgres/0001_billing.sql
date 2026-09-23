-- migrate:up
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE billing_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type TEXT NOT NULL CHECK (owner_type IN ('user', 'organization', 'project')),
    owner_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_type, owner_id)
);

-- Recurring allowances create spendable funding windows. A daily free
-- allowance and a monthly allowance are the same concept with different
-- cadences; neither cadence is baked into the reservation engine.
CREATE TABLE billing_funding_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    cadence TEXT NOT NULL
        CHECK (cadence IN ('day', 'week', 'month', 'year')),
    timezone TEXT NOT NULL DEFAULT 'UTC',
    amount_usd NUMERIC(20, 12) NOT NULL CHECK (amount_usd >= 0),
    priority INTEGER NOT NULL DEFAULT 100,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE INDEX billing_funding_policies_account_idx
    ON billing_funding_policies (account_id, enabled);

CREATE TABLE billing_funding_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL
        REFERENCES billing_funding_policies(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation > 0),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    granted_usd NUMERIC(20, 12) NOT NULL CHECK (granted_usd >= 0),
    reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    committed_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (window_end > window_start),
    CHECK (reserved_usd + committed_usd <= granted_usd),
    UNIQUE (policy_id, generation, window_start)
);

CREATE INDEX billing_funding_windows_available_idx
    ON billing_funding_windows (account_id, window_end, superseded_at);

-- One-off promotional, purchased, or manually issued credit. Reservations
-- can spill from recurring funding windows into grants in priority order.
CREATE TABLE billing_credit_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    source TEXT NOT NULL
        CHECK (source IN ('promotional', 'purchased', 'manual', 'refund')),
    description TEXT,
    granted_usd NUMERIC(20, 12) NOT NULL CHECK (granted_usd >= 0),
    reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    committed_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
    priority INTEGER NOT NULL DEFAULT 200,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at IS NULL OR expires_at > valid_from),
    CHECK (jsonb_typeof(metadata) = 'object'),
    CHECK (reserved_usd + committed_usd <= granted_usd)
);

CREATE INDEX billing_credit_grants_available_idx
    ON billing_credit_grants (account_id, expires_at, priority);

-- Limits are constraints rather than funding. Multiple policies may apply to
-- one request, such as a daily safety cap and a monthly account cap.
CREATE TABLE billing_limit_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    cadence TEXT NOT NULL
        CHECK (cadence IN ('day', 'week', 'month', 'year', 'lifetime')),
    timezone TEXT NOT NULL DEFAULT 'UTC',
    limit_usd NUMERIC(20, 12) NOT NULL CHECK (limit_usd >= 0),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE INDEX billing_limit_policies_account_idx
    ON billing_limit_policies (account_id, enabled);

CREATE TABLE billing_limit_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL
        REFERENCES billing_limit_policies(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation > 0),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    limit_usd NUMERIC(20, 12) NOT NULL CHECK (limit_usd >= 0),
    reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    committed_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
    overage_usd NUMERIC(20, 12) GENERATED ALWAYS AS (
        GREATEST(reserved_usd + committed_usd - limit_usd, 0)
    ) STORED,
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (window_end > window_start),
    UNIQUE (policy_id, generation, window_start)
);

CREATE INDEX billing_limit_windows_active_idx
    ON billing_limit_windows (account_id, window_end, superseded_at);

CREATE TABLE billing_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL UNIQUE,
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL,
    provider_request_id TEXT,
    state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (
            state IN (
                'reserved',
                'pending_reconciliation',
                'finalized',
                'released'
            )
        ),
    estimated_cost_usd NUMERIC(20, 12) NOT NULL
        CHECK (estimated_cost_usd >= 0),
    actual_cost_usd NUMERIC(20, 12),
    unfunded_cost_usd NUMERIC(20, 12) NOT NULL DEFAULT 0
        CHECK (unfunded_cost_usd >= 0),
    usage_source TEXT
        CHECK (
            usage_source IS NULL OR usage_source IN (
                'provider_reported',
                'calculated',
                'reconciled',
                'fallback',
                'manual'
            )
        ),
    reconciliation_reason TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at TIMESTAMPTZ,
    CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
    CHECK (
        state <> 'finalized'
        OR (actual_cost_usd IS NOT NULL AND finalized_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX billing_reservations_provider_request_idx
    ON billing_reservations (provider, provider_request_id)
    WHERE provider_request_id IS NOT NULL;

CREATE INDEX billing_reservations_reconciliation_idx
    ON billing_reservations (state, expires_at)
    WHERE state IN ('reserved', 'pending_reconciliation');

CREATE INDEX billing_reservations_account_created_idx
    ON billing_reservations (account_id, created_at DESC);

CREATE TABLE billing_reservation_funding_holds (
    reservation_id UUID NOT NULL
        REFERENCES billing_reservations(id) ON DELETE RESTRICT,
    funding_window_id UUID NOT NULL
        REFERENCES billing_funding_windows(id) ON DELETE RESTRICT,
    reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    committed_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
    CHECK (reserved_usd > 0 OR committed_usd > 0),
    PRIMARY KEY (reservation_id, funding_window_id)
);

CREATE INDEX billing_reservation_funding_holds_window_idx
    ON billing_reservation_funding_holds (funding_window_id);

CREATE TABLE billing_reservation_credit_holds (
    reservation_id UUID NOT NULL
        REFERENCES billing_reservations(id) ON DELETE RESTRICT,
    credit_grant_id UUID NOT NULL
        REFERENCES billing_credit_grants(id) ON DELETE RESTRICT,
    reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    committed_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
    CHECK (reserved_usd > 0 OR committed_usd > 0),
    PRIMARY KEY (reservation_id, credit_grant_id)
);

CREATE INDEX billing_reservation_credit_holds_grant_idx
    ON billing_reservation_credit_holds (credit_grant_id);

CREATE TABLE billing_reservation_limit_holds (
    reservation_id UUID NOT NULL
        REFERENCES billing_reservations(id) ON DELETE RESTRICT,
    limit_window_id UUID NOT NULL
        REFERENCES billing_limit_windows(id) ON DELETE RESTRICT,
    reserved_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    committed_usd NUMERIC(20, 12) NOT NULL DEFAULT 0 CHECK (committed_usd >= 0),
    PRIMARY KEY (reservation_id, limit_window_id)
);

CREATE INDEX billing_reservation_limit_holds_window_idx
    ON billing_reservation_limit_holds (limit_window_id);

-- The ledger is append-only. Mutable counters above are an enforcement
-- projection; ledger entries are the auditable record used to rebuild them.
CREATE TABLE billing_ledger_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
    reservation_id UUID
        REFERENCES billing_reservations(id) ON DELETE RESTRICT,
    direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
    category TEXT NOT NULL
        CHECK (
            category IN (
                'usage',
                'grant',
                'adjustment',
                'refund',
                'expiration'
            )
        ),
    amount_usd NUMERIC(20, 12) NOT NULL CHECK (amount_usd > 0),
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX billing_ledger_usage_reservation_idx
    ON billing_ledger_entries (reservation_id)
    WHERE category = 'usage';

CREATE INDEX billing_ledger_account_time_idx
    ON billing_ledger_entries (account_id, effective_at DESC);

-- Manual resets and policy changes are explicit audit events. A reset bumps a
-- policy generation and supersedes its current window; historical spend is
-- never deleted or rewritten.
CREATE TABLE billing_admin_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL,
    event_type TEXT NOT NULL
        CHECK (
            event_type IN (
                'funding_policy_created',
                'funding_policy_changed',
                'funding_policy_reset',
                'limit_policy_created',
                'limit_policy_changed',
                'limit_policy_reset',
                'credit_granted',
                'credit_changed',
                'manual_adjustment'
            )
        ),
    reason TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX billing_admin_events_account_time_idx
    ON billing_admin_events (account_id, created_at DESC);

-- migrate:down
-- Forward-only: fix mistakes with a new migration.
