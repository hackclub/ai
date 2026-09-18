CREATE DATABASE IF NOT EXISTS hcai;

CREATE TABLE IF NOT EXISTS hcai.request_events
(
    event_id UUID,
    event_version UInt64 DEFAULT 1,
    occurred_at DateTime64(3, 'UTC'),
    request_id UUID,
    reservation_id Nullable(UUID),
    account_id UUID,
    user_id Nullable(UUID),
    api_key_id Nullable(UUID),

    provider LowCardinality(String),
    provider_request_id String,
    endpoint LowCardinality(String),
    model LowCardinality(String),
    outcome LowCardinality(String),
    error_code LowCardinality(String),
    http_status UInt16,
    streamed Bool,

    duration_ms UInt64,
    time_to_first_byte_ms Nullable(UInt64),
    input_tokens UInt64,
    output_tokens UInt64,
    estimated_cost_usd Decimal(20, 12),
    provider_cost_usd Nullable(Decimal(20, 12)),
    billed_cost_usd Decimal(20, 12),
    usage_source LowCardinality(String),

    request_headers Map(LowCardinality(String), String),
    response_headers Map(LowCardinality(String), String),
    attributes Map(LowCardinality(String), String),
    request_body String CODEC(ZSTD(3)) TTL toDateTime(occurred_at) + INTERVAL 90 DAY,
    response_body String CODEC(ZSTD(3)) TTL toDateTime(occurred_at) + INTERVAL 90 DAY,

    INDEX request_body_text request_body
        TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1,
    INDEX response_body_text response_body
        TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(event_version)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (account_id, toDate(occurred_at), occurred_at, event_id);

-- Fast phrase investigations should first use the text index to narrow rows,
-- then verify exact adjacency against the original body:
--
-- SELECT request_id, occurred_at, request_body, response_body
-- FROM hcai.request_events
-- WHERE
--   (
--     hasAllTokens(request_body, 'six seven mango')
--     AND positionCaseInsensitiveUTF8(request_body, 'six seven mango') > 0
--   )
--   OR
--   (
--     hasAllTokens(response_body, 'six seven mango')
--     AND positionCaseInsensitiveUTF8(response_body, 'six seven mango') > 0
--   )
-- ORDER BY occurred_at DESC;
