import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
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
import { HEDERA_TESTNET_CHAIN_ID, USDC_EVM_ADDRESS, certificateAbi, defectArenaAbi, erc20Abi } from "@defect/shared";
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

export interface GatewayChain {
  readonly operatorAddress: Address;
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
} as const;
const HEDERA_TX_GAS_CAP = 15_000_000n;

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
  privateKey: Hex;
  rpcUrl: string;
  mirrorNodeUrl: string;
  chain?: Chain;
  pollingInterval?: number;
  fetchFn?: typeof fetch;
}

export class ViemGatewayChain implements GatewayChain {
  readonly operatorAddress: Address;
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly arena: Address;
  private readonly certificate: Address | null;
  private readonly mirrorNodeUrl: string;
  private readonly fetchFn: typeof fetch;
  /** One operator nonce: every write goes through this queue (§10.1). */
  private readonly writes = new SerialQueue();

  constructor(opts: ViemGatewayChainOptions) {
    const chain = opts.chain ?? hederaTestnet(opts.rpcUrl);
    this.account = privateKeyToAccount(opts.privateKey);
    this.operatorAddress = this.account.address;
    this.arena = opts.arena;
    this.certificate = opts.certificate ?? null;
    this.mirrorNodeUrl = opts.mirrorNodeUrl;
    this.fetchFn = opts.fetchFn ?? fetch;
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
      const res = await this.fetchFn(url);
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
