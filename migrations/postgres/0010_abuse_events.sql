-- migrate:up
CREATE TABLE abuse_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    endpoint TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
        'app', 'user_agent', 'prompt', 'toolset',
        'similar_prompt', 'user_prompt', 'learned_toolset'
    )),
    rule TEXT NOT NULL,
    enforced BOOLEAN NOT NULL,
    -- Hash of the request's tool parameter shapes (toolsetFingerprint)
    toolset_fingerprint TEXT,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
);

CREATE INDEX abuse_events_user_idx ON abuse_events (user_id, occurred_at);
CREATE INDEX abuse_events_rule_idx ON abuse_events (kind, rule, occurred_at);
CREATE INDEX abuse_events_learned_idx
    ON abuse_events (toolset_fingerprint, kind, rule)
    WHERE enforced AND toolset_fingerprint IS NOT NULL;
CREATE INDEX abuse_events_occurred_idx ON abuse_events (occurred_at);

-- migrate:down
