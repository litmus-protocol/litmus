import { fromBaseUnits, toBaseUnits } from "@defect/shared";
import type {
  Address,
  Attestation,
  AttemptView,
  CanaryRoundView,
  ContestDetail,
  ContestSummary,
  DraftResponse,
  FaucetResponse,
  GatewayConfig,
  MessageResult,
  SessionSummary,
  Stats,
  WardenSubmission,
} from "@defect/shared";

/** ERC-721 metadata of a Held certificate, as DefectCertificate.tokenJson returns it. */
export interface CertificateMetadata {
  name: string;
  description: string;
  /** data:image/svg+xml;base64,… generated on chain. */
  image: string;
  attributes: { trait_type: string; value: string | number; display_type?: string }[];
}

interface WalletBase {
  /** The address DefectArena sees as msg.sender (ECDSA alias, or long-zero for ED25519 accounts). */
  address: Address;
  accountId: string; // Hedera account id, e.g. 0.0.4829117
}

/** Testnet dev wallet: a pasted ECDSA key kept in this browser (build plan §11.1). */
export interface KeyWallet extends WalletBase {
  kind: "key";
  privateKey: `0x${string}`;
}

/** A Hedera wallet (HashPack, Kabila, …) connected through WalletConnect; it holds the key. */
export interface ConnectedWallet extends WalletBase {
  kind: "walletconnect";
  walletName: string;
  keyType: "ED25519" | "ECDSA_SECP256K1";
}

/**
 * A Privy embedded wallet (email / Google login). Its EVM address is the account's ECDSA alias.
 * A new user has no Hedera account until something sends HBAR to that address (the faucet), and
 * the account is "hollow" (no key) until its first signed transaction (enabling USDC).
 */
export interface PrivyWallet extends WalletBase {
  kind: "privy";
  /** The login (email address) for display. */
  label: string;
  /** "" until a Hedera account exists at the address. */
  accountId: string;
  /** Account exists and has its key (not hollow), so it can pay x402 messages. */
  activated: boolean;
}

export type Wallet = KeyWallet | ConnectedWallet | PrivyWallet;

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
  getSession(id: number, wallet: Wallet): Promise<AttemptView[]>;
  getAttempts(id: number): Promise<AttemptView[]>;
  getCanaryRounds(id: number): Promise<CanaryRoundView[]>;
  getLog(id: number): Promise<{ text: string; logHash: `0x${string}` }>;
  getAttestation(id: number): Promise<Attestation | null>;
  /** Held certificate NFT metadata (DefectCertificate.tokenJson), or null if not minted yet. */
  getCertificate(id: number): Promise<CertificateMetadata | null>;

  // Paid message (x402)
  sendMessage(id: number, text: string, wallet: Wallet): Promise<MessageResult>;

  // Wallet
  resolveWallet(privateKey: `0x${string}`): Promise<KeyWallet>;
  /** Looks up a WalletConnect-shared account (address the contract will see, key type). */
  resolveAccount(accountId: string, walletName: string): Promise<ConnectedWallet>;
  getBalances(wallet: Wallet): Promise<Balances>;
  associateUsdc(wallet: Wallet): Promise<TxResult>;
  /** Test funds from the gateway faucet (POST /faucet), once per address and asset. */
  requestTestFunds(address: Address): Promise<FaucetResponse>;
  withdraw(wallet: Wallet): Promise<TxResult>;

  // Warden flow
  createDraft(submission: WardenSubmission): Promise<DraftResponse>;
  ensureAllowance(wallet: Wallet, amountUnits: bigint): Promise<TxResult | null>;
  createContestOnChain(wallet: Wallet, draft: DraftResponse): Promise<TxResult & { contestId: number }>;
  confirmDraft(draftId: string, contestId: number): Promise<void>;

  // Breaker contract actions
  commitBreak(wallet: Wallet, id: number, commitment: `0x${string}`): Promise<TxResult & { blockNumber: bigint }>;
  getBlockNumber(): Promise<bigint>;
  revealBreak(wallet: Wallet, id: number, invariantIndex: number, secret: string, salt: `0x${string}`): Promise<TxResult>;
  closeHeld(wallet: Wallet, id: number): Promise<TxResult>;
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
