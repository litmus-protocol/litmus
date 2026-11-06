-- ERC-8004 agent identity + reputation. agent_id links a contest to the warden's registered agent;
-- winner_agent_id is the breaker's agent (when the winner has one). *_feedback_status: none → posted | blocked | skipped.
ALTER TABLE contests ADD COLUMN agent_id INTEGER;
ALTER TABLE contests ADD COLUMN agent_feedback_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE contests ADD COLUMN agent_feedback_tx TEXT;
ALTER TABLE contests ADD COLUMN winner_agent_id INTEGER;
ALTER TABLE contests ADD COLUMN winner_feedback_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE contests ADD COLUMN winner_feedback_tx TEXT;
ALTER TABLE attempts ADD COLUMN agent_id INTEGER;
