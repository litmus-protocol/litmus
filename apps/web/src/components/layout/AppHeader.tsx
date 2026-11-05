"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { formatUsdc, shortAddress } from "@defect/shared";
import { useWallet } from "@/lib/wallet";
import { LogoIcon, MoonIcon, SunIcon } from "../ui/icons";
import { cx } from "../ui/primitives";

const NAV = [
  { href: "/", label: "Contests", match: (p: string) => p === "/" || p.startsWith("/contests") },
  { href: "/warden/new", label: "Create contest", match: (p: string) => p.startsWith("/warden") },
  { href: "/about", label: "About", match: (p: string) => p.startsWith("/about") },
];

function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => setLight(document.documentElement.dataset.theme === "light"), []);
  const toggle = () => {
    const next = !light;
    setLight(next);
    if (next) document.documentElement.dataset.theme = "light";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("defect.theme", next ? "light" : "dark");
    } catch {
      // ignore
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      className="w-11 h-11 grid place-items-center rounded-lg text-muted hover:text-text cursor-pointer bg-transparent border-0"
    >
      {light ? <MoonIcon size={18} /> : <SunIcon size={18} />}
    </button>
  );
}

export function AppHeader() {
  const pathname = usePathname();
  const { wallet, balances, openDrawer, restoring } = useWallet();

  return (
    <header className="flex items-center justify-between gap-4 flex-wrap px-4 sm:px-6 py-3 border-b border-line">
      <Link href="/" className="flex items-center gap-2.5 no-underline text-text text-[17px] font-bold tracking-tight">
        <LogoIcon size={24} className="text-accent" />
        Defect
      </Link>
      <nav aria-label="Main" className="flex gap-1 flex-wrap order-3 sm:order-none w-full sm:w-auto">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={cx(
              "px-3 py-2 rounded-lg text-sm no-underline",
              n.match(pathname) ? "bg-chip text-text" : "text-muted hover:text-text",
            )}
          >
            {n.label}
          </Link>
        ))}
      </nav>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        {wallet ? (
          <button
            type="button"
            onClick={openDrawer}
            className="inline-flex items-center gap-2.5 min-h-10 pl-3 pr-1.5 rounded-lg border border-border-strong bg-[color-mix(in_srgb,var(--text)_5%,transparent)] text-text cursor-pointer"
          >
            <span className="w-2 h-2 rounded-full bg-open" />
            <span className="mono text-[13px]">{shortAddress(wallet.address)}</span>
            <span className="mono text-xs bg-chip px-2 py-1 rounded-md text-accent hidden sm:inline">{balances ? `${formatUsdc(balances.usdc)} USDC` : "…"}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={openDrawer}
            disabled={restoring}
            className="inline-flex items-center min-h-10 px-4 rounded-lg bg-accent text-on-accent text-sm font-medium cursor-pointer border-0 disabled:opacity-50"
          >
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}
