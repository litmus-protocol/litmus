"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatUsdc, shortAddress } from "@defect/shared";
import { useWallet } from "@/lib/wallet";
import { cx } from "../ui/primitives";

const NAV = [
  { href: "/", label: "Validations", match: (p: string) => p === "/" || p.startsWith("/contests") },
  { href: "/warden/new", label: "Start validation", match: (p: string) => p.startsWith("/warden") },
  { href: "/about", label: "About", match: (p: string) => p.startsWith("/about") },
];

export function AppHeader() {
  const pathname = usePathname();
  const { wallet, balances, openDrawer, restoring } = useWallet();

  return (
    <header className="flex items-center justify-between gap-4 flex-wrap px-4 sm:px-6 py-3 border-b border-line">
      <Link href="/" className="flex flex-1 flex-col justify-center no-underline text-text font-accent text-[17px] font-black uppercase leading-[1.05] tracking-[0.12em]">
        <span>LITMUS</span>
        <span>PROTOCOL</span>
      </Link>
      <nav aria-label="Main" className="flex gap-1 flex-wrap order-3 sm:order-none w-full sm:w-auto">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={cx(
              "px-3 py-2 rounded-none text-sm no-underline",
              n.match(pathname) ? "bg-chip text-text" : "text-muted hover:text-text",
            )}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      {/* flex-1 on both outer groups, not justify-between: the logo and the
          wallet cluster are different widths, so space-between pushed the nav
          off centre by half the difference. Equal flex tracks either side put
          it on the true centre line whatever they contain. */}
      <div className="flex flex-1 items-center justify-end gap-1">
        {wallet ? (
          <button
            type="button"
            onClick={openDrawer}
            className="inline-flex items-center gap-2.5 min-h-10 pl-3 pr-1.5 rounded-none border border-border-strong bg-[color-mix(in_srgb,var(--text)_5%,transparent)] text-text cursor-pointer"
          >
            <span className="w-2 h-2 rounded-full bg-open" />
            <span className="mono text-[13px]">{shortAddress(wallet.address)}</span>
            <span className="mono text-xs bg-chip px-2 py-1 rounded-none text-accent hidden sm:inline">{balances ? `${formatUsdc(balances.usdc)} USDC` : "…"}</span>
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
