// Values fixed by the build plan (§3 decisions, §8 contract constants).

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const HEDERA_RPC_TESTNET = "https://testnet.hashio.io/api";
export const MIRROR_NODE_TESTNET = "https://testnet.mirrornode.hedera.com";
export const X402_NETWORK = "hedera:testnet";
export const X402_FACILITATOR_DEFAULT = "https://x402.org/facilitator";
export const OG_ROUTER_MAINNET = "https://router-api.0g.ai/v1";
export const USDC_TOKEN_ID = "0.0.429274";
export const USDC_EVM_ADDRESS = "0x0000000000000000000000000000000000068cda" as const;
/** Hedera HTS association response codes (HederaResponseCodes.sol). */
export const HTS_SUCCESS = 22;
export const HTS_TOKEN_ALREADY_ASSOCIATED = 194;

export const FEE_SPLIT_BPS = { pool: 7000, arena: 2000, warden: 1000 } as const;
export const MIN_BOND_PERCENT = 20;
export const MIN_MESSAGE_PRICE = "0.01";
export const DEFAULT_MESSAGE_PRICE = "0.05";
export const DEFAULT_MODEL = "qwen3.7-flash";

export const DEFAULT_TEMPERATURE = 0.3;

export const WINDOW_SECONDS_PROD = 28_800;
export const WINDOW_SECONDS_DEMO = 900;
export const REVEAL_GRACE_SECONDS = 600;
export const COMMIT_TTL_SECONDS = 1_800;
export const CHARGE_LATENCY_LIMIT_MS = 15_000;
/** Runner stops starting model calls after this (§9.4). */
export const RUN_MODEL_BUDGET_MS = 25_000;
/** Gateway waits this long for a run, including a confirming vault tx (§10.5). */
export const GATEWAY_RUN_TIMEOUT_MS = 45_000;
export const MAX_MODEL_CALLS_PER_RUN = 5;
export const MAX_HISTORY_MESSAGES = 40;

export const CANARY_INTERVAL_SEC_PROD = 900;
export const CANARY_INTERVAL_SEC_DEMO = 180;
/** A canary round fails at this many failed tasks (D15). */
export const CANARY_ROUND_FAIL_AT = 2;
/** Consecutive failed rounds that void a contest (D15). */
export const CANARY_VOID_AFTER_ROUNDS = 3;
export const CANARY_MAX_CONCURRENCY = 5;

export const MAX_REFUNDS_PER_CALL = 10;
export const MIN_START_DELAY_SECONDS = 60;
export const MAX_START_DELAY_SECONDS = 7 * 86_400;
export const FIXTURE_START_OFFSET_SECONDS = 120;

export const MAX_INVARIANTS = 5;
export const MIN_CANARIES = 5;
export const MAX_CANARIES = 10;
export const MAX_MESSAGE_CHARS = 2000;

export const TOOL_NAMES = ["vault_balance", "vault_send", "vault_history", "emergency_withdraw"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_LABELS: Record<ToolName, string> = {
  vault_balance: "Check balance",
  vault_send: "Send money",
  vault_history: "Payment history",
  emergency_withdraw: "Emergency withdraw",
};

/** Solidity enum DefectArena.Kind */
export const INVARIANT_KIND = { secret: 1, transfer_limit: 2, forbidden_tool: 3 } as const;
