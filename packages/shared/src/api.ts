import type { AgentCard, AgentPackage, CanaryTask, WardenSubmission } from "./schemas";
import type { ToolName } from "./constants";
import type { DeploymentName } from "./deployments";
import type { Erc8004AgentCard, FeedbackTag1 } from "./erc8004";
import type { OgModelInfo } from "./og-catalog";

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
  /**
   * Eligible models with their 0G on-chain providers (for the provider picker). `modelCatalog` says whether this
   * came from the live 0G Router catalog or the env fallback list (then providers are empty and pinning is off).
   */
  models?: OgModelInfo[];
  modelCatalog?: "router" | "static";
  attestations: Address | null;
  /** DefectCertificate for this arena deployment (Hedera), or null if none is deployed. */
  certificate: Address | null;
  /** Test-funds faucet (POST /faucet) amounts, or null when the gateway runs without one. */
  faucet: {
    hbar: string;
    usdc: string;
    /** POST /faucet needs a Privy access token (Authorization: Bearer); other wallets can't use it. */
    loginRequired: boolean;
  } | null;
  /** ERC-8004 identity and reputation registries, or null if not deployed. */
  erc8004: { identity: Address; reputation: Address } | null;
}

/** One way to pay for a resource: the fields of an x402 v2 PaymentRequirements. */
export interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  /** Base units of `asset`. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** One paid endpoint in GET /.well-known/x402: a message to one open contest. */
export interface X402Resource {
  /** Absolute URL to POST to; the same URL the 402 response names. */
  resource: string;
  type: "http";
  x402Version: 2;
  description: string;
  mimeType: "application/json";
  /** Exactly the requirements the endpoint's 402 answers with. */
  accepts: X402Accept[];
  input: {
    method: "POST";
    bodyType: "json";
    bodySchema: {
      type: "object";
      required: ["text"];
      properties: { text: { type: "string"; minLength: 1; maxLength: number } };
    };
  };
  metadata: {
    contestId: number;
    agentName: string;
    purpose: string;
    endTime: number;
    /** Decimal USDC. */
    pool: string;
    messagePrice: string;
    rules: string[];
  };
}

/**
 * GET /.well-known/x402: every paid endpoint the gateway serves right now, so an agent
 * can find one and pay it without being told a contest id.
 */
export interface X402Discovery {
  x402Version: 2;
  items: X402Resource[];
}

/** One run of the breaker bot started from the web app (POST /bot/runs). Times are unix ms. */
export interface BotRunView {
  runId: string;
  contestId: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  /** The bot's own log, oldest first: discovery, each paid message and reply, the outcome. */
  lines: string[];
  /** The conversation with the agent, oldest first; the last turn has no result while the agent is thinking. */
  turns: BotTurn[];
  /** The attack loop's outcome (broken_by_us, max_attempts, …); null while running or if it never started. */
  outcome: string | null;
  attempts: number;
  charged: number;
  usdcSpent: string;
  settlements: { txId: string; hashscan: string }[];
  winnings: string | null;
  error: string | null;
}

/** Which kind of rule the breaker bot is going after with a message. */
export type BotFocus = "transfer" | "secret" | "forbidden";

/** One message the breaker bot sent in a run, and the agent's answer. */
export interface BotTurn {
  /** 1-based message number within the run. */
  attempt: number;
  focus: BotFocus;
  text: string;
  /** The agent's answer; null while it is thinking, or when `error` says why there is none. */
  result: MessageResult | null;
  error: string | null;
}

/** GET /bot: the shared breaker bot wallet anyone can fund and run from the web app. */
export interface BotStatus {
  /** False when the gateway has no bot key or no attacker-model key. */
  enabled: boolean;
  accountId: string | null;
  address: Address | null;
  agentId: number | null;
  /** Decimal USDC in the bot wallet; null when the mirror node could not be read. */
  usdc: string | null;
  /** Paid messages per run, at most. */
  maxAttempts: number;
  /** The run in progress, if any; only one runs at a time. */
  active: BotRunView | null;
  /** The most recent run per contest id. */
  latest: Record<number, BotRunView>;
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
  /** 0G provider the agent is pinned to; null = Auto (the 0G Router picks). */
  providerAddress: Address | null;
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
  /** ERC-8004 agent the Warden linked to this contest, with the state of the reputation feedback written for it. */
  agent: { agentId: number; registry: string; feedback: AgentFeedbackStatus; feedbackTx: `0x${string}` | null } | null;
  /** ERC-8004 agent of the winning breaker (bounty feedback), when known. */
  winnerAgent: { agentId: number; feedback: AgentFeedbackStatus; feedbackTx: `0x${string}` | null } | null;
}

export type AgentFeedbackStatus = "none" | "posted" | "blocked" | "skipped";

/** `withheld`: the contest held, but its Chainlink CRE audit failed, so no certificate is minted. */
export type CertificateStatus = "pending" | "minted" | "reported" | "withheld";

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

/** One feedback entry on an agent's public record. `value` is a decimal string: "100", "0", or USDC like "1.035". */
export interface AgentRecordEntry {
  tag1: FeedbackTag1;
  deployment: DeploymentName;
  contestId: number;
  value: string;
  packageHash: `0x${string}` | null;
  /** Model and pinned 0G provider (null = Auto) of that contest, when this gateway has it. */
  inference?: { model: string; providerAddress: Address | null } | null;
  txHash: `0x${string}`;
  timestamp: number;
}

export interface AgentProfile {
  agentId: number;
  registry: string;
  owner: Address;
  cardUri: string;
  card: Erc8004AgentCard | null;
  record: AgentRecordEntry[];
  counts: { held: number; broken: number; bounties: number };
}

export type { WardenSubmission };
