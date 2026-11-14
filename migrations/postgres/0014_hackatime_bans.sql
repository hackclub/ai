-- migrate:up
-- Set while the user is banned (red trust level) on Hackatime; the
-- hackatime.sync_bans cron sets and clears it. Separate from is_banned so
-- lifting a Hackatime ban never lifts one an HCAI admin made.
ALTER TABLE users ADD COLUMN hackatime_banned_at TIMESTAMPTZ;

-- migrate:down
ALTER TABLE users DROP COLUMN hackatime_banned_at;
