"use client";

import Link from "next/link";
import { cx } from "../ui/primitives";
import { WRAP } from "../ui/editorial";
import { resetMockData } from "@/lib/api/mock/client";
import { config } from "@/lib/config";

const STACK = [
  { label: "Hedera", note: "Settlement" },
  { label: "0G", note: "Inference" },
  { label: "Chainlink CRE", note: "Re-verification" },
  { label: "x402", note: "Pay per message" },
];

const LINKS = [
  { href: "/warden/new", label: "Start validation" },
  { href: "/#contests", label: "Validations" },
  { href: "/about", label: "About" },
];

/** Site-wide footer. With no header nav, this is how every page reaches the others. */
export function SiteFooter() {
  return (
    <footer className="bg-text text-bg">
      <div className={cx(WRAP, "grid gap-12 py-16 sm:grid-cols-2 lg:grid-cols-12")}>
        <div className="lg:col-span-5">
          <p className="m-0 max-w-sm text-[17px] leading-snug text-bg/80">
            Litmus Protocol is a non-custodial system for the adversarial validation of AI agents. It holds no funds, adjudicates no attempts,
            and determines no outcomes.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-col gap-3 lg:col-span-3 lg:col-start-7">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-bg/50">Protocol</span>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-bg no-underline hover:text-bg/70">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-col gap-3 lg:col-span-3">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-bg/50">Built on</span>
          {STACK.map((s) => (
            <span key={s.label} className="flex justify-between gap-4">
              <span>{s.label}</span>
              <span className="text-bg/50">{s.note}</span>
            </span>
          ))}
        </div>
      </div>
      <div className={cx(WRAP, "overflow-hidden")}>
        <div aria-hidden className="select-none font-accent text-[clamp(5rem,21vw,20rem)] font-black uppercase leading-[0.8] tracking-[-0.02em] text-bg/90">
          Litmus
        </div>
      </div>
      <div className={cx(WRAP, "flex flex-wrap items-center justify-between gap-4 border-t border-bg/15 py-6 text-xs text-bg/60")}>
        <span>© {new Date().getFullYear()} Litmus Protocol</span>
        {config.dataMode === "mock" && (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-bg/60 hover:text-bg"
            onClick={() => {
              resetMockData();
              window.location.reload();
            }}
          >
            Reset demo data
          </button>
        )}
      </div>
    </footer>
  );
}
