-- Browser sessions for the dashboard, created by the Hack Club OAuth
-- callback. Tokens are stored as SHA-256 digests like API keys.

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

ALTER TABLE users
    ADD COLUMN agent_banner_dismissed_at TIMESTAMPTZ;
