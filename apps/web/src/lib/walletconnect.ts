// Hedera wallets over WalletConnect (HashPack, Kabila, Blade, …) via the official
// @hashgraph/hedera-wallet-connect DAppConnector. Browser only, loaded on demand, so mock mode
// and first paint never pull in the WalletConnect client or the Hiero SDK.
//
// Deep imports (dist/lib/dapp, dist/lib/shared) skip the package root, which also re-exports
// the Reown AppKit adapter (and with it ethers and @reown/*), none of which this app uses.

import { LedgerId } from "@hiero-ledger/sdk";
import { DAppConnector, type DAppSigner } from "@hashgraph/hedera-wallet-connect/dist/lib/dapp";
import { HederaChainId, HederaJsonRpcMethod, HederaSessionEvent, type ExtensionData } from "@hashgraph/hedera-wallet-connect/dist/lib/shared";
import { config } from "./config";
import { ApiError } from "./api/errors";

export interface WcAccount {
  accountId: string;
  walletName: string;
  topic: string;
}

let connectorPromise: Promise<DAppConnector> | null = null;
const listeners = new Set<() => void>();

export function walletConnectConfigured(): boolean {
  return config.walletConnectProjectId.length > 0;
}

export function getConnector(): Promise<DAppConnector> {
  if (!walletConnectConfigured()) {
    return Promise.reject(new ApiError("WALLETCONNECT_NOT_CONFIGURED", "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to connect a Hedera wallet."));
  }
  connectorPromise ??= (async () => {
    const origin = window.location.origin;
    const c = new DAppConnector(
      { name: "Defect", description: "Break AI agents, win USDC bounties on Hedera.", url: origin, icons: [] },
      LedgerId.TESTNET,
      config.walletConnectProjectId,
      Object.values(HederaJsonRpcMethod),
      [HederaSessionEvent.AccountsChanged, HederaSessionEvent.ChainChanged],
      [HederaChainId.Testnet],
      "warn",
    );
    await c.init({ logger: "error" });
    // init() logs and swallows its own errors; a missing client means it failed.
    if (!c.walletConnectClient) throw new ApiError("WALLETCONNECT_FAILED", "WalletConnect failed to start. Check the project id and your network.");
    // Our listeners run after the connector's own handlers (which rebuild its signer list).
    const notify = () => setTimeout(() => listeners.forEach((l) => l()), 0);
    for (const ev of ["session_delete", "session_update", "session_event", "session_expire"] as const) c.walletConnectClient.on(ev, notify);
    return c;
  })().catch((e) => {
    connectorPromise = null;
    throw e;
  });
  return connectorPromise;
}

/** Called when a session ends, changes accounts or expires (wallet side or ours). */
export function onWalletConnectChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function peerName(c: DAppConnector, topic: string): string {
  try {
    return c.walletConnectClient?.session.get(topic).peer.metadata.name || "Hedera wallet";
  } catch {
    return "Hedera wallet";
  }
}

/** Every testnet account shared by every live session, most recent session last. */
export async function connectedAccounts(): Promise<WcAccount[]> {
  const c = await getConnector();
  return c.signers
    .filter((s) => s.getLedgerId().toString() === LedgerId.TESTNET.toString())
    .map((s) => ({ accountId: s.getAccountId().toString(), walletName: peerName(c, s.topic), topic: s.topic }));
}

/** Browser extensions (HashPack, Kabila, Blade) that answered the discovery ping. */
export async function availableExtensions(): Promise<ExtensionData[]> {
  const c = await getConnector();
  return c.extensions.filter((e) => e.available);
}

/** Opens the QR modal (or connects a browser extension) and returns the accounts the wallet shared. */
export async function connectWallet(extensionId?: string): Promise<WcAccount[]> {
  const c = await getConnector();
  let topic: string;
  try {
    const session = extensionId ? await c.connectExtension(extensionId) : await c.openModal(undefined, true);
    topic = session.topic;
  } catch (e) {
    const err = walletError(e, "Wallet connection failed.");
    throw err.code === "WALLET_REJECTED" ? new ApiError("WALLET_CONNECT_CANCELLED", err.message) : err;
  }
  const accounts = (await connectedAccounts()).filter((a) => a.topic === topic);
  if (accounts.length === 0) throw new ApiError("WRONG_NETWORK", "The wallet shared no Hedera testnet account. Switch the wallet to testnet and connect again.");
  return accounts;
}

export async function disconnectWallet(accountId: string): Promise<void> {
  const c = await getConnector();
  const topics = new Set(c.signers.filter((s) => s.getAccountId().toString() === accountId).map((s) => s.topic));
  for (const topic of topics) await c.disconnect(topic);
  c.signers = c.signers.filter((s) => !topics.has(s.topic));
}

export async function signerFor(accountId: string): Promise<DAppSigner> {
  const c = await getConnector();
  // Newest session wins if the same account is shared twice.
  const signer = [...c.signers].reverse().find((s) => s.getAccountId().toString() === accountId);
  if (!signer) throw new ApiError("WALLET_DISCONNECTED", "Your wallet session ended. Connect the wallet again.");
  return signer;
}

/** WalletConnect errors are plain objects ({ code, message }); map rejections to one code. */
export function walletError(e: unknown, fallback = "The wallet request failed."): ApiError {
  if (e instanceof ApiError) return e;
  const code = typeof e === "object" && e && "code" in e ? Number((e as { code: unknown }).code) : NaN;
  const message = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  if (code === 4001 || code === 5000 || code === 9000 || /reject|denied|cancel/i.test(message)) {
    return new ApiError("WALLET_REJECTED", message || "Rejected in the wallet.");
  }
  if (/session no longer exists|no matching key|session.*not found/i.test(message)) return new ApiError("WALLET_DISCONNECTED", message);
  return new ApiError("WALLET_ERROR", message || fallback);
}
