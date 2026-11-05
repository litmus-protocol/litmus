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
  const {
    wallet,
    drawerOpen,
    closeDrawer,
    connect,
    connectWallet,
    connectAvailable,
    connectUnavailableReason,
    walletOptions,
    loadWalletOptions,
    otherAccounts,
    switchAccount,
    connecting,
    error,
    forget,
    balances,
    refreshBalances,
  } = useWallet();
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
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

  // Start WalletConnect (and detect wallet extensions) only once someone opens the drawer.
  useEffect(() => {
    if (drawerOpen && connectAvailable) loadWalletOptions();
  }, [drawerOpen, connectAvailable, loadWalletOptions]);

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
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3">
              <p className="m-0 text-muted leading-relaxed">
                Connect a Hedera wallet on <span className="text-soft">testnet</span>. It signs each payment and transaction; Defect never sees your key.
              </p>
              {walletOptions.map((o) => (
                <Button key={o.id} disabled={connecting || !connectAvailable} onClick={() => void connectWallet(o.id).then((ok) => ok && closeDrawer())}>
                  {o.icon && <img src={o.icon} alt="" width={18} height={18} className="rounded" />}
                  {connecting ? "Waiting for the wallet…" : `Connect ${o.name}`}
                </Button>
              ))}
              <Button
                variant={walletOptions.length > 0 ? "ghost" : "primary"}
                disabled={connecting || !connectAvailable}
                onClick={() => void connectWallet().then((ok) => ok && closeDrawer())}
              >
                {connecting ? "Waiting for the wallet…" : walletOptions.length > 0 ? "Other wallet (QR code)" : "Connect wallet (HashPack, Kabila…)"}
              </Button>
              {!connectAvailable && connectUnavailableReason && <p className="m-0 text-xs text-faint">{connectUnavailableReason}</p>}
              {config.dataMode === "mock" && !config.walletConnectProjectId && (
                <p className="m-0 text-xs text-faint">Mock mode: connects a pretend HashPack account with fake funds.</p>
              )}
            </div>

            {error && (
              <Callout tone="broken" icon={<WarnIcon size={16} />}>
                {error}
              </Callout>
            )}

            <div className="flex items-center gap-3 text-xs text-faint">
              <span className="h-px flex-1 bg-line" />
              or
              <span className="h-px flex-1 bg-line" />
            </div>

            {!showKey ? (
              <Button variant="ghost" onClick={() => setShowKey(true)}>
                Paste a testnet key (judge / dev key)
              </Button>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await connect(key)) setKey("");
                }}
              >
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
                <Button type="submit" disabled={connecting || !key.trim()}>
                  {connecting ? "Connecting…" : "Use this key"}
                </Button>
                {config.dataMode === "mock" && (
                  <Button variant="ghost" disabled={connecting} onClick={() => void connect(newDemoKey())}>
                    Use a demo key (fake funds)
                  </Button>
                )}
              </form>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="m-0 flex flex-col">
              {[
                ["Wallet", <span key="w" className="text-[13px]">{wallet.kind === "walletconnect" ? wallet.walletName : "Testnet key (this browser)"}</span>],
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

            {wallet.kind === "walletconnect" && otherAccounts.length > 0 && (
              <div className="flex flex-col gap-2">
                <label htmlFor="acct" className="text-[13px] font-medium text-soft">
                  Switch account
                </label>
                <select
                  id="acct"
                  className={inputCls}
                  value={wallet.accountId}
                  disabled={connecting}
                  onChange={(e) => void switchAccount(e.target.value)}
                >
                  {[wallet.accountId, ...otherAccounts].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {error && (
              <Callout tone="broken" icon={<WarnIcon size={16} />}>
                {error}
              </Callout>
            )}

            <Button variant="ghost" onClick={forget}>
              {wallet.kind === "walletconnect" ? "Disconnect" : "Forget key"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
