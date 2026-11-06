import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAbiItem,
  toEventSelector,
  defineChain,
  http,
  pad,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  HEDERA_TESTNET_CHAIN_ID,
  USDC_EVM_ADDRESS,
  attestationsAbi,
  certificateAbi,
  defectArenaAbi,
  erc20Abi,
  identityRegistryAbi,
  reputationRegistryAbi,
} from "@defect/shared";
import { SerialQueue } from "./queue";

/** phase() codes (build plan §8.3). */
export const PHASE = {
  None: 0,
  Scheduled: 1,
  Open: 2,
  AwaitingClose: 3,
  Broken: 4,
  Held: 5,
  Void: 6,
  Cancelled: 7,
} as const;

/** DefectArena.Status enum. */
export const STATUS = { None: 0, Active: 1, Broken: 2, Held: 3, Void: 4, Cancelled: 5 } as const;

export interface OnchainContest {
  warden: Address;
  status: number;
  startTime: number;
  endTime: number;
  messageCount: number;
  brokenInvariant: number;
  winner: Address;
  messagePrice: bigint;
  initialPool: bigint;
  pool: bigint;
  vault: bigint;
  bond: bigint;
  escrow: bigint;
  packageHash: Hex;
  canaryHash: Hex;
  logHash: Hex;
}

export interface OnchainInvariant {
  kind: number;
  secretHash: Hex;
  maxAmount: bigint;
}

/** One decoded DefectArena event for a contest, with the EVM tx hash that emitted it. */
export interface ArenaEvent {
  name: string;
  args: Record<string, unknown>;
  txHash: Hex;
  timestamp: number;
}

export class ChainRevertError extends Error {
  constructor(readonly errorName: string) {
    super(`Contract reverted: ${errorName}`);
    this.name = "ChainRevertError";
  }
}

/** One NewFeedback log the operator posted for an agent, with the tx that emitted it. */
export interface FeedbackEvent {
  index: number;
  tag1: string;
  tag2: string;
  value: bigint;
  valueDecimals: number;
  feedbackURI: string;
  txHash: Hex;
  timestamp: number;
}

/** One feedback entry the operator left for an agent, as read from the reputation registry. */
export interface DefectFeedback {
  index: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

export interface GiveFeedbackInput {
  agentId: number;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export interface Erc8004Addresses {
  identity: Address;
  reputation: Address;
}

export interface GatewayChain {
  readonly operatorAddress: Address;
  /** ERC-8004 registries; null when none are deployed/configured. */
  readonly erc8004: Erc8004Addresses | null;
  phase(contestId: number): Promise<number>;
  getContest(contestId: number): Promise<OnchainContest>;
  getInvariants(contestId: number): Promise<OnchainInvariant[]>;
  windowSeconds(): Promise<number>;
  usdcAllowance(owner: Address, spender: Address): Promise<bigint>;
  approveUsdc(spender: Address, amount: bigint): Promise<Hex>;
  transferUsdc(to: Address, amount: bigint): Promise<Hex>;
  depositFee(contestId: number, breaker: Address, amount: bigint, paymentRef: Hex): Promise<Hex>;
  refund(contestId: number, breakers: Address[], amounts: bigint[]): Promise<Hex>;
  voidContest(contestId: number, breakers: Address[], amounts: bigint[]): Promise<Hex>;
  cancel(contestId: number): Promise<Hex>;
  closeHeld(contestId: number): Promise<Hex>;
  postLogHash(contestId: number, logHash: Hex): Promise<Hex>;
  /** DefectArena events for one contest, oldest first (read from the mirror node). */
  contestEvents(contestId: number, sinceUnix: number): Promise<ArenaEvent[]>;
  /** Held certificate (§8.9) for a contest, or null when no DefectCertificate is configured. */
  certificateState(contestId: number): Promise<CertificateState | null>;
  mintCertificate(contestId: number): Promise<Hex>;
  reportCertificate(contestId: number, uniqueBreakers: number, agentName: string): Promise<Hex>;
  /** The contest's Chainlink CRE attestation on Sepolia; null while none is posted or no DefectAttestations is configured. */
  attestation(contestId: number): Promise<AttestationResult | null>;
  /** Owner of an ERC-8004 agent NFT; null when the agent doesn't exist or no registries are configured. */
  agentOwner(agentId: number): Promise<Address | null>;
  agentWallet(agentId: number): Promise<Address | null>;
  isAgentOperator(spender: Address, agentId: number): Promise<boolean>;
  agentURI(agentId: number): Promise<string>;
  /** Feedback the operator has left for an agent (includes revoked entries). */
  readDefectFeedback(agentId: number): Promise<DefectFeedback[]>;
  giveFeedback(f: GiveFeedbackInput): Promise<Hex>;
  /** The operator's NewFeedback events for an agent, oldest first (read from the mirror node). */
  feedbackEvents(agentId: number): Promise<FeedbackEvent[]>;
}

/** One DefectAttestations entry (§13.2): what the CRE auditor found for a finished contest. */
export interface AttestationResult {
  /** DefectArena status the auditor read (STATUS). */
  status: number;
  logHashMatches: boolean;
  canaryHashMatches: boolean;
  secretsMatch: boolean;
  /** Charged messages: on chain, and counted in the published log. */
  messageCount: number;
  attemptsInLog: number;
}

/** A Held contest whose audit agrees with the chain on everything: the only case that earns a certificate. */
export function auditPassed(a: AttestationResult): boolean {
  return a.status === STATUS.Held && a.logHashMatches && a.canaryHashMatches && a.secretsMatch && a.messageCount === a.attemptsInLog;
}

export interface CertificateState {
  minted: boolean;
  reported: boolean;
  /** messageCount stored in the certificate (0 before minting). */
  messageCount: number;
}

/** Fallback gas when estimation fails (build plan §8.7). */
const GAS_FALLBACK = {
  approve: 1_000_000n,
  transfer: 1_000_000n,
  depositFee: 2_000_000n,
  refund: 8_000_000n,
  voidContest: 8_000_000n,
  cancel: 2_500_000n,
  closeHeld: 2_500_000n,
  postLogHash: 300_000n,
  mintCertificate: 1_500_000n,
  reportCertificate: 500_000n,
  giveFeedback: 1_500_000n,
} as const;
const HEDERA_TX_GAS_CAP = 15_000_000n;
/** Per-request limit for mirror-node log reads. */
const MIRROR_TIMEOUT_MS = 10_000;
/** How long the cached registry feedback log is served before an incremental refresh. */
export const FEEDBACK_CACHE_TTL_MS = 30_000;

type CachedFeedbackEvent = FeedbackEvent & { agentId: number };

export function hederaTestnet(rpcUrl: string): Chain {
  return defineChain({
    id: HEDERA_TESTNET_CHAIN_ID,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Custom-error name from a viem contract error, or null if it isn't a contract revert. */
export function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? "Reverted";
  }
  return null;
}

export interface ViemGatewayChainOptions {
  arena: Address;
  /** DefectCertificate for this arena; null disables certificates. */
  certificate?: Address | null;
  /** DefectAttestations on Sepolia; null means no audit can ever be read, so no certificate is minted. */
  attestations?: Address | null;
  sepoliaRpcUrl?: string;
  /** ERC-8004 identity + reputation registries; null disables the agent-identity features. */
  erc8004?: Erc8004Addresses | null;
  privateKey: Hex;
  rpcUrl: string;
  mirrorNodeUrl: string;
  chain?: Chain;
  pollingInterval?: number;
  fetchFn?: typeof fetch;
  /** Operator write queue; pass one to share the operator nonce with another writer (the faucet). */
  writes?: SerialQueue;
  /** Milliseconds clock for the feedback cache TTL; overridable in tests. */
  nowMs?: () => number;
}

export class ViemGatewayChain implements GatewayChain {
  readonly operatorAddress: Address;
  readonly erc8004: Erc8004Addresses | null;
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly arena: Address;
  private readonly certificate: Address | null;
  private readonly attestations: Address | null;
  private readonly sepoliaClient: PublicClient | null;
  private readonly mirrorNodeUrl: string;
  private readonly fetchFn: typeof fetch;
  /** One operator nonce: every write goes through this queue (§10.1). */
  private readonly writes: SerialQueue;
  private readonly nowMs: () => number;
  /** Every operator NewFeedback on the reputation registry seen so far (see feedbackEvents). */
  private feedbackLog: { events: CachedFeedbackEvent[]; lastTimestamp: string | null; fetchedAt: number | null } = {
    events: [],
    lastTimestamp: null,
    fetchedAt: null,
  };
  private feedbackRefresh: Promise<void> | null = null;

  constructor(opts: ViemGatewayChainOptions) {
    const chain = opts.chain ?? hederaTestnet(opts.rpcUrl);
    this.account = privateKeyToAccount(opts.privateKey);
    this.operatorAddress = this.account.address;
    this.arena = opts.arena;
    this.certificate = opts.certificate ?? null;
    this.attestations = opts.attestations ?? null;
    this.sepoliaClient = this.attestations ? createPublicClient({ chain: sepolia, transport: http(opts.sepoliaRpcUrl) }) : null;
    this.erc8004 = opts.erc8004 ?? null;
    this.mirrorNodeUrl = opts.mirrorNodeUrl;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.writes = opts.writes ?? new SerialQueue();
    this.nowMs = opts.nowMs ?? Date.now;
    const transport = http(opts.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: opts.pollingInterval ?? 1_000 });
    this.walletClient = createWalletClient({ chain, transport, account: this.account });
  }

  async phase(contestId: number): Promise<number> {
    return Number(await this.read("phase", [BigInt(contestId)]));
  }

  async getContest(contestId: number): Promise<OnchainContest> {
    const c = (await this.read("getContest", [BigInt(contestId)])) as {
      warden: Address;
      status: number;
      startTime: bigint;
      endTime: bigint;
      messageCount: number;
      brokenInvariant: number;
      winner: Address;
      messagePrice: bigint;
      initialPool: bigint;
      pool: bigint;
      vault: bigint;
      bond: bigint;
      escrow: bigint;
      packageHash: Hex;
      canaryHash: Hex;
      logHash: Hex;
    };
    return {
      warden: c.warden.toLowerCase() as Address,
      status: Number(c.status),
      startTime: Number(c.startTime),
      endTime: Number(c.endTime),
      messageCount: Number(c.messageCount),
      brokenInvariant: Number(c.brokenInvariant),
      winner: c.winner.toLowerCase() as Address,
      messagePrice: c.messagePrice,
      initialPool: c.initialPool,
      pool: c.pool,
      vault: c.vault,
      bond: c.bond,
      escrow: c.escrow,
      packageHash: c.packageHash,
      canaryHash: c.canaryHash,
      logHash: c.logHash,
    };
  }

  async getInvariants(contestId: number): Promise<OnchainInvariant[]> {
    const invs = (await this.read("getInvariants", [BigInt(contestId)])) as { kind: number; secretHash: Hex; maxAmount: bigint }[];
    return invs.map((i) => ({ kind: Number(i.kind), secretHash: i.secretHash, maxAmount: i.maxAmount }));
  }

  async windowSeconds(): Promise<number> {
    return Number(await this.read("windowSeconds", []));
  }

  usdcAllowance(owner: Address, spender: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  }

  approveUsdc(spender: Address, amount: bigint): Promise<Hex> {
    return this.write(USDC_EVM_ADDRESS, erc20Abi, "approve", [spender, amount], GAS_FALLBACK.approve);
  }

  transferUsdc(to: Address, amount: bigint): Promise<Hex> {
    return this.write(USDC_EVM_ADDRESS, TRANSFER_ABI, "transfer", [to, amount], GAS_FALLBACK.transfer);
  }

  depositFee(contestId: number, breaker: Address, amount: bigint, paymentRef: Hex): Promise<Hex> {
    return this.write(this.arena, defectArenaAbi, "depositFee", [BigInt(contestId), breaker, amount, paymentRef], GAS_FALLBACK.depositFee);
  }

  refund(contestId: number, breakers: Address[], amounts: bigint[]): Promise<Hex> {
    return this.write(this.arena, defectArenaAbi, "refund", [BigInt(contestId), breakers, amounts], GAS_FALLBACK.refund);
  }

  voidContest(contestId: number, breakers: Address[], amounts: bigint[]): Promise<Hex> {
    return this.write(this.arena, defectArenaAbi, "voidContest", [BigInt(contestId), breakers, amounts], GAS_FALLBACK.voidContest);
  }

  cancel(contestId: number): Promise<Hex> {
    return this.write(this.arena, defectArenaAbi, "cancel", [BigInt(contestId)], GAS_FALLBACK.cancel);
  }

  closeHeld(contestId: number): Promise<Hex> {
    return this.write(this.arena, defectArenaAbi, "closeHeld", [BigInt(contestId)], GAS_FALLBACK.closeHeld);
  }

  postLogHash(contestId: number, logHash: Hex): Promise<Hex> {
    return this.write(this.arena, defectArenaAbi, "postLogHash", [BigInt(contestId), logHash], GAS_FALLBACK.postLogHash);
  }

  async certificateState(contestId: number): Promise<CertificateState | null> {
    if (!this.certificate) return null;
    const c = (await this.publicClient.readContract({
      address: this.certificate,
      abi: certificateAbi,
      functionName: "getCertificate",
      args: [BigInt(contestId)],
    })) as { mintedAt: bigint; reported: boolean; messageCount: number };
    return { minted: c.mintedAt !== 0n, reported: c.reported, messageCount: Number(c.messageCount) };
  }

  mintCertificate(contestId: number): Promise<Hex> {
    if (!this.certificate) throw new Error("No DefectCertificate configured");
    return this.write(this.certificate, certificateAbi, "mint", [BigInt(contestId)], GAS_FALLBACK.mintCertificate);
  }

  reportCertificate(contestId: number, uniqueBreakers: number, agentName: string): Promise<Hex> {
    if (!this.certificate) throw new Error("No DefectCertificate configured");
    return this.write(
      this.certificate,
      certificateAbi,
      "setReport",
      [BigInt(contestId), uniqueBreakers, agentName],
      GAS_FALLBACK.reportCertificate,
    );
  }

  async attestation(contestId: number): Promise<AttestationResult | null> {
    if (!this.attestations || !this.sepoliaClient) return null;
    const [status, , logHashMatches, canaryHashMatches, secretsMatch, messageCount, attemptsInLog, , attestedAt] =
      await this.sepoliaClient.readContract({ address: this.attestations, abi: attestationsAbi, functionName: "attestations", args: [BigInt(contestId)] });
    if (attestedAt === 0n) return null;
    return { status, logHashMatches, canaryHashMatches, secretsMatch, messageCount, attemptsInLog };
  }

  async agentOwner(agentId: number): Promise<Address | null> {
    if (!this.erc8004) return null;
    try {
      const owner = await this.publicClient.readContract({
        address: this.erc8004.identity,
        abi: IDENTITY_READ_ABI,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
      });
      return owner as Address;
    } catch (err) {
      // Only a nonexistent token means "no such agent"; network errors and other reverts propagate.
      if (isNonexistentToken(err)) return null;
      throw err;
    }
  }

  async agentWallet(agentId: number): Promise<Address | null> {
    if (!this.erc8004) return null;
    const wallet = (await this.publicClient.readContract({
      address: this.erc8004.identity,
      abi: identityRegistryAbi,
      functionName: "getAgentWallet",
      args: [BigInt(agentId)],
    })) as Address;
    return wallet.toLowerCase() === ZERO_ADDRESS ? null : wallet;
  }

  async isAgentOperator(spender: Address, agentId: number): Promise<boolean> {
    if (!this.erc8004) return false;
    return (await this.publicClient.readContract({
      address: this.erc8004.identity,
      abi: identityRegistryAbi,
      functionName: "isAuthorizedOrOwner",
      args: [spender, BigInt(agentId)],
    })) as boolean;
  }

  async agentURI(agentId: number): Promise<string> {
    if (!this.erc8004) throw new Error("No ERC-8004 registries configured");
    return (await this.publicClient.readContract({
      address: this.erc8004.identity,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [BigInt(agentId)],
    })) as string;
  }

  async readDefectFeedback(agentId: number): Promise<DefectFeedback[]> {
    if (!this.erc8004) return [];
    const r = (await this.publicClient.readContract({
      address: this.erc8004.reputation,
      abi: reputationRegistryAbi,
      functionName: "readAllFeedback",
      args: [BigInt(agentId), [this.operatorAddress], "", "", true],
    })) as readonly [readonly Address[], readonly bigint[], readonly bigint[], readonly number[], readonly string[], readonly string[], readonly boolean[]];
    const [, indexes, , , tag1s, tag2s, revoked] = r;
    return indexes.map((index, i) => ({ index: Number(index), tag1: tag1s[i]!, tag2: tag2s[i]!, revoked: revoked[i]! }));
  }

  giveFeedback(f: GiveFeedbackInput): Promise<Hex> {
    if (!this.erc8004) throw new Error("No ERC-8004 registries configured");
    return this.write(
      this.erc8004.reputation,
      reputationRegistryAbi,
      "giveFeedback",
      [BigInt(f.agentId), f.value, f.valueDecimals, f.tag1, f.tag2, f.endpoint, f.feedbackURI, f.feedbackHash],
      GAS_FALLBACK.giveFeedback,
    );
  }

  /**
   * The operator's NewFeedback events for an agent, from an in-process cache of every operator NewFeedback on the
   * reputation registry. The Hedera mirror node rejects topic filters without a timestamp range of at most 7 days,
   * so the cache scans the (low-volume, ours) registry's logs unfiltered once, then refreshes incrementally with a
   * timestamp-only `gt:<last seen>` range (no topics, which the mirror node accepts) at most every 30 s. Concurrent
   * callers share one refresh; a failed refresh throws and leaves the cache as it was.
   */
  async feedbackEvents(agentId: number): Promise<FeedbackEvent[]> {
    if (!this.erc8004) return [];
    await this.refreshFeedbackLog();
    return this.feedbackLog.events.filter((e) => e.agentId === agentId).map(({ agentId: _a, ...e }) => e);
  }

  private refreshFeedbackLog(): Promise<void> {
    const log = this.feedbackLog;
    if (log.fetchedAt !== null && this.nowMs() - log.fetchedAt < FEEDBACK_CACHE_TTL_MS) return Promise.resolve();
    if (!this.feedbackRefresh) {
      this.feedbackRefresh = this.scanFeedbackLogs().finally(() => {
        this.feedbackRefresh = null;
      });
    }
    return this.feedbackRefresh;
  }

  private async scanFeedbackLogs(): Promise<void> {
    const registry = this.erc8004!.reputation;
    const operator = this.operatorAddress.toLowerCase();
    const since = this.feedbackLog.lastTimestamp;
    let url: string | null =
      `${this.mirrorNodeUrl}/api/v1/contracts/${registry}/results/logs?` + (since ? `timestamp=gt:${since}&` : "") + "order=asc&limit=100";
    const found: CachedFeedbackEvent[] = [];
    let last = since;
    while (url) {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Mirror node logs returned ${res.status}`);
      const body = (await res.json()) as {
        logs: { data: Hex; topics: Hex[]; transaction_hash: Hex; timestamp: string }[];
        links?: { next: string | null };
      };
      for (const l of body.logs) {
        last = l.timestamp;
        // Other registry events are not ours to decode; a NewFeedback that fails to decode must throw, never vanish.
        if (l.topics[0]?.toLowerCase() !== NEW_FEEDBACK_TOPIC) continue;
        const ev = decodeEventLog({ abi: reputationRegistryAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (ev.eventName !== "NewFeedback") continue;
        const a = ev.args as {
          agentId: bigint;
          clientAddress: Address;
          feedbackIndex: bigint;
          value: bigint;
          valueDecimals: number;
          tag1: string;
          tag2: string;
          feedbackURI: string;
        };
        if (a.clientAddress.toLowerCase() !== operator) continue;
        found.push({
          agentId: Number(a.agentId),
          index: Number(a.feedbackIndex),
          tag1: a.tag1,
          tag2: a.tag2,
          value: a.value,
          valueDecimals: Number(a.valueDecimals),
          feedbackURI: a.feedbackURI,
          txHash: l.transaction_hash,
          timestamp: Number(l.timestamp.split(".")[0]),
        });
      }
      url = body.links?.next ? `${this.mirrorNodeUrl}${body.links.next}` : null;
    }
    // Committed only after the whole scan succeeded, so a failed page never leaves a gap behind `lastTimestamp`.
    this.feedbackLog = { events: [...this.feedbackLog.events, ...found], lastTimestamp: last, fetchedAt: this.nowMs() };
  }

  /**
   * Every DefectArena event has the contest id as its first indexed topic, so one mirror-node query
   * filtered on topic1 returns them all (Hashio limits eth_getLogs block ranges; the mirror node does not).
   */
  async contestEvents(contestId: number, sinceUnix: number): Promise<ArenaEvent[]> {
    const topic1 = pad(toHex(BigInt(contestId)), { size: 32 });
    const now = Math.floor(Date.now() / 1000) + 60;
    let url: string | null =
      `${this.mirrorNodeUrl}/api/v1/contracts/${this.arena}/results/logs` +
      `?topic1=${topic1}&timestamp=gte:${Math.max(0, sinceUnix - 60)}&timestamp=lte:${now}&order=asc&limit=100`;
    const out: ArenaEvent[] = [];
    while (url) {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Mirror node logs returned ${res.status}`);
      const body = (await res.json()) as {
        logs: { data: Hex; topics: Hex[]; transaction_hash: Hex; timestamp: string }[];
        links?: { next: string | null };
      };
      for (const l of body.logs) {
        try {
          const ev = decodeEventLog({ abi: defectArenaAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          out.push({ name: ev.eventName, args: ev.args as Record<string, unknown>, txHash: l.transaction_hash, timestamp: Number(l.timestamp.split(".")[0]) });
        } catch {
          // Not a DefectArena event shape (e.g. a token Transfer); ignore.
        }
      }
      url = body.links?.next ? `${this.mirrorNodeUrl}${body.links.next}` : null;
    }
    return out;
  }

  private read(functionName: string, args: readonly unknown[]): Promise<unknown> {
    return this.publicClient.readContract({ address: this.arena, abi: defectArenaAbi, functionName: functionName as never, args: args as never });
  }

  /** Simulate (to surface the custom error), estimate × 1.5 capped at 15M, send through the queue, wait for success. */
  private write(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[], fallbackGas: bigint): Promise<Hex> {
    return this.writes.run(async () => {
      let gas = fallbackGas;
      try {
        const sim = await this.publicClient.simulateContract({
          address,
          abi: abi as never,
          functionName: functionName as never,
          args: args as never,
          account: this.account,
        });
        try {
          const est = await this.publicClient.estimateContractGas(sim.request as never);
          gas = (est * 3n) / 2n;
          if (gas > HEDERA_TX_GAS_CAP) gas = HEDERA_TX_GAS_CAP;
        } catch {
          // keep the fallback limit
        }
      } catch (err) {
        const name = revertName(err);
        if (name) throw new ChainRevertError(name);
        throw err;
      }
      const txHash = await this.walletClient.writeContract({
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
        account: this.account,
        chain: this.walletClient.chain,
        gas,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new ChainRevertError(`TX_REVERTED ${txHash}`);
      return txHash;
    });
  }
}

/** OpenZeppelin v5 ERC-721 error; the generated registry ABI is interface-only so lacks it. */
const NONEXISTENT_TOKEN_ERROR = {
  type: "error",
  name: "ERC721NonexistentToken",
  inputs: [{ name: "tokenId", type: "uint256" }],
} as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NEW_FEEDBACK_TOPIC = toEventSelector(getAbiItem({ abi: reputationRegistryAbi, name: "NewFeedback" })).toLowerCase();
const NONEXISTENT_TOKEN_SELECTOR = "0x7e273289";
const IDENTITY_READ_ABI = [...identityRegistryAbi, NONEXISTENT_TOKEN_ERROR] as const;

/** True only for an `ERC721NonexistentToken` revert (decoded by name, or matched by selector if the node returned raw data). */
export function isNonexistentToken(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return false;
  if (revert.data?.errorName === "ERC721NonexistentToken") return true;
  const raw = (revert as { raw?: Hex }).raw;
  return !revert.data && typeof raw === "string" && raw.toLowerCase().startsWith(NONEXISTENT_TOKEN_SELECTOR);
}

const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
