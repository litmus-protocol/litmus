import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  http,
  encodeFunctionData,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  CHARGE_LATENCY_LIMIT_MS,
  HEDERA_TESTNET_CHAIN_ID,
  USDC_EVM_ADDRESS,
  USDC_TOKEN_ID,
  X402_NETWORK,
  attestationsAbi,
  buildAgentCard,
  certificateAbi,
  defectArenaAbi,
  erc20Abi,
  fromBaseUnits,
  hashscanTx,
  identityRegistryAbi,
  sessionMessage,
  type Address,
  toJsonDataUri,
  type ApiErrorBody,
  type Attestation,
  type FaucetResponse,
  type GatewayConfig,
  type MessageResult,
} from "@defect/shared";
import { config } from "../../config";
import { resolveHederaAccount } from "../../hedera-account";
import { privySigner } from "../../privy-bridge";
import { ApiError } from "../errors";
import type { CertificateMetadata, DefectClient, KeyWallet, PrivyWallet, TxResult, Wallet } from "../types";

// Real implementation: gateway HTTP API (build plan §10.3), DefectArena on
// Hedera testnet (§8) and x402 payments (§10.5, §11.1).

const hedera = defineChain({
  id: HEDERA_TESTNET_CHAIN_ID,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [config.hederaRpcUrl] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
});

const publicClient = createPublicClient({ chain: hedera, transport: http(config.hederaRpcUrl) });

// Fallback gas limits from build plan §8.7 (HTS calls are expensive on Hedera).
const GAS = {
  createContest: 3_000_000n,
  commitBreak: 300_000n,
  revealBreak: 2_500_000n,
  closeHeld: 2_500_000n,
  withdraw: 1_000_000n,
  approve: 1_000_000n,
  associate: 1_000_000n,
  registerAgent: 1_500_000n,
};

// ---------------------------------------------------------------- gateway

async function gw<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.gatewayUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("GATEWAY_UNREACHABLE", "Can't reach the Defect gateway. Check NEXT_PUBLIC_GATEWAY_URL.");
  }
  return parse<T>(res);
}

async function parse<T>(res: Response): Promise<T> {
  if (res.ok) {
    const type = res.headers.get("content-type") ?? "";
    return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
  }
  let body: ApiErrorBody | null = null;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // non-JSON error body
  }
  throw new ApiError(body?.error.code ?? `HTTP_${res.status}`, body?.error.message ?? res.statusText, res.status);
}

let configCache: Promise<GatewayConfig> | null = null;
function gatewayConfig(): Promise<GatewayConfig> {
  configCache ??= gw<GatewayConfig>("/config").catch((e) => {
    configCache = null;
    throw e;
  });
  return configCache;
}

// ---------------------------------------------------------------- chain

/** Hedera-wallet (WalletConnect) chain actions; loaded only when such a wallet is used. */
const hederaWallet = () => import("./hedera-wallet");
/** Raw-hash signing (Privy embedded wallets); loaded only when such a wallet is used. */
const rawSigner = () => import("./raw-signer");

/** The viem account that signs for a dev key or a Privy wallet (both send EVM transactions through the relay). */
async function evmAccount(w: KeyWallet | PrivyWallet) {
  if (w.kind === "key") return privateKeyToAccount(w.privateKey);
  return (await rawSigner()).rawViemAccount(w.address, privySigner(w.address));
}

async function walletClient(w: KeyWallet | PrivyWallet) {
  return createWalletClient({ account: await evmAccount(w), chain: hedera, transport: http(config.hederaRpcUrl) });
}

function requireActivated(w: PrivyWallet): void {
  if (!w.accountId || !w.activated) {
    throw new ApiError("ACCOUNT_NOT_ACTIVATED", "Activate your Hedera account first: open the wallet menu and choose Get test funds.");
  }
}

function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? null;
  }
  return null;
}

interface WriteResult extends TxResult {
  blockNumber: bigint | null;
  logs: readonly { address: Hex; data: Hex; topics: readonly Hex[] }[];
}

/**
 * Simulate first (to surface custom errors before anything is signed), then send with
 * estimate × 1.5. Dev keys and Privy wallets send an EVM transaction through the JSON-RPC relay
 * (a Privy wallet's first one also completes its hollow account); WalletConnect
 * wallets get a native ContractCall to sign and execute (same calldata, same gas).
 */
async function write(
  w: Wallet,
  address: `0x${string}`,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
  fallbackGas: bigint,
): Promise<WriteResult> {
  // Dev keys and Privy wallets must simulate with their local account: simulateContract copies
  // `account` into `request`, and a bare address there would make writeContract fall back to
  // eth_sendTransaction, which the Hashio relay does not support.
  const account = w.kind === "walletconnect" ? w.address : await evmAccount(w);
  try {
    const { request } = await publicClient.simulateContract({ account, address, abi: abi as never, functionName: functionName as never, args: args as never });
    let gas = fallbackGas;
    try {
      gas = ((await publicClient.estimateContractGas({ account, address, abi: abi as never, functionName: functionName as never, args: args as never })) * 3n) / 2n;
    } catch {
      // keep the fallback limit
    }
    if (w.kind === "walletconnect") {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
      const r = await (await hederaWallet()).executeContract(w, address, abi as Abi, data, gas);
      return { txHash: r.txHash, hashscan: r.hashscan, blockNumber: r.blockNumber, logs: r.logs };
    }
    const txHash = await (await walletClient(w)).writeContract({ ...(request as object), gas } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new ApiError("TX_REVERTED", "The transaction failed on chain.");
    return { ...tx(txHash), blockNumber: receipt.blockNumber, logs: receipt.logs };
  } catch (err) {
    const name = revertName(err);
    if (name) throw new ApiError(name, name);
    throw err;
  }
}

const tx = (txHash: Hex): TxResult => ({ txHash, hashscan: hashscanTx(txHash) });
const txOf = (r: TxResult): TxResult => ({ txHash: r.txHash, hashscan: r.hashscan });

// ---------------------------------------------------------------- x402

async function paidFetch(w: Wallet) {
  // Loaded lazily so mock mode never bundles the Hedera SDK on first paint.
  const [{ x402Client, wrapFetchWithPayment }, { createClientHederaSigner, PrivateKey }, { ExactHederaScheme }] = await Promise.all([
    import("@x402/fetch"),
    import("@x402/hedera"),
    import("@x402/hedera/exact/client"),
  ]);
  let signer;
  if (w.kind === "key") signer = createClientHederaSigner(w.accountId, PrivateKey.fromStringECDSA(w.privateKey), { network: X402_NETWORK });
  else if (w.kind === "privy") {
    requireActivated(w);
    signer = (await rawSigner()).rawX402Signer(w.accountId, w.address, privySigner(w.address));
  } else signer = (await hederaWallet()).x402Signer(w);
  const client = new x402Client().register(X402_NETWORK, new ExactHederaScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}

async function sessionHeaders(w: Wallet, contestId: number): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const message = sessionMessage(contestId, w.address, ts);
  const base = { "X-Defect-Address": w.address, "X-Defect-Timestamp": String(ts) };
  if (w.kind === "walletconnect") {
    // hedera_signMessage; the gateway checks it against the account's key on the mirror node.
    const signature = await (await hederaWallet()).signSessionMessage(w, message);
    return { ...base, "X-Defect-Signature": signature, "X-Defect-Account": w.accountId };
  }
  // EIP-191 from the dev key or the Privy wallet; the gateway recovers the address.
  const signature = await (await evmAccount(w)).signMessage({ message });
  return { ...base, "X-Defect-Signature": signature };
}

// ---------------------------------------------------------------- client

export const liveClient: DefectClient = {
  mode: "live",

  getConfig: gatewayConfig,
  getStats: () => gw("/stats"),
  listContests: (filter = "all") => gw(`/contests?status=${filter}`),
  getContest: (id) => gw(`/contests/${id}`),
  getAttempts: (id) => gw(`/contests/${id}/attempts`),
  getCanaryRounds: (id) => gw(`/contests/${id}/canary-rounds`),

  async getSession(id, w) {
    return gw(`/contests/${id}/sessions/${w.address}`, { headers: await sessionHeaders(w, id) });
  },

  async getLog(id) {
    const res = await fetch(`${config.gatewayUrl}/contests/${id}/log`);
    if (!res.ok) return parse(res);
    const text = await res.text();
    return { text, logHash: (res.headers.get("X-Defect-Log-Hash") ?? "0x") as `0x${string}` };
  },

  async getCertificate(id) {
    const cfg = await gatewayConfig();
    if (!cfg.certificate) return null;
    try {
      const json = await publicClient.readContract({ address: cfg.certificate, abi: certificateAbi, functionName: "tokenJson", args: [BigInt(id)] });
      return JSON.parse(json) as CertificateMetadata;
    } catch (err) {
      // Not minted yet: tokenJson reverts (ERC721NonexistentToken) until the gateway mints it.
      if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError)) return null;
      throw err;
    }
  },

  getAgent: (agentId) => gw(`/agents/${agentId}`),

  async getAttestation(id) {
    const cfg = await gatewayConfig();
    if (!cfg.attestations) return null;
    const client = createPublicClient({ chain: sepolia, transport: http(config.sepoliaRpcUrl) });
    const r = await client.readContract({ address: cfg.attestations, abi: attestationsAbi, functionName: "attestations", args: [BigInt(id)] });
    const [status, , logHashMatches, canaryHashMatches, secretsMatch, messageCount, attemptsInLog, , attestedAt] = r;
    if (attestedAt === 0n) return null;
    const a: Attestation = {
      status,
      logHashMatches,
      canaryHashMatches,
      secretsMatch,
      messageCount,
      attemptsInLog,
      attestedAt: Number(attestedAt),
      txHash: null,
    };
    return a;
  },

  async sendMessage(id, text, w) {
    const pay = await paidFetch(w);
    let res: Response;
    try {
      res = await pay(`${config.gatewayUrl}/contests/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error("[defect] x402 payment failed", err);
      throw new ApiError("PAYMENT_INVALID", err instanceof Error ? err.message : "Payment failed.");
    }
    const result = await parse<MessageResult>(res);
    // The gateway decides charging; this only guards against a missing flag.
    return { ...result, charged: result.charged ?? result.latencyMs <= CHARGE_LATENCY_LIMIT_MS };
  },

  async resolveWallet(privateKey) {
    const account = privateKeyToAccount(privateKey);
    const res = await fetch(`${config.mirrorNodeUrl}/api/v1/accounts/${account.address}`);
    if (res.status === 404) throw new ApiError("ACCOUNT_NOT_FOUND", "No Hedera testnet account uses this key yet. Create one at portal.hedera.com.");
    if (!res.ok) throw new ApiError("MIRROR_NODE_ERROR", "Couldn't look up the account on the Hedera mirror node.");
    const body = (await res.json()) as { account: string; key?: { _type?: string } | null };
    if (body.key && body.key._type && body.key._type !== "ECDSA_SECP256K1") throw new ApiError("ECDSA_ACCOUNT_REQUIRED", "ECDSA key required.");
    return { kind: "key", privateKey, address: account.address, accountId: body.account };
  },

  resolveAccount: (accountId, walletName) => resolveHederaAccount(accountId, walletName),

  async getBalances(w) {
    const cfg = await gatewayConfig();
    const [hbarWei, usdcUnits, withdrawableUnits, tokenRes] = await Promise.all([
      publicClient.getBalance({ address: w.address }),
      publicClient.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [w.address] }),
      publicClient.readContract({ address: cfg.arena, abi: defectArenaAbi, functionName: "withdrawable", args: [w.address] }),
      w.accountId ? fetch(`${config.mirrorNodeUrl}/api/v1/accounts/${w.accountId}/tokens?token.id=${USDC_TOKEN_ID}`) : null,
    ]);
    const tokens = tokenRes?.ok ? ((await tokenRes.json()) as { tokens: unknown[] }).tokens : [];
    return {
      hbar: Number(formatEther(hbarWei)).toFixed(2),
      usdc: fromBaseUnits(usdcUnits),
      usdcAssociated: tokens.length > 0,
      withdrawable: fromBaseUnits(withdrawableUnits),
    };
  },

  async associateUsdc(w) {
    if (w.kind === "walletconnect") return txOf(await (await hederaWallet()).associateToken(w, USDC_TOKEN_ID));
    return txOf(await write(w, USDC_EVM_ADDRESS, erc20Abi, "associate", [], GAS.associate));
  },

  requestTestFunds: (address: Address) => gw<FaucetResponse>("/faucet", { method: "POST", body: JSON.stringify({ address }) }),

  async withdraw(w) {
    const cfg = await gatewayConfig();
    return txOf(await write(w, cfg.arena, defectArenaAbi, "withdraw", [], GAS.withdraw));
  },

  createDraft: (submission) => gw("/drafts", { method: "POST", body: JSON.stringify(submission) }),

  async ensureAllowance(w, amountUnits) {
    const cfg = await gatewayConfig();
    const balance = await publicClient.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [w.address] });
    if (balance < amountUnits) {
      throw new ApiError("INSUFFICIENT_USDC", `You need ${fromBaseUnits(amountUnits)} USDC; you have ${fromBaseUnits(balance)}.`);
    }
    const allowance = await publicClient.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [w.address, cfg.arena] });
    if (allowance >= amountUnits) return null;
    if (w.kind === "walletconnect") return txOf(await (await hederaWallet()).approveToken(w, USDC_TOKEN_ID, cfg.arena, amountUnits));
    return txOf(await write(w, USDC_EVM_ADDRESS, erc20Abi, "approve", [cfg.arena, amountUnits], GAS.approve));
  },

  async createContestOnChain(w, d) {
    const cfg = await gatewayConfig();
    const r = await write(
      w,
      cfg.arena,
      defectArenaAbi,
      "createContest",
      [
        d.packageHash,
        d.canaryHash,
        d.invariantsOnchain.map((i) => ({ kind: i.kind, secretHash: i.secretHash, maxAmount: BigInt(i.maxAmount) })),
        BigInt(d.startTime),
        BigInt(d.messagePriceUnits),
        BigInt(d.poolUnits),
        BigInt(d.vaultUnits),
        BigInt(d.bondUnits),
      ],
      GAS.createContest,
    );
    for (const log of r.logs) {
      try {
        const ev = decodeEventLog({ abi: defectArenaAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (ev.eventName === "ContestCreated") return { ...txOf(r), contestId: Number(ev.args.id) };
      } catch {
        // not our event
      }
    }
    throw new ApiError("CONTEST_ID_MISSING", "Contest created but its id wasn't found in the receipt.");
  },

  async confirmDraft(draftId, contestId) {
    await gw(`/drafts/${draftId}/confirm`, { method: "POST", body: JSON.stringify({ contestId }) });
  },

  async registerAgent(w, card) {
    const cfg = await gatewayConfig();
    if (!cfg.erc8004) throw new ApiError("ERC8004_DISABLED", "ERC-8004 agent identity isn't enabled on this deployment.");
    const { uri } = toJsonDataUri(buildAgentCard({ name: card.name, description: card.purpose, siteUrl: window.location.origin }));
    const identity = cfg.erc8004.identity.toLowerCase();
    const r = await write(w, cfg.erc8004.identity, identityRegistryAbi, "register", [uri], GAS.registerAgent);
    for (const log of r.logs) {
      if (log.address?.toLowerCase() !== identity) continue;
      try {
        const ev = decodeEventLog({ abi: identityRegistryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (ev.eventName === "Registered") return { ...txOf(r), agentId: Number(ev.args.agentId) };
      } catch {
        // not our event
      }
    }
    // Usually mirror-node lag on a WalletConnect transaction. The registration itself went through, so registering
    // again would create a second agent: point at the transaction instead.
    throw new ApiError(
      "AGENT_ID_MISSING",
      `The registration went through, but its agent id isn't visible yet. Your agent may already be registered: find its id on HashScan (${r.hashscan}) and enter it under "Use my agent ID" instead of registering again.`,
    );
  },

  async commitBreak(w, id, commitmentHash) {
    const cfg = await gatewayConfig();
    const r = await write(w, cfg.arena, defectArenaAbi, "commitBreak", [BigInt(id), commitmentHash], GAS.commitBreak);
    if (w.kind === "walletconnect") {
      // The commitment binds msg.sender. Check the contract stored it under the address the UI
      // used, so a sender mismatch shows up now instead of as a failed reveal later.
      const [stored] = await publicClient.readContract({ address: cfg.arena, abi: defectArenaAbi, functionName: "commits", args: [BigInt(id), w.address] });
      if (stored.toLowerCase() !== commitmentHash.toLowerCase()) {
        throw new ApiError("SENDER_MISMATCH", "The contract recorded this claim under a different address than your wallet's. Don't reveal; report this.");
      }
    }
    return { ...txOf(r), blockNumber: r.blockNumber ?? (await publicClient.getBlockNumber()) };
  },

  getBlockNumber: () => publicClient.getBlockNumber(),

  async revealBreak(w, id, invariantIndex, secret, salt) {
    const cfg = await gatewayConfig();
    return txOf(await write(w, cfg.arena, defectArenaAbi, "revealBreak", [BigInt(id), invariantIndex, secret, salt], GAS.revealBreak));
  },

  async closeHeld(w, id) {
    const cfg = await gatewayConfig();
    return txOf(await write(w, cfg.arena, defectArenaAbi, "closeHeld", [BigInt(id)], GAS.closeHeld));
  },
};
