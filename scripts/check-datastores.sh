#!/bin/sh
set -eu

POSTGRES_USER="${POSTGRES_USER:-hcai}"
POSTGRES_DB="${POSTGRES_DB:-hcai}"
CLICKHOUSE_USER="${CLICKHOUSE_USER:-hcai}"
CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-hcai}"

docker compose exec -T postgres \
  psql \
    --set ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" <<'SQL'
BEGIN;

DO $$
DECLARE
    account UUID := gen_random_uuid();
    funding_policy UUID := gen_random_uuid();
    funding_window UUID := gen_random_uuid();
BEGIN
    INSERT INTO billing_accounts (id, owner_type, owner_id)
    VALUES (account, 'user', gen_random_uuid());

    INSERT INTO billing_funding_policies (
        id,
        account_id,
        name,
        cadence,
        amount_usd
    )
    VALUES (funding_policy, account, 'Smoke-test daily allowance', 'day', 3);

    INSERT INTO billing_funding_windows (
        id,
        policy_id,
        account_id,
        generation,
        window_start,
        window_end,
        granted_usd
    )
    VALUES (
        funding_window,
        funding_policy,
        account,
        1,
        date_trunc('day', now()),
        date_trunc('day', now()) + INTERVAL '1 day',
        3
    );

    UPDATE billing_funding_windows
    SET reserved_usd = reserved_usd + 1
    WHERE id = funding_window
      AND reserved_usd + committed_usd + 1 <= granted_usd;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Could not reserve smoke-test funding';
    END IF;
END
$$;

ROLLBACK;
SQL

docker compose exec -T clickhouse \
  clickhouse-client \
    --user "$CLICKHOUSE_USER" \
    --password "$CLICKHOUSE_PASSWORD" \
    --multiquery <<'SQL'
INSERT INTO hcai.request_events
    (
        event_id,
        occurred_at,
        request_id,
        account_id,
        provider,
        request_body,
        response_body
    )
VALUES
    (
        toUUID('00000000-0000-0000-0000-000000000067'),
        now64(3),
        toUUID('00000000-0000-0000-0000-000000000067'),
        toUUID('00000000-0000-0000-0000-000000000067'),
        'datastore-smoke-test',
        '{"prompt":"six seven mango"}',
        '{"answer":"found"}'
    );

SELECT throwIf(
    count() = 0,
    'ClickHouse body phrase search returned no rows'
)
FROM hcai.request_events
WHERE
    provider = 'datastore-smoke-test'
    AND hasAllTokens(request_body, 'six seven mango')
    AND positionCaseInsensitiveUTF8(request_body, 'six seven mango') > 0;

DELETE FROM hcai.request_events
WHERE provider = 'datastore-smoke-test';
SQL

printf '%s\n' "PostgreSQL billing constraints and ClickHouse body search are working."
