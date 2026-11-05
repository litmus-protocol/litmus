"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { ENDED_PHASES, REVEAL_GRACE_SECONDS } from "@defect/shared";
import { BrokenBanner } from "@/components/contest/BrokenBanner";
import { ChatPanel } from "@/components/contest/ChatPanel";
import { ClaimPanel } from "@/components/contest/ClaimPanel";
import { ClosingPanel } from "@/components/contest/ClosingPanel";
import { ContestHeader } from "@/components/contest/ContestHeader";
import { HealthIndicator } from "@/components/contest/HealthIndicator";
import { ResultsView } from "@/components/contest/ResultsView";
import { RuleList } from "@/components/contest/RuleList";
import { ButtonLink, Card, Countdown, Skeleton, cx } from "@/components/ui/primitives";
import { friendlyError } from "@/lib/api";
import { useConfig, useContest } from "@/lib/hooks";

export default function ContestPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const contest = useContest(id);
  const cfg = useConfig();
  const [tab, setTab] = useState<"chat" | "claim">("chat");

  if (!Number.isInteger(id) || id < 1) return <NotFound />;
  if (contest.isLoading) {
    return (
      <main className="max-w-[1320px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
        <Skeleton className="h-4 w-28" />
        <Card className="p-6 flex flex-col gap-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-14 w-48 self-end" />
        </Card>
      </main>
    );
  }
  if (contest.isError || !contest.data) {
    return <NotFound message={contest.error ? friendlyError(contest.error) : undefined} />;
  }

  const c = contest.data;
  const ended = ENDED_PHASES.includes(c.phase);
  const hasSecret = c.invariants.some((i) => i.type === "secret");
  // The full-width banner is the "it just broke" moment; later visits get the outcome card instead.
  const freshBreak = c.phase === "broken" && !!c.endedAt && Date.now() / 1000 - c.endedAt < 600;

  return (
    <>
      {freshBreak && <BrokenBanner c={c} />}
      <main className="max-w-[1320px] mx-auto px-4 sm:px-6 pt-6 pb-16 flex flex-col gap-5">
        {ended ? (
          <>
            <ContestHeader c={c} />
            <ResultsView c={c} hideOutcome={freshBreak} />
          </>
        ) : (
          <>
            <ContestHeader c={c} />
            {c.phase === "awaiting_close" ? (
              <ClosingPanel c={c} revealGraceSeconds={cfg.data?.revealGraceSeconds ?? REVEAL_GRACE_SECONDS} />
            ) : (
              <div className="flex flex-wrap gap-5 items-start">
                <div className="flex-[1_1_420px] min-w-0 flex flex-col gap-5">
                  <RuleList invariants={c.invariants} brokenIndex={null} />
                  {c.phase === "open" && <HealthIndicator c={c} />}
                </div>
                <Card className="flex-[1.25_1_520px] min-w-0 overflow-hidden flex flex-col">
                  {c.phase === "scheduled" ? (
                    <div className="p-10 flex flex-col items-center gap-2 text-center min-h-[360px] justify-center">
                      <span className="eyebrow">Upcoming</span>
                      <Countdown to={c.startTime} className="text-[44px] font-semibold" />
                      <span className="text-[13px] text-muted">Chat opens when the contest starts.</span>
                    </div>
                  ) : (
                    <>
                      <div role="tablist" aria-label="Contest actions" className="flex items-center gap-0.5 px-3 py-2.5 border-b border-border">
                        {(["chat", ...(hasSecret ? (["claim"] as const) : [])] as const).map((t) => (
                          <button
                            key={t}
                            role="tab"
                            aria-selected={tab === t}
                            onClick={() => setTab(t)}
                            className={cx(
                              "px-3 py-1.5 rounded-[7px] text-[13px] font-medium cursor-pointer border-0",
                              tab === t ? "bg-chip text-text" : "bg-transparent text-muted hover:text-text",
                            )}
                          >
                            {t === "chat" ? "Chat" : "Claim a secret"}
                          </button>
                        ))}
                      </div>
                      {tab === "chat" ? <ChatPanel c={c} /> : <ClaimPanel c={c} />}
                    </>
                  )}
                </Card>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function NotFound({ message }: { message?: string }) {
  return (
    <main className="max-w-[720px] mx-auto px-4 py-20 flex flex-col items-center gap-4 text-center">
      <h1 className="m-0 text-2xl font-bold">Contest not found</h1>
      <p className="m-0 text-muted">{message ?? "This contest doesn't exist or couldn't be loaded."}</p>
      <ButtonLink href="/" variant="ghost">
        All contests
      </ButtonLink>
    </main>
  );
}
