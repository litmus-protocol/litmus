-- Last on-chain vault and bond seen while a contest was active. The contract zeroes
-- both when a contest ends, so ended contests show these instead (like last_pool).
ALTER TABLE contests ADD COLUMN last_vault TEXT;
ALTER TABLE contests ADD COLUMN last_bond TEXT;
