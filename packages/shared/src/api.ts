import type { AgentCard, AgentPackage, CanaryTask, WardenSubmission } from "./schemas";
import type { ToolName } from "./constants";

// Gateway response shapes (build plan §10.3, §10.5). Amounts are decimal strings
// unless the field name ends in "Units". Times are unix seconds unless noted.

export type Address = `0x${string}`;

export type ContestPhase = "scheduled" | "open" | "awaiting_close" | "broken" | "held" | "void" | "cancelled";

export const ENDED_PHASES: ContestPhase[] = ["broken", "held", "void", "cancelled"];

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface GatewayConfig {
  network: string;
  chainId: number;
  arena: Address;
  deployment: "prod" | "demo";
  usdcTokenId: string;
  usdcEvm: Address;
  operatorAccountId: string;
  windowSeconds: number;
  revealGraceSeconds: number;
  canaryIntervalSec: number;
  mirrorNodeUrl: string;
  hashscanBaseUrl: string;
  allowedModels: string[];
  attestations: Address | null;
  /** DefectCertificate for this arena deployment (Hedera), or null if none is deployed. */
  certificate: Address | null;
  /** Test-funds faucet (POST /faucet) amounts, or null when the gateway runs without one. */
  faucet: { hbar: string; usdc: string } | null;
}

export interface Stats {
  contests: number;
  attempts: number;
  ogRequests: number;
  ogTotalCost: string;
  paidToBreakers: string;
}

export type PublicInvariant =
  | { id: string; text: string; type: "secret"; secretHash: `0x${string}` }
  | { id: string; text: string; type: "transfer_limit"; maxAmount: string }
  | { id: string; text: string; type: "forbidden_tool"; tool: "emergency_withdraw" };

/**
 * `pool` is the live on-chain pool while a contest runs. For ended contests the
 * gateway returns the final pool (the amount paid to the winner or returned to
 * the Warden), because the on-chain value is zeroed at the end.
 */
export interface ContestSummary {
  contestId: number;
  card: AgentCard;
  phase: ContestPhase;
  startTime: number;
  endTime: number;
  messagePrice: string;
  pool: string;
  messageCount: number;
  ruleCount: number;
  winner: Address | null;
  brokenInvariant: number | null;
  brokenRuleText: string | null;
}

export interface ContestDetail extends Omit<ContestSummary, "ruleCount" | "brokenRuleText"> {
  warden: Address;
  /** When the contest broke or was closed (unix seconds); null while active. */
  endedAt: number | null;
  vault: string;
  bond: string;
  escrow: string;
  invariants: PublicInvariant[];
  tools: ToolName[];
  model: string;
  packageHash: `0x${string}`;
  canaryHash: `0x${string}`;
  stats: { attempts: number; breakers: number; ogRequests: number };
  canary: { rounds: number; consecutiveFailed: number; lastRoundAt: number | null; lastRoundPassed: boolean | null };
  revealed: {
    package: AgentPackage;
    canaries: CanaryTask[];
    secrets: Record<string, string>;
    logHash: `0x${string}` | null;
  } | null;
  /**
   * Held certificate NFT (§8.9). null unless the contest ended Held and a certificate contract is deployed.
   * "pending" until the gateway mints it (after finalization); tokenId always equals contestId.
   */
  certificate: {
    address: Address;
    tokenId: number;
    status: CertificateStatus;
    txHash: `0x${string}` | null;
  } | null;
}

export type CertificateStatus = "pending" | "minted" | "reported";

export interface ToolCallView {
  name: ToolName;
  args: unknown;
  result: unknown;
  txHash: `0x${string}` | null;
  broke: boolean;
}

export interface OgEvidence {
  requestId: string;
  provider: string;
  totalCost: string;
  teeVerified: boolean | null;
}

export type AttemptOutcome = "pending" | "charged" | "free_late" | "free_error" | "settle_failed";

export interface MessageResult {
  attemptId: string;
  reply: string;
  toolCalls: ToolCallView[];
  charged: boolean;
  latencyMs: number;
  settlement: { txId: string; hashscan: string } | null;
  og: OgEvidence[];
  contestBroken: boolean;
}

export interface AttemptView extends MessageResult {
  contestId: number;
  breaker: Address;
  text: string;
  startedAt: number; // unix ms
  outcome: AttemptOutcome;
}

export interface SessionSummary {
  breaker: Address;
  messages: number;
  paid: string;
  isWinner: boolean;
}

export interface CanaryRoundView {
  round: number;
  startedAt: number;
  failures: number;
  passed: boolean;
  action: "none" | "refund" | "void";
  results: { taskId: string; passed: boolean }[] | null;
}

export interface DraftResponse {
  draftId: string;
  packageHash: `0x${string}`;
  canaryHash: `0x${string}`;
  invariantsOnchain: { kind: 1 | 2 | 3; secretHash: `0x${string}`; maxAmount: string }[];
  startTime: number;
  messagePriceUnits: string;
  poolUnits: string;
  vaultUnits: string;
  bondUnits: string;
  approveTotalUnits: string;
}

export interface Attestation {
  status: number;
  logHashMatches: boolean;
  canaryHashMatches: boolean;
  secretsMatch: boolean;
  messageCount: number;
  attemptsInLog: number;
  attestedAt: number;
  txHash: `0x${string}` | null;
}

/** POST /faucet body: the EVM address (ECDSA alias) to fund on Hedera testnet. */
export interface FaucetRequest {
  address: Address;
}

/**
 * Per asset: "sent" now, "already_sent" earlier (each address gets each asset once),
 * "needs_account" (no Hedera account at this address yet: wait for the HBAR to create it),
 * "needs_association" (USDC must be enabled first; that also completes a new account),
 * "unavailable" (the faucet itself is out of this asset).
 */
export type FaucetGrantStatus = "sent" | "already_sent" | "needs_account" | "needs_association" | "unavailable";

export interface FaucetGrant {
  status: FaucetGrantStatus;
  /** Decimal amount (HBAR or USDC). */
  amount: string;
  txHash: `0x${string}` | null;
}

export interface FaucetResponse {
  address: Address;
  /** Hedera account at this address when the request was handled (null: not created yet). */
  accountId: string | null;
  hbar: FaucetGrant;
  usdc: FaucetGrant;
}

export type { WardenSubmission };
