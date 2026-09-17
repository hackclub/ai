-- Users and API keys. Every user owns exactly one billing account
-- (billing_accounts.owner_type = 'user', owner_id = users.id); the
-- application creates the account and its default daily allowance when the
-- user is created, see src/auth/users.ts.

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slack_id TEXT NOT NULL UNIQUE,
    email TEXT,
    name TEXT,
    avatar TEXT,
    is_banned BOOLEAN NOT NULL DEFAULT false,
    is_idv_verified BOOLEAN NOT NULL DEFAULT false,
    skip_idv BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX users_email_idx ON users (email);

-- Keys are stored only as a SHA-256 digest. The key material is high entropy
-- (256 random bits), so an unsalted digest is sufficient and allows an exact
-- index lookup. key_prefix is the displayable head of the key.
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash BYTEA NOT NULL UNIQUE CHECK (length(key_hash) = 32),
    key_prefix TEXT NOT NULL CHECK (length(key_prefix) BETWEEN 1 AND 24),
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX api_keys_user_active_idx
    ON api_keys (user_id)
    WHERE revoked_at IS NULL;
