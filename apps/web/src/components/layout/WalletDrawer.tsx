"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatUsdc, hashscanAccount } from "@defect/shared";
import { api } from "@/lib/api";
import { newDemoKey } from "@/lib/api/mock/client";
import { config } from "@/lib/config";
import { useTx } from "@/lib/useTx";
import { useWallet } from "@/lib/wallet";
import { CheckIcon, WarnIcon, XIcon } from "../ui/icons";
import { Button, Callout, CopyText, inputCls } from "../ui/primitives";

export function WalletDrawer() {
  const { wallet, drawerOpen, closeDrawer, connect, connecting, error, forget, balances, refreshBalances } = useWallet();
  const [key, setKey] = useState("");
  const { run, busy } = useTx();
  const qc = useQueryClient();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeDrawer();
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  if (!drawerOpen) return null;

  const afterTx = () => {
    refreshBalances();
    void qc.invalidateQueries();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close wallet" onClick={closeDrawer} className="absolute inset-0 bg-black/50 border-0 cursor-default" />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Wallet"
        className="relative w-full max-w-[440px] h-full overflow-y-auto bg-surface border-l border-border p-6 flex flex-col gap-5 outline-none"
      >
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-xl font-semibold">{wallet ? "Wallet" : "Connect a wallet"}</h2>
          <button type="button" onClick={closeDrawer} aria-label="Close" className="w-11 h-11 grid place-items-center text-muted hover:text-text bg-transparent border-0 cursor-pointer">
            <XIcon size={18} />
          </button>
        </div>

        {!wallet ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await connect(key)) setKey("");
            }}
          >
            <p className="m-0 text-muted leading-relaxed">
              Hedera payments can&apos;t be signed by MetaMask, so Defect uses a testnet dev wallet that lives in this browser.
            </p>
            <div className="flex flex-col gap-2">
              <label htmlFor="devkey" className="text-[13px] font-medium text-soft">
                Hedera testnet private key (ECDSA)
              </label>
              <input
                id="devkey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="0x… (64 hex characters)"
                className={`${inputCls} mono`}
              />
              <a href="https://portal.hedera.com" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-accent no-underline">
                Where do I get one? Create an ECDSA testnet account at portal.hedera.com ↗
              </a>
            </div>
            <Callout tone="warn" icon={<WarnIcon size={16} />}>
              Never paste a key that holds real money. The key is stored only in this browser.
            </Callout>
            {error && (
              <Callout tone="broken" icon={<WarnIcon size={16} />}>
                {error}
              </Callout>
            )}
            <Button type="submit" disabled={connecting || !key.trim()}>
              {connecting ? "Connecting…" : "Connect"}
            </Button>
            {config.dataMode === "mock" && (
              <Button variant="ghost" disabled={connecting} onClick={() => void connect(newDemoKey())}>
                Use a demo wallet (fake funds)
              </Button>
            )}
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="m-0 flex flex-col">
              {[
                ["Address", <CopyText key="a" text={wallet.address} display={`${wallet.address.slice(0, 8)}…${wallet.address.slice(-6)}`} />],
                [
                  "Hedera account",
                  <a key="b" href={hashscanAccount(wallet.accountId)} target="_blank" rel="noreferrer" className="mono text-xs text-soft hover:text-accent no-underline">
                    {wallet.accountId} ↗
                  </a>,
                ],
                ["HBAR", <span key="c" className="mono">{balances?.hbar ?? "…"}</span>],
                ["USDC", <span key="d" className="mono text-accent">{balances ? formatUsdc(balances.usdc) : "…"}</span>],
                [
                  "USDC status",
                  balances?.usdcAssociated ? (
                    <span key="e" className="inline-flex items-center gap-1.5 text-open text-[13px]">
                      <CheckIcon size={14} /> Ready
                    </span>
                  ) : (
                    <span key="e" className="text-warn text-[13px]">
                      Not enabled
                    </span>
                  ),
                ],
              ].map(([label, value]) => (
                <div key={label as string} className="flex justify-between items-center gap-4 py-3 border-b border-line">
                  <dt className="text-muted">{label}</dt>
                  <dd className="m-0">{value}</dd>
                </div>
              ))}
            </dl>

            {balances && !balances.usdcAssociated && (
              <div className="flex flex-col gap-2">
                <p className="m-0 text-xs text-faint leading-relaxed">Hedera accounts must enable a token before they can receive it.</p>
                <Button disabled={busy} onClick={() => void run("Enabling USDC", () => api.associateUsdc(wallet)).then(afterTx)}>
                  Enable USDC
                </Button>
              </div>
            )}

            {balances && Number(balances.withdrawable) > 0 && (
              <div className="flex flex-col gap-2 p-4 rounded-[10px] border border-border bg-sunken">
                <span className="text-[13px]">
                  The contract owes you <span className="mono text-accent">{formatUsdc(balances.withdrawable)} USDC</span>
                </span>
                <Button disabled={busy} onClick={() => void run("Withdrawing", () => api.withdraw(wallet)).then(afterTx)}>
                  Withdraw
                </Button>
              </div>
            )}

            {config.dataMode === "live" && (
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-accent no-underline">
                Need testnet USDC? Circle faucet → Hedera Testnet ↗
              </a>
            )}

            <Button variant="ghost" onClick={forget}>
              Forget key
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
