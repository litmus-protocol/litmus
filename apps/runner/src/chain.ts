import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { HEDERA_TESTNET_CHAIN_ID, defectArenaAbi } from "@defect/shared";
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

export interface OnchainContest {
  status: number;
  startTime: bigint;
  endTime: bigint;
  vault: bigint;
  packageHash: Hex;
  canaryHash: Hex;
}

export interface OnchainInvariant {
  kind: number;
  secretHash: Hex;
  maxAmount: bigint;
}

/** Outcome of one vault write after the send procedure in build plan §9.5. */
export type VaultWriteResult =
  | { kind: "simulation_reverted"; error: string }
  | { kind: "mined"; txHash: Hex; transferred: boolean; amount: bigint; broke: boolean }
  | { kind: "mined_reverted"; txHash: Hex };

export interface ArenaChain {
  readonly runnerAddress: Address;
  phase(contestId: number): Promise<number>;
  getContest(contestId: number): Promise<OnchainContest>;
  getInvariants(contestId: number): Promise<OnchainInvariant[]>;
  vaultSend(args: { contestId: number; to: Address; amount: bigint; breaker: Address; attemptId: Hex }): Promise<VaultWriteResult>;
  vaultEmergencyWithdraw(args: { contestId: number; to: Address; breaker: Address; attemptId: Hex }): Promise<VaultWriteResult>;
}

/** Fallback gas when estimation fails (build plan §8.7). */
const VAULT_GAS_FALLBACK = 3_000_000n;
const HEDERA_TX_GAS_CAP = 15_000_000n;

export function hederaTestnet(rpcUrl: string): Chain {
  return defineChain({
    id: HEDERA_TESTNET_CHAIN_ID,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface ViemArenaChainOptions {
  arena: Address;
  privateKey: Hex;
  rpcUrl: string;
  chain?: Chain;
  /** Receipt polling interval; Hedera blocks are ~2 s. */
  pollingInterval?: number;
}

export class ViemArenaChain implements ArenaChain {
  readonly runnerAddress: Address;
  private readonly account: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly arena: Address;
  private readonly writes = new SerialQueue();

  constructor(opts: ViemArenaChainOptions) {
    const chain = opts.chain ?? hederaTestnet(opts.rpcUrl);
    this.account = privateKeyToAccount(opts.privateKey);
    this.runnerAddress = this.account.address;
    this.arena = opts.arena;
    const transport = http(opts.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: opts.pollingInterval ?? 1_000 });
    this.walletClient = createWalletClient({ chain, transport, account: this.account });
  }

  async phase(contestId: number): Promise<number> {
    return Number(
      await this.publicClient.readContract({ address: this.arena, abi: defectArenaAbi, functionName: "phase", args: [BigInt(contestId)] }),
    );
  }

  async getContest(contestId: number): Promise<OnchainContest> {
    const c = await this.publicClient.readContract({
      address: this.arena,
      abi: defectArenaAbi,
      functionName: "getContest",
      args: [BigInt(contestId)],
    });
    return {
      status: Number(c.status),
      startTime: BigInt(c.startTime),
      endTime: BigInt(c.endTime),
      vault: c.vault,
      packageHash: c.packageHash,
      canaryHash: c.canaryHash,
    };
  }

  async getInvariants(contestId: number): Promise<OnchainInvariant[]> {
    const invs = await this.publicClient.readContract({
      address: this.arena,
      abi: defectArenaAbi,
      functionName: "getInvariants",
      args: [BigInt(contestId)],
    });
    return invs.map((i) => ({ kind: Number(i.kind), secretHash: i.secretHash, maxAmount: i.maxAmount }));
  }

  vaultSend(a: { contestId: number; to: Address; amount: bigint; breaker: Address; attemptId: Hex }): Promise<VaultWriteResult> {
    return this.write("vaultSend", [BigInt(a.contestId), a.to, a.amount, a.breaker, a.attemptId], a.contestId);
  }

  vaultEmergencyWithdraw(a: { contestId: number; to: Address; breaker: Address; attemptId: Hex }): Promise<VaultWriteResult> {
    return this.write("vaultEmergencyWithdraw", [BigInt(a.contestId), a.to, a.breaker, a.attemptId], a.contestId);
  }

  /**
   * Send procedure (build plan §9.5): simulate first and send nothing on a revert; otherwise send through the
   * single write queue (nonce safety), wait for the receipt and decode the vault and Broken events.
   */
  private write(
    functionName: "vaultSend" | "vaultEmergencyWithdraw",
    args: readonly unknown[],
    contestId: number,
  ): Promise<VaultWriteResult> {
    return this.writes.run(async () => {
      let gas: bigint;
      try {
        const sim = await this.publicClient.simulateContract({
          address: this.arena,
          abi: defectArenaAbi,
          functionName,
          // viem's generic args typing cannot follow the union of the two functions.
          args: args as never,
          account: this.account,
        });
        gas = await this.estimateGas(sim.request);
      } catch (err) {
        const name = revertName(err);
        if (name) return { kind: "simulation_reverted", error: name };
        throw err;
      }

      const txHash = await this.walletClient.writeContract({
        address: this.arena,
        abi: defectArenaAbi,
        functionName,
        args: args as never,
        account: this.account,
        chain: this.walletClient.chain,
        gas,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") return { kind: "mined_reverted", txHash };

      let transferred = false;
      let amount = 0n;
      let broke = false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== this.arena.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: defectArenaAbi, data: log.data, topics: log.topics });
          if ((ev.eventName === "VaultSend" || ev.eventName === "VaultEmergencyWithdraw") && ev.args.id === BigInt(contestId)) {
            transferred = ev.args.transferred;
            amount = ev.args.amount;
          } else if (ev.eventName === "Broken" && ev.args.id === BigInt(contestId)) {
            broke = true;
          }
        } catch {
          // Not one of ours (e.g. a token Transfer emitted at the arena address); ignore.
        }
      }
      return { kind: "mined", txHash, transferred, amount, broke };
    });
  }

  private async estimateGas(request: { to?: Address | null; data?: Hex } & Record<string, unknown>): Promise<bigint> {
    try {
      const est = await this.publicClient.estimateContractGas(request as never);
      const padded = (est * 3n) / 2n;
      return padded > HEDERA_TX_GAS_CAP ? HEDERA_TX_GAS_CAP : padded;
    } catch {
      return VAULT_GAS_FALLBACK;
    }
  }
}

/** Custom-error name from a viem contract error, or null if it isn't a contract revert. */
export function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? "Reverted";
    }
  }
  return null;
}
