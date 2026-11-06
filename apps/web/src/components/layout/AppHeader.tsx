"use client";

import Link from "next/link";
import { shortAddress } from "@defect/shared";
import { useWallet } from "@/lib/wallet";

export function AppHeader() {
  const { wallet, openDrawer, restoring } = useWallet();

  return (
    <header className="flex items-center justify-between gap-4 flex-wrap px-4 sm:px-6 py-3 border-b border-line">
      <Link href="/" className="flex flex-1 items-center gap-3 no-underline text-text font-accent text-[17px] font-black uppercase leading-[1.05] tracking-[0.12em]">
        {/* The bold small mark (64-px dither grid) holds up at header size; the full mark's halo is too fine here. */}
        <img src="/brand/litmus-mark-small.svg" alt="" width={40} height={40} className="shrink-0" />
        <span className="flex flex-col justify-center">
          <span>LITMUS</span>
          <span>PROTOCOL</span>
        </span>
      </Link>
      <div className="flex flex-1 items-center justify-end gap-1">
        {wallet ? (
          <button
            type="button"
            onClick={openDrawer}
            className="inline-flex items-center min-h-10 px-4 rounded-none border border-border-strong bg-[color-mix(in_srgb,var(--text)_5%,transparent)] text-text cursor-pointer"
          >
            {/* Balance lives in the wallet drawer; the header shows only who is connected. */}
            <span className="text-[13px] tabular-nums">{shortAddress(wallet.address, 6, 4)}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={openDrawer}
            disabled={restoring}
            className="inline-flex items-center min-h-10 px-4 rounded-none bg-accent text-on-accent text-sm font-medium cursor-pointer border-0 disabled:opacity-50"
          >
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}
