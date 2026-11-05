-- Build plan §10.2, plus the columns listed in docs/DEVIATIONS.md (P4).

CREATE TABLE drafts (
  draft_id TEXT PRIMARY KEY,
  submission_json TEXT NOT NULL,     -- WardenSubmission exactly as received
  package_hash TEXT NOT NULL,
  canary_hash TEXT NOT NULL,
  secret_hashes_json TEXT NOT NULL,  -- {"inv-2":"0x…"}
  created_at INTEGER NOT NULL,
  contest_id INTEGER                 -- set on confirm
);

CREATE TABLE contests (
  contest_id INTEGER PRIMARY KEY,    -- on-chain id
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  warden TEXT NOT NULL,              -- lowercased EVM address
  card_json TEXT NOT NULL,
  package_json TEXT NOT NULL,        -- with placeholders, never secrets
  invariants_json TEXT NOT NULL,
  canaries_json TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  message_price TEXT NOT NULL,       -- base units
  status TEXT NOT NULL,              -- active | broken | held | void | cancelled
  winner TEXT,
  broken_invariant INTEGER,
  ended_at INTEGER,                  -- unix seconds, set when the status leaves active
  final_pool TEXT,                   -- base units: pool paid out or returned at the end
  last_pool TEXT,                    -- base units: last on-chain pool seen while active
  secrets_json TEXT,                 -- filled only after the contest ends
  log_hash TEXT,
  loaded INTEGER NOT NULL DEFAULT 0, -- 1 once the runner's load returned 200
  finalized INTEGER NOT NULL DEFAULT 0,
  consecutive_failed_rounds INTEGER NOT NULL DEFAULT 0,
  last_passing_round_at INTEGER      -- unix seconds; NULL means "since start"
);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  contest_id INTEGER NOT NULL REFERENCES contests(contest_id),
  breaker TEXT NOT NULL,             -- lowercased EVM address
  payer_account TEXT NOT NULL,       -- Hedera account id 0.0.x
  text TEXT NOT NULL,
  reply TEXT,
  tool_calls_json TEXT,              -- RunResult.toolCalls
  og_json TEXT,                      -- RunResult.og
  started_at INTEGER NOT NULL,       -- unix ms
  latency_ms INTEGER,
  outcome TEXT NOT NULL,             -- pending | charged | free_late | free_error | settle_failed
  amount TEXT NOT NULL,              -- price in base units
  settle_tx TEXT,                    -- Hedera tx id "0.0.x@secs.nanos"
  settled_at INTEGER,                -- unix seconds
  deposit_status TEXT NOT NULL DEFAULT 'none',  -- none | pending | done | failed | refunded_direct
  deposit_tx TEXT,
  deposit_tries INTEGER NOT NULL DEFAULT 0,
  deposit_next_at INTEGER,           -- unix ms; earliest next deposit try
  payment_id TEXT UNIQUE,            -- keccak256 of the signed Hedera transaction in the x402 payload (replay guard)
  refunded INTEGER NOT NULL DEFAULT 0,
  refund_tx TEXT,
  broke INTEGER NOT NULL DEFAULT 0,
  record_hash TEXT,
  signature TEXT
);
CREATE INDEX attempts_session ON attempts(contest_id, breaker, started_at);
CREATE UNIQUE INDEX attempts_one_pending ON attempts(contest_id, breaker) WHERE outcome = 'pending';

CREATE TABLE canary_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id INTEGER NOT NULL REFERENCES contests(contest_id),
  round INTEGER NOT NULL,
  started_at INTEGER NOT NULL,       -- unix seconds
  results_json TEXT NOT NULL,        -- [{taskId, passed, reasons:[…], ogRequestIds:[…]}]
  failures INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  action TEXT NOT NULL,              -- none | refund | void
  action_tx TEXT,
  record_hash TEXT,
  signature TEXT
);

CREATE TABLE account_map (           -- Hedera account id → EVM address cache
  account_id TEXT PRIMARY KEY,
  evm_address TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
