-- migrate:up
-- Prompt tokens a provider bills per image input, learned from settled
-- requests. The proxy reserves image inputs at this rate.
CREATE TABLE model_image_tokens (
    model_id TEXT PRIMARY KEY,
    tokens_per_image INTEGER NOT NULL CHECK (tokens_per_image > 0),
    samples BIGINT NOT NULL DEFAULT 1 CHECK (samples > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE model_image_tokens;
