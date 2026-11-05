import { fromBaseUnits, toBaseUnits } from "@defect/shared";
import type {
  Address,
  Attestation,
  AttemptView,
  CanaryRoundView,
  ContestDetail,
  ContestSummary,
  DraftResponse,
  GatewayConfig,
  MessageResult,
  SessionSummary,
  Stats,
  WardenSubmission,
} from "@defect/shared";

/** The browser's testnet dev wallet (build plan §11.1). */
export interface DevWallet {
  privateKey: `0x${string}`;
  address: Address;
  accountId: string; // Hedera account id, e.g. 0.0.4829117
}

export interface Balances {
  hbar: string;
  usdc: string;
  usdcAssociated: boolean;
  withdrawable: string;
}

export interface TxResult {
  txHash: `0x${string}`;
  hashscan: string;
}

export type ContestListFilter = "active" | "ended" | "all";

/**
 * Everything the UI needs from the outside world. Two implementations:
 * mock (in-browser fake data) and live (gateway + Hedera + x402).
 * Pages and components only ever talk to this interface.
 */
export interface DefectClient {
  readonly mode: "mock" | "live";

  // Gateway reads
  getConfig(): Promise<GatewayConfig>;
  getStats(): Promise<Stats>;
  listContests(filter?: ContestListFilter): Promise<ContestSummary[]>;
  getContest(id: number): Promise<ContestDetail>;
  getSession(id: number, wallet: DevWallet): Promise<AttemptView[]>;
  getAttempts(id: number): Promise<AttemptView[]>;
  getCanaryRounds(id: number): Promise<CanaryRoundView[]>;
  getLog(id: number): Promise<{ text: string; logHash: `0x${string}` }>;
  getAttestation(id: number): Promise<Attestation | null>;

  // Paid message (x402)
  sendMessage(id: number, text: string, wallet: DevWallet): Promise<MessageResult>;

  // Wallet
  resolveWallet(privateKey: `0x${string}`): Promise<DevWallet>;
  getBalances(wallet: DevWallet): Promise<Balances>;
  associateUsdc(wallet: DevWallet): Promise<TxResult>;
  withdraw(wallet: DevWallet): Promise<TxResult>;

  // Warden flow
  createDraft(submission: WardenSubmission): Promise<DraftResponse>;
  ensureAllowance(wallet: DevWallet, amountUnits: bigint): Promise<TxResult | null>;
  createContestOnChain(wallet: DevWallet, draft: DraftResponse): Promise<TxResult & { contestId: number }>;
  confirmDraft(draftId: string, contestId: number): Promise<void>;

  // Breaker contract actions
  commitBreak(wallet: DevWallet, id: number, commitment: `0x${string}`): Promise<TxResult & { blockNumber: bigint }>;
  getBlockNumber(): Promise<bigint>;
  revealBreak(wallet: DevWallet, id: number, invariantIndex: number, secret: string, salt: `0x${string}`): Promise<TxResult>;
  closeHeld(wallet: DevWallet, id: number): Promise<TxResult>;
}

export function sessionsFromAttempts(attempts: AttemptView[], winner: Address | null, messagePrice: string): SessionSummary[] {
  const price = toBaseUnits(messagePrice);
  const map = new Map<string, SessionSummary & { charged: bigint }>();
  for (const a of attempts) {
    const key = a.breaker.toLowerCase();
    const s = map.get(key) ?? { breaker: a.breaker, messages: 0, paid: "0", isWinner: false, charged: 0n };
    s.messages += 1;
    if (a.charged) s.charged += 1n;
    s.isWinner = !!winner && winner.toLowerCase() === key;
    map.set(key, s);
  }
  return [...map.values()]
    .sort((a, b) => Number(b.isWinner) - Number(a.isWinner) || b.messages - a.messages)
    .map(({ charged, ...rest }) => ({ ...rest, paid: fromBaseUnits(charged * price) }));
}
