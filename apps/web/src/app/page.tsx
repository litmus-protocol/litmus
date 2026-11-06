"use client";

import { useState } from "react";
import { ENDED_PHASES, formatUsdc, type ContestSummary } from "@defect/shared";
import { ContestCard } from "@/components/home/ContestCard";
import { Custodial, HowLitmusWorks, Hero, PickYourSide, WhatIsLitmus } from "@/components/home/marketing";
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
    <main className="flex flex-col pb-16">
      <Hero openCount={openCount} />

      {/* The live product sits directly under the hero: the pitch is above
          it and the argument for it below, so a visitor can act before
          reading any of it. */}
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-10 px-4 pt-0 sm:px-6">
        <Card className="grid grid-cols-1 sm:grid-cols-3">
          {[
            ["Agents validated", stats.data?.contests.toLocaleString()],
            ["Stakes broken", stats.data ? `${formatUsdc(stats.data.paidToBreakers)} USDC` : undefined],
            ["Conversations happened", stats.data?.attempts.toLocaleString()],
          ].map(([label, value], i) => (
            <div key={label} className={cx("flex flex-col gap-1.5 p-5", i > 0 && "border-t border-line sm:border-t-0 sm:border-l")}>
              <span className="eyebrow">{label}</span>
              {value ? <span className="mono text-2xl font-semibold">{value}</span> : <Skeleton className="h-7 w-24" />}
            </div>
          ))}
        </Card>

        <section id="contests" className="flex scroll-mt-6 flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="m-0 text-2xl font-bold tracking-tight">Validations</h2>
            <div role="tablist" aria-label="Filter validations" className="flex gap-1 rounded-none border border-border bg-surface p-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cx(
                    "min-h-9 cursor-pointer rounded-none border-0 px-3 text-[13px] font-medium",
                    tab === t.key ? "bg-chip text-text" : "bg-transparent text-muted hover:text-text",
                  )}
                >
                  {t.label} <span className="mono ml-1 text-faint">{all.filter(t.match).length}</span>
                </button>
              ))}
            </div>
          </div>

          {contests.isLoading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
              {[0, 1, 2].map((i) => (
                <Card key={i} className="flex flex-col gap-3.5 p-5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-8 w-40" />
                </Card>
              ))}
            </div>
          ) : contests.isError ? (
            <Card className="p-6 text-muted">Couldn&apos;t load contests. {String((contests.error as Error).message)}</Card>
          ) : shown.length === 0 ? (
            <Card className="flex flex-col items-center gap-3 p-8 text-center">
              <span className="font-semibold">{tab === "open" ? "No open validations right now" : tab === "upcoming" ? "Nothing scheduled yet" : "No finished validations yet"}</span>
              <ButtonLink href="/warden/new" variant="ghost">
                Start a validation
              </ButtonLink>
            </Card>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
              {shown.map((c) => (
                <ContestCard key={c.contestId} c={c} />
              ))}
            </div>
          )}
        </section>
      </div>

      <Custodial />
      <WhatIsLitmus />
      <HowLitmusWorks />
      <PickYourSide />

      <footer className="mx-auto mt-24 flex w-full max-w-[1320px] flex-wrap items-center justify-between gap-4 border-t border-line px-4 pt-6 text-xs text-faint sm:px-6">
        <span>Built on Hedera · 0G · Chainlink CRE · x402</span>
        <span className="flex items-center gap-4">
          {config.dataMode === "mock" && (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-xs text-faint hover:text-accent"
              onClick={() => {
                resetMockData();
                window.location.reload();
              }}
            >
              Reset demo data
            </button>
          )}
          <a href="/about" className="text-faint no-underline hover:text-accent">
            How breaks are proven
          </a>
        </span>
      </footer>
    </main>
  );
}
