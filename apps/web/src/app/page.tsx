"use client";

import { useState } from "react";
import { ENDED_PHASES, formatUsdc, type ContestSummary } from "@defect/shared";
import { ContestCard } from "@/components/home/ContestCard";
import { ButtonLink, Card, Skeleton, cx } from "@/components/ui/primitives";
import { resetMockData } from "@/lib/api/mock/client";
import { config } from "@/lib/config";
import { useContests, useStats } from "@/lib/hooks";

type Tab = "open" | "upcoming" | "ended";

const TABS: { key: Tab; label: string; match: (c: ContestSummary) => boolean }[] = [
  { key: "open", label: "Open now", match: (c) => c.phase === "open" || c.phase === "awaiting_close" },
  { key: "upcoming", label: "Upcoming", match: (c) => c.phase === "scheduled" },
  { key: "ended", label: "Ended", match: (c) => ENDED_PHASES.includes(c.phase) },
];

export default function HomePage() {
  const [tab, setTab] = useState<Tab>("open");
  const contests = useContests("all");
  const stats = useStats();
  const all = contests.data ?? [];
  const current = TABS.find((t) => t.key === tab)!;
  // Open contests: biggest prize first. Others: newest first (the API order).
  const shown = all.filter(current.match).sort((a, b) => (tab === "open" ? Number(b.pool) - Number(a.pool) : 0));
  const openCount = all.filter(TABS[0]!.match).length;

  return (
    <main className="max-w-[1320px] mx-auto px-4 sm:px-6 pt-10 pb-16 flex flex-col gap-10">
      <section className="flex flex-col gap-5 max-w-[760px]">
        {openCount > 0 && (
          <span className="inline-flex items-center gap-2 self-start text-xs text-open">
            <span className="w-2 h-2 rounded-full bg-open pulse-dot" />
            {openCount} {openCount === 1 ? "contest" : "contests"} open now
          </span>
        )}
        <h1 className="m-0 text-[44px] sm:text-[64px] leading-[0.98] font-bold tracking-[-0.04em]">
          Break the AI.
          <br />
          <span className="text-accent">Take the pool.</span>
        </h1>
        <p className="m-0 text-base sm:text-lg text-muted leading-relaxed max-w-[600px]">
          AI companies stake money on their agents&apos; safety rules. Make the agent break one and the contract pays you instantly.
        </p>
        <div className="flex gap-3 flex-wrap">
          <ButtonLink href="#contests">Browse contests</ButtonLink>
          <ButtonLink href="/warden/new" variant="ghost">
            Create a contest
          </ButtonLink>
        </div>
      </section>

      <Card className="grid grid-cols-2 lg:grid-cols-4">
        {[
          ["Contests run", stats.data?.contests.toLocaleString()],
          ["Messages sent", stats.data?.attempts.toLocaleString()],
          ["Paid to Breakers", stats.data ? `${formatUsdc(stats.data.paidToBreakers)} USDC` : undefined],
          ["AI calls on 0G", stats.data?.ogRequests.toLocaleString()],
        ].map(([label, value], i) => (
          <div key={label} className={cx("flex flex-col gap-1.5 p-5", i > 0 && "lg:border-l border-line", i % 2 === 1 && "border-l border-line", i > 1 && "border-t lg:border-t-0 border-line")}>
            <span className="eyebrow">{label}</span>
            {value ? <span className="mono text-2xl font-semibold">{value}</span> : <Skeleton className="h-7 w-24" />}
          </div>
        ))}
      </Card>

      <section id="contests" className="flex flex-col gap-5 scroll-mt-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h2 className="m-0 text-2xl font-bold tracking-tight">Contests</h2>
          <div role="tablist" aria-label="Filter contests" className="flex gap-1 p-1 rounded-[10px] bg-surface border border-border">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cx(
                  "px-3 min-h-9 rounded-lg text-[13px] font-medium cursor-pointer border-0",
                  tab === t.key ? "bg-chip text-text" : "bg-transparent text-muted hover:text-text",
                )}
              >
                {t.label} <span className="mono text-faint ml-1">{all.filter(t.match).length}</span>
              </button>
            ))}
          </div>
        </div>

        {contests.isLoading ? (
          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))]">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-5 flex flex-col gap-3.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-8 w-40" />
              </Card>
            ))}
          </div>
        ) : contests.isError ? (
          <Card className="p-6 text-muted">Couldn&apos;t load contests. {String((contests.error as Error).message)}</Card>
        ) : shown.length === 0 ? (
          <Card className="p-8 flex flex-col items-center gap-3 text-center">
            <span className="font-semibold">{tab === "open" ? "No open contests right now" : tab === "upcoming" ? "Nothing scheduled yet" : "No finished contests yet"}</span>
            <ButtonLink href="/warden/new" variant="ghost">
              Create a contest
            </ButtonLink>
          </Card>
        ) : (
          <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))]">
            {shown.map((c) => (
              <ContestCard key={c.contestId} c={c} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-5">
        <h2 className="m-0 text-2xl font-bold tracking-tight">How it works</h2>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
          {[
            ["Pay per message", "Each message costs a few cents. 70% of every fee goes straight into the prize pool. Slow replies are free."],
            ["Make the agent break a rule", "Talk it into leaking its secret, overspending, or calling a tool it promised never to touch."],
            ["The contract pays you", "The break is proven by code, and the whole pool lands in your wallet in the same transaction."],
          ].map(([title, body], i) => (
            <Card key={title} className="p-5 flex flex-col gap-2">
              <span className="mono text-accent text-sm">0{i + 1}</span>
              <span className="font-semibold">{title}</span>
              <span className="text-muted leading-relaxed">{body}</span>
            </Card>
          ))}
        </div>
      </section>

      <footer className="flex items-center justify-between gap-4 flex-wrap pt-6 border-t border-line text-xs text-faint">
        <span>Built on Hedera · 0G · Chainlink</span>
        <span className="flex gap-4 items-center">
          {config.dataMode === "mock" && (
            <button
              type="button"
              className="text-faint hover:text-accent bg-transparent border-0 cursor-pointer text-xs p-0"
              onClick={() => {
                resetMockData();
                window.location.reload();
              }}
            >
              Reset demo data
            </button>
          )}
          <a href="/about" className="text-faint hover:text-accent no-underline">
            How breaks are proven
          </a>
        </span>
      </footer>
    </main>
  );
}
