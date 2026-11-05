// Values fixed by the build plan (§3 decisions, §8 contract constants).

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const X402_NETWORK = "hedera:testnet";
export const USDC_TOKEN_ID = "0.0.429274";
export const USDC_EVM_ADDRESS = "0x0000000000000000000000000000000000068cda" as const;

export const FEE_SPLIT_BPS = { pool: 7000, arena: 2000, warden: 1000 } as const;
export const MIN_BOND_PERCENT = 20;
export const MIN_MESSAGE_PRICE = "0.01";
export const DEFAULT_MESSAGE_PRICE = "0.05";
export const DEFAULT_MODEL = "0gm-1.0-35b-a3b";

export const WINDOW_SECONDS_PROD = 28_800;
export const REVEAL_GRACE_SECONDS = 600;
export const COMMIT_TTL_SECONDS = 1_800;
export const CHARGE_LATENCY_LIMIT_MS = 15_000;
export const CANARY_INTERVAL_SEC_PROD = 900;

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
