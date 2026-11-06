"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, friendlyError, type Balances, type ConnectedWallet, type KeyWallet, type Wallet } from "./api";
import { newDemoAccountId } from "./api/mock/client";
import { config } from "./config";
import { mirrorBalances, resolveHederaAccount } from "./hedera-account";

// Two ways to hold a wallet, behind one adapter shape:
//  - "key": the testnet dev wallet (build plan §11.1), a pasted ECDSA key kept in localStorage.
//  - "walletconnect": a Hedera wallet (HashPack, Kabila, Blade, …) over WalletConnect. The wallet
//    keeps the key; the session itself is persisted by the WalletConnect client, and we only
//    remember which account was selected.

const STORAGE_KEY = "defect.wallet";
const LEGACY_KEY = "defect.devWallet";

type Saved = { kind: "key"; privateKey: string } | { kind: "walletconnect"; accountId: string };

export interface WalletOption {
  /** Extension id for a direct browser-extension connect; undefined = WalletConnect QR modal. */
  id?: string;
  name: string;
  icon?: string;
}

interface WalletAdapter<W extends Wallet, P> {
  restore(saved: Saved): Promise<W | null>;
  connect(params: P): Promise<{ wallet: W; others: string[] }>;
  disconnect(w: W): Promise<void>;
}

export function normalizeKey(raw: string): `0x${string}` | null {
  const k = raw.trim().replace(/^0x/i, "");
  // Hedera portal can show DER-encoded ECDSA keys; the raw key is the last 32 bytes.
  const hex = /^3030020100300706052b8104000a04220420[0-9a-f]{64}$/i.test(k) ? k.slice(-64) : k;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? (`0x${hex.toLowerCase()}` as `0x${string}`) : null;
}

const keyAdapter: WalletAdapter<KeyWallet, string> = {
  async restore(saved) {
    const key = saved.kind === "key" ? normalizeKey(saved.privateKey) : null;
    return key ? api.resolveWallet(key) : null;
  },
  async connect(rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) throw new Error("That doesn't look like a private key. Paste the 64-character hex key (with or without 0x).");
    return { wallet: await api.resolveWallet(key), others: [] };
  },
  async disconnect() {},
};

// Mock mode: a pretend WalletConnect wallet so the connect flow can be demoed with no project id.
const MOCK_WALLET_NAME = "HashPack (demo)";
const mockConnectAdapter: WalletAdapter<ConnectedWallet, string | undefined> = {
  async restore(saved) {
    return saved.kind === "walletconnect" ? api.resolveAccount(saved.accountId, MOCK_WALLET_NAME) : null;
  },
  async connect() {
    await new Promise((r) => setTimeout(r, 700));
    return { wallet: await api.resolveAccount(newDemoAccountId(), MOCK_WALLET_NAME), others: [] };
  },
  async disconnect() {},
};

const wcAdapter: WalletAdapter<ConnectedWallet, string | undefined> = {
  async restore(saved) {
    if (saved.kind !== "walletconnect") return null;
    const wc = await import("./walletconnect");
    const accounts = await wc.connectedAccounts();
    const hit = accounts.find((a) => a.accountId === saved.accountId) ?? accounts.at(-1);
    return hit ? resolveHederaAccount(hit.accountId, hit.walletName) : null;
  },
  async connect(extensionId) {
    const wc = await import("./walletconnect");
    const accounts = await wc.connectWallet(extensionId);
    const first = accounts[0]!;
    return { wallet: await resolveHederaAccount(first.accountId, first.walletName), others: accounts.slice(1).map((a) => a.accountId) };
  },
  async disconnect(w) {
    const wc = await import("./walletconnect");
    await wc.disconnectWallet(w.accountId);
  },
};

/** Real WalletConnect whenever a project id is set (mock data mode included); a fake one in mock mode without it. */
const realWalletConnect = config.walletConnectProjectId.length > 0;
const connectAdapter = realWalletConnect ? wcAdapter : mockConnectAdapter;

/** Whether "Connect wallet" can work here, and why not. */
const connectAvailability: { available: boolean; reason?: string } =
  realWalletConnect || config.dataMode === "mock"
    ? { available: true }
    : { available: false, reason: "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable HashPack and other Hedera wallets." };

interface WalletState {
  wallet: Wallet | null;
  restoring: boolean;
  connecting: boolean;
  error: string | null;
  /** Dev key ("paste key / judge key"). */
  connect: (rawKey: string) => Promise<boolean>;
  /** WalletConnect: QR modal, or a detected browser extension by id. */
  connectWallet: (extensionId?: string) => Promise<boolean>;
  connectAvailable: boolean;
  connectUnavailableReason?: string;
  /** Detected wallet extensions (live mode, once WalletConnect has started). */
  walletOptions: WalletOption[];
  loadWalletOptions: () => void;
  /** Other accounts the connected wallet shared, for switching. */
  otherAccounts: string[];
  switchAccount: (accountId: string) => Promise<void>;
  forget: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  balances: Balances | undefined;
  refreshBalances: () => void;
}

const Ctx = createContext<WalletState | null>(null);

function readSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Saved;
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) return { kind: "key", privateKey: (JSON.parse(legacy) as { privateKey: string }).privateKey };
  } catch {
    // unreadable
  }
  return null;
}

function writeSaved(saved: Saved | null) {
  try {
    if (saved) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    else window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    // storage blocked: wallet works for this tab only
  }
}

const savedOf = (w: Wallet): Saved => (w.kind === "key" ? { kind: "key", privateKey: w.privateKey } : { kind: "walletconnect", accountId: w.accountId });

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);
  const [otherAccounts, setOtherAccounts] = useState<string[]>([]);
  const walletRef = useRef<Wallet | null>(null);
  walletRef.current = wallet;
  const qc = useQueryClient();

  const adopt = useCallback((w: Wallet | null) => {
    setWallet(w);
    writeSaved(w ? savedOf(w) : null);
  }, []);

  // Restore on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = readSaved();
        if (!saved) return;
        const w = saved.kind === "key" ? await keyAdapter.restore(saved) : await connectAdapter.restore(saved);
        if (!cancelled) setWallet(w);
        if (!cancelled && !w) writeSaved(null); // the wallet ended the session while we were away
      } catch {
        // stale key or session: start disconnected
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // WalletConnect session changes (wallet disconnected, accounts changed, expiry).
  useEffect(() => {
    if (!realWalletConnect) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;
    void import("./walletconnect").then((wc) => {
      if (cancelled) return;
      unsub = wc.onWalletConnectChange(async () => {
        const cur = walletRef.current;
        if (cur?.kind !== "walletconnect") return;
        const accounts = await wc.connectedAccounts().catch(() => []);
        if (!accounts.some((a) => a.accountId === cur.accountId)) {
          adopt(null);
          setOtherAccounts([]);
          setError("Your wallet ended the session. Connect it again.");
        } else {
          setOtherAccounts(accounts.map((a) => a.accountId).filter((id) => id !== cur.accountId));
        }
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [adopt]);

  const loadWalletOptions = useCallback(() => {
    if (!realWalletConnect) return;
    void (async () => {
      try {
        const wc = await import("./walletconnect");
        // Extensions answer the discovery ping asynchronously; look twice.
        for (const delay of [0, 800]) {
          await new Promise((r) => setTimeout(r, delay));
          const ext = await wc.availableExtensions();
          setWalletOptions(ext.map((e) => ({ id: e.id, name: e.name ?? "Wallet extension", icon: e.icon })));
        }
        const cur = walletRef.current;
        if (cur?.kind === "walletconnect") {
          const accounts = await wc.connectedAccounts();
          setOtherAccounts(accounts.map((a) => a.accountId).filter((id) => id !== cur.accountId));
        }
      } catch (e) {
        setError(friendlyError(e));
      }
    })();
  }, []);

  const run = useCallback(
    async (fn: () => Promise<{ wallet: Wallet; others: string[] }>) => {
      setConnecting(true);
      setError(null);
      try {
        const { wallet: w, others } = await fn();
        adopt(w);
        setOtherAccounts(others);
        return true;
      } catch (e) {
        setError(friendlyError(e));
        return false;
      } finally {
        setConnecting(false);
      }
    },
    [adopt],
  );

  const connect = useCallback((rawKey: string) => run(() => keyAdapter.connect(rawKey)), [run]);
  const connectWallet = useCallback((extensionId?: string) => run(() => connectAdapter.connect(extensionId)), [run]);

  const switchAccount = useCallback(
    async (accountId: string) => {
      const cur = walletRef.current;
      if (cur?.kind !== "walletconnect") return;
      await run(async () => ({
        wallet: await resolveHederaAccount(accountId, cur.walletName),
        others: [...otherAccounts.filter((a) => a !== accountId), cur.accountId],
      }));
      qc.removeQueries({ queryKey: ["balances"] });
      qc.removeQueries({ queryKey: ["session"] });
    },
    [run, otherAccounts, qc],
  );

  const forget = useCallback(() => {
    const cur = walletRef.current;
    adopt(null);
    setOtherAccounts([]);
    setError(null);
    if (cur?.kind === "walletconnect") void connectAdapter.disconnect(cur).catch(() => undefined);
    qc.removeQueries({ queryKey: ["balances"] });
  }, [adopt, qc]);

  const balancesQuery = useQuery({
    queryKey: ["balances", wallet?.address],
    // Mock data mode has no gateway or contract: a real connected wallet shows its real mirror balances.
    queryFn: () => (config.dataMode === "mock" && wallet!.kind === "walletconnect" && realWalletConnect ? mirrorBalances(wallet!.accountId) : api.getBalances(wallet!)),
    enabled: !!wallet,
    refetchInterval: 15_000,
  });

  const value = useMemo<WalletState>(
    () => ({
      wallet,
      restoring,
      connecting,
      error,
      connect,
      connectWallet,
      connectAvailable: connectAvailability.available,
      connectUnavailableReason: connectAvailability.reason,
      walletOptions,
      loadWalletOptions,
      otherAccounts,
      switchAccount,
      forget,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      balances: balancesQuery.data,
      refreshBalances: () => void balancesQuery.refetch(),
    }),
    [wallet, restoring, connecting, error, connect, connectWallet, walletOptions, loadWalletOptions, otherAccounts, switchAccount, forget, drawerOpen, balancesQuery],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside WalletProvider");
  return v;
}
