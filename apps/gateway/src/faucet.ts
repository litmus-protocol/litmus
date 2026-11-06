import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { USDC_EVM_ADDRESS, USDC_TOKEN_ID, erc20Abi } from "@defect/shared";
import { ChainRevertError, hederaTestnet, revertName } from "./chain";
import type { PrivyVerifier } from "./privy-auth";
import { SerialQueue } from "./queue";

// Test-funds faucet (POST /faucet): small HBAR and USDC grants so a brand-new wallet (Privy
// email/Google login) can activate its Hedera account and pay for messages.

/** What the faucet needs to know about a recipient, from the mirror node. */
export interface FaucetAccountInfo {
  accountId: string;
  /** False for a hollow account (created by a transfer to its EVM alias, no key until it signs a transaction). */
  hasKey: boolean;
  usdcAssociated: boolean;
}

export interface FaucetChain {
  readonly address: Address;
  /** null: no Hedera account uses this EVM address yet. */
  account(address: Address): Promise<FaucetAccountInfo | null>;
  hbarBalance(): Promise<bigint>; // tinybars
  usdcBalance(): Promise<bigint>; // base units
  /** Native HBAR to an EVM address; creates a (hollow) account if none exists. */
  sendHbar(to: Address, tinybars: bigint): Promise<Hex>;
  sendUsdc(to: Address, units: bigint): Promise<Hex>;
}

export interface Faucet {
  chain: FaucetChain;
  hbarTinybars: bigint;
  usdcUnits: bigint;
  /** Grants (HBAR and USDC each count) per rolling 24 h, across all addresses. */
  dailyCap: number;
  /** Addresses one client IP may fund per rolling 24 h; 0 = no per-IP limit. */
  perIpDailyCap: number;
  /** Reverse proxies in front of the gateway: the client IP is this many entries from the right of X-Forwarded-For; 0 = the socket address. */
  proxyHops: number;
  /** When set, POST /faucet needs a Privy access token, and each Privy user funds one address. */
  privy: PrivyVerifier | null;
}

const WEIBARS_PER_TINYBAR = 10n ** 10n;
/** A value transfer to a new alias creates the account (lazy create): far above 21k on Hedera. */
const HBAR_SEND_GAS_FALLBACK = 1_000_000n;
const USDC_SEND_GAS_FALLBACK = 1_000_000n;

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

export interface ViemFaucetChainOptions {
  privateKey: Hex;
  rpcUrl: string;
  mirrorNodeUrl: string;
  /** Share the operator's queue when the faucet key is the operator key (one nonce). */
  writes?: SerialQueue;
  chain?: Chain;
  fetchFn?: typeof fetch;
}

export class ViemFaucetChain implements FaucetChain {
  readonly address: Address;
  private readonly signer: PrivateKeyAccount;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly writes: SerialQueue;
  private readonly mirrorNodeUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: ViemFaucetChainOptions) {
    const chain = opts.chain ?? hederaTestnet(opts.rpcUrl);
    this.signer = privateKeyToAccount(opts.privateKey);
    this.address = this.signer.address;
    const transport = http(opts.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.walletClient = createWalletClient({ chain, transport, account: this.signer });
    this.writes = opts.writes ?? new SerialQueue();
    this.mirrorNodeUrl = opts.mirrorNodeUrl;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async account(address: Address): Promise<FaucetAccountInfo | null> {
    const res = await this.fetchFn(`${this.mirrorNodeUrl}/api/v1/accounts/${address.toLowerCase()}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Mirror node returned ${res.status} for ${address}`);
    const body = (await res.json()) as { account: string; key?: { key?: string } | null };
    const tokens = await this.fetchFn(`${this.mirrorNodeUrl}/api/v1/accounts/${body.account}/tokens?token.id=${USDC_TOKEN_ID}`);
    if (!tokens.ok) throw new Error(`Mirror node returned ${tokens.status} for ${body.account} tokens`);
    const t = (await tokens.json()) as { tokens: unknown[] };
    return { accountId: body.account, hasKey: !!body.key?.key, usdcAssociated: t.tokens.length > 0 };
  }

  async hbarBalance(): Promise<bigint> {
    return (await this.publicClient.getBalance({ address: this.address })) / WEIBARS_PER_TINYBAR;
  }

  usdcBalance(): Promise<bigint> {
    return this.publicClient.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [this.address] });
  }

  sendHbar(to: Address, tinybars: bigint): Promise<Hex> {
    return this.writes.run(async () => {
      const value = tinybars * WEIBARS_PER_TINYBAR;
      let gas = HBAR_SEND_GAS_FALLBACK;
      try {
        gas = ((await this.publicClient.estimateGas({ account: this.signer, to, value })) * 3n) / 2n;
      } catch {
        // keep the fallback
      }
      const hash = await this.walletClient.sendTransaction({ account: this.signer, chain: this.walletClient.chain, to, value, gas });
      return this.wait(hash);
    });
  }

  sendUsdc(to: Address, units: bigint): Promise<Hex> {
    return this.writes.run(async () => {
      let gas = USDC_SEND_GAS_FALLBACK;
      try {
        const sim = await this.publicClient.simulateContract({ address: USDC_EVM_ADDRESS, abi: TRANSFER_ABI, functionName: "transfer", args: [to, units], account: this.signer });
        try {
          gas = ((await this.publicClient.estimateContractGas(sim.request as never)) * 3n) / 2n;
        } catch {
          // keep the fallback
        }
      } catch (err) {
        const name = revertName(err);
        if (name) throw new ChainRevertError(name);
        throw err;
      }
      const hash = await this.walletClient.writeContract({
        address: USDC_EVM_ADDRESS,
        abi: TRANSFER_ABI,
        functionName: "transfer",
        args: [to, units],
        account: this.signer,
        chain: this.walletClient.chain,
        gas,
      });
      return this.wait(hash);
    });
  }

  private async wait(hash: Hex): Promise<Hex> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new ChainRevertError(`TX_REVERTED ${hash}`);
    return hash;
  }
}
