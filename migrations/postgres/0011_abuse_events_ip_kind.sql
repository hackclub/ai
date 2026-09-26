-- migrate:up
ALTER TABLE abuse_events DROP CONSTRAINT abuse_events_kind_check;
ALTER TABLE abuse_events ADD CONSTRAINT abuse_events_kind_check CHECK (kind IN (
    'app', 'user_agent', 'prompt', 'toolset',
    'similar_prompt', 'user_prompt', 'learned_toolset', 'ip'
));

-- migrate:down
DELETE FROM abuse_events WHERE kind = 'ip';
ALTER TABLE abuse_events DROP CONSTRAINT abuse_events_kind_check;
ALTER TABLE abuse_events ADD CONSTRAINT abuse_events_kind_check CHECK (kind IN (
    'app', 'user_agent', 'prompt', 'toolset',
    'similar_prompt', 'user_prompt', 'learned_toolset'
));
