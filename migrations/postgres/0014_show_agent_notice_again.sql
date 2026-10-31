-- migrate:up
-- The agent notice is now a full-screen one; show it to everyone again.
UPDATE users SET agent_banner_dismissed_at = NULL;

-- migrate:down
-- A dismissal cannot be restored.
