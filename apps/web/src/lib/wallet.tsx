"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, friendlyError, type Balances, type DevWallet } from "./api";

// Testnet dev wallet (build plan §11.1): a pasted ECDSA key kept in localStorage.

const STORAGE_KEY = "defect.devWallet";

interface WalletState {
  wallet: DevWallet | null;
  restoring: boolean;
  connecting: boolean;
  error: string | null;
  connect: (rawKey: string) => Promise<boolean>;
  forget: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  balances: Balances | undefined;
  refreshBalances: () => void;
}

const Ctx = createContext<WalletState | null>(null);

export function normalizeKey(raw: string): `0x${string}` | null {
  const k = raw.trim().replace(/^0x/i, "");
  // Hedera portal can show DER-encoded ECDSA keys; the raw key is the last 32 bytes.
  const hex = /^3030020100300706052b8104000a04220420[0-9a-f]{64}$/i.test(k) ? k.slice(-64) : k;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? (`0x${hex.toLowerCase()}` as `0x${string}`) : null;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<DevWallet | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        const key = saved ? normalizeKey((JSON.parse(saved) as { privateKey: string }).privateKey) : null;
        if (key) {
          const w = await api.resolveWallet(key);
          if (!cancelled) setWallet(w);
        }
      } catch {
        // stale or unreadable key: start disconnected
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (rawKey: string) => {
    const key = normalizeKey(rawKey);
    if (!key) {
      setError("That doesn't look like a private key. Paste the 64-character hex key (with or without 0x).");
      return false;
    }
    setConnecting(true);
    setError(null);
    try {
      const w = await api.resolveWallet(key);
      setWallet(w);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ privateKey: key }));
      } catch {
        // storage blocked: wallet works for this tab only
      }
      return true;
    } catch (e) {
      setError(friendlyError(e));
      return false;
    } finally {
      setConnecting(false);
    }
  }, []);

  const forget = useCallback(() => {
    setWallet(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    qc.removeQueries({ queryKey: ["balances"] });
  }, [qc]);

  const balancesQuery = useQuery({
    queryKey: ["balances", wallet?.address],
    queryFn: () => api.getBalances(wallet!),
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
      forget,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      balances: balancesQuery.data,
      refreshBalances: () => void balancesQuery.refetch(),
    }),
    [wallet, restoring, connecting, error, connect, forget, drawerOpen, balancesQuery],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet must be used inside WalletProvider");
  return v;
}
