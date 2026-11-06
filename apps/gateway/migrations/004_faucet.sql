-- Test-funds faucet (POST /faucet): each address gets each asset once. A row is inserted as
-- 'pending' before the transfer (the primary key doubles as a lock against parallel requests),
-- set to 'done' after it, and deleted if the transfer fails so the address can try again.
CREATE TABLE faucet_grants (
  address    TEXT NOT NULL,
  asset      TEXT NOT NULL CHECK (asset IN ('hbar', 'usdc')),
  amount     TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  tx_hash    TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (address, asset)
);
CREATE INDEX faucet_grants_created_at ON faucet_grants (created_at);
