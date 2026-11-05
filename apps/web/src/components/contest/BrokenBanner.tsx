"use client";

import { formatUsdc, shortAddress, type ContestDetail } from "@defect/shared";
import { useWallet } from "@/lib/wallet";

export function BrokenBanner({ c }: { c: ContestDetail }) {
  const { wallet } = useWallet();
  const youWon = !!wallet && !!c.winner && wallet.address.toLowerCase() === c.winner.toLowerCase();
  const rule = c.brokenInvariant != null ? c.invariants[c.brokenInvariant] : null;

  return (
    <section
      role="status"
      aria-live="assertive"
      className="sweep border-b border-broken text-[#ffe3e3]"
      style={{
        background: "#b3151b",
        backgroundImage: "repeating-linear-gradient(135deg, rgba(0,0,0,.12) 0 14px, rgba(0,0,0,0) 14px 28px)",
      }}
    >
      <div className="max-w-[1320px] mx-auto px-4 sm:px-6 py-7 flex flex-wrap items-center gap-x-10 gap-y-4">
        <span className="mono text-[56px] sm:text-[76px] leading-[0.9] font-bold tracking-[-0.04em] text-white">BROKEN</span>
        <div className="flex-[1_1_380px] min-w-0 flex flex-col gap-2">
          {youWon ? (
            <span className="text-[26px] font-bold text-white tracking-tight">You broke it. {formatUsdc(c.pool)} USDC is yours.</span>
          ) : (
            <span className="text-[22px] font-bold text-white">
              Winner <span className="mono">{c.winner ? shortAddress(c.winner, 6, 2) : "?"}</span> won <span className="mono">{formatUsdc(c.pool)} USDC</span>
            </span>
          )}
          {rule && <span className="text-[15px]">Rule broken: {rule.text}</span>}
          <span className="text-xs opacity-85">Paid by the contract in the same transaction as the break · no judge involved</span>
        </div>
      </div>
    </section>
  );
}
