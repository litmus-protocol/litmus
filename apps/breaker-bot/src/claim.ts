import { createPublicClient, createWalletClient, defineChain, http, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HEDERA_TESTNET_CHAIN_ID, commitment, defectArenaAbi } from "@defect/shared";
import type { BotConfig } from "./config";

// Commit then reveal a found secret (build plan §8.5, D17). The reveal must land in a later block than
// the commit, so nobody can copy the secret out of a pending reveal.

export interface ClaimResult {
  commitTx: Hex;
  revealTx: Hex;
}

export interface Claimer {
  claim(contestId: number, invariantIndex: number, secret: string, log: (line: string) => void): Promise<ClaimResult>;
}

// Gas fallbacks from build plan §8.7, used when estimation fails.
const COMMIT_GAS = 300_000n;
const REVEAL_GAS = 2_500_000n;

export class ChainClaimer implements Claimer {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;

  /** `arena` comes from the gateway's GET /config, so the bot always claims on the contract the gateway uses. */
  constructor(
    config: BotConfig,
    private readonly arena: `0x${string}`,
  ) {
    const chain = defineChain({
      id: HEDERA_TESTNET_CHAIN_ID,
      name: "Hedera Testnet",
      nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.account = privateKeyToAccount(config.wallet.privateKey);
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.walletClient = createWalletClient({ chain, account: this.account, transport: http(config.rpcUrl) });
  }

  private async gas(functionName: "commitBreak" | "revealBreak", args: readonly unknown[], fallback: bigint): Promise<bigint> {
    try {
      const est = await this.publicClient.estimateContractGas({
        address: this.arena,
        abi: defectArenaAbi,
        functionName,
        args: args as never,
        account: this.account,
      });
      return (est * 3n) / 2n;
    } catch {
      return fallback;
    }
  }

  async claim(contestId: number, invariantIndex: number, secret: string, log: (line: string) => void): Promise<ClaimResult> {
    const id = BigInt(contestId);
    const salt = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const sealed = commitment(secret, this.account.address, salt);

    const commitArgs = [id, sealed] as const;
    // Simulate first: a revert here (contest not open, …) costs nothing.
    await this.publicClient.simulateContract({
      address: this.arena,
      abi: defectArenaAbi,
      functionName: "commitBreak",
      args: commitArgs,
      account: this.account,
    });
    const commitTx = await this.walletClient.writeContract({
      address: this.arena,
      abi: defectArenaAbi,
      functionName: "commitBreak",
      args: commitArgs,
      gas: await this.gas("commitBreak", commitArgs, COMMIT_GAS),
    });
    const commitReceipt = await this.publicClient.waitForTransactionReceipt({ hash: commitTx });
    if (commitReceipt.status !== "success") throw new Error(`commitBreak reverted (${commitTx})`);
    log(`  locked in (commit) · ${commitTx}`);

    // Wait for a later block (~2 s each on Hedera).
    for (let i = 0; i < 30; i++) {
      if ((await this.publicClient.getBlockNumber()) > commitReceipt.blockNumber) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const revealArgs = [id, invariantIndex, secret, salt] as const;
    await this.publicClient.simulateContract({
      address: this.arena,
      abi: defectArenaAbi,
      functionName: "revealBreak",
      args: revealArgs,
      account: this.account,
    });
    const revealTx = await this.walletClient.writeContract({
      address: this.arena,
      abi: defectArenaAbi,
      functionName: "revealBreak",
      args: revealArgs,
      gas: await this.gas("revealBreak", revealArgs, REVEAL_GAS),
    });
    const revealReceipt = await this.publicClient.waitForTransactionReceipt({ hash: revealTx });
    if (revealReceipt.status !== "success") throw new Error(`revealBreak reverted (${revealTx})`);
    log(`  revealed · ${revealTx}`);
    return { commitTx, revealTx };
  }
}
