-- Replicate predictions and files are created under one shared Replicate
-- account, so Replicate itself cannot tell users apart. This table records
-- which user created each resource so the proxy can scope reads, cancels and
-- deletes to their owner.

CREATE TABLE replicate_resources (
    kind TEXT NOT NULL CHECK (kind IN ('prediction', 'file')),
    id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, id)
);

CREATE INDEX replicate_resources_user_idx ON replicate_resources (user_id, created_at DESC);
