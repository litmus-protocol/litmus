-- Faucet abuse limits: who asked for each grant. client_ip feeds the per-IP daily limit; claimant is the
-- Privy user id when the gateway requires a Privy login (one funded address per Privy user).
ALTER TABLE faucet_grants ADD COLUMN client_ip TEXT;
ALTER TABLE faucet_grants ADD COLUMN claimant TEXT;
CREATE INDEX faucet_grants_client_ip ON faucet_grants (client_ip, created_at);
CREATE INDEX faucet_grants_claimant ON faucet_grants (claimant);
