"use client";

import { usePathParams } from "@/lib/route-params";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ENDED_PHASES, REVEAL_GRACE_SECONDS } from "@defect/shared";
import { LoadingMark } from "@/components/brand/LitmusMark";
import { BotPanel, BotRunCard } from "@/components/contest/BotPanel";
import { BrokenBanner } from "@/components/contest/BrokenBanner";
import { ChatPanel } from "@/components/contest/ChatPanel";
import { ClaimPanel } from "@/components/contest/ClaimPanel";
import { ClosingPanel } from "@/components/contest/ClosingPanel";
import { ContestHeader } from "@/components/contest/ContestHeader";
import { HealthIndicator } from "@/components/contest/HealthIndicator";
import { ResultsView } from "@/components/contest/ResultsView";
import { RuleList } from "@/components/contest/RuleList";
import { ButtonLink, Card, Countdown, cx } from "@/components/ui/primitives";
import { friendlyError } from "@/lib/api";
import { useConfig, useContest } from "@/lib/hooks";

export default function ContestPage() {
  const id = Number(usePathParams().contestId);
  const contest = useContest(id);
  const cfg = useConfig();
  const [tab, setTab] = useState<"chat" | "claim" | "bot">("chat");
  const [fillRef, fillHeight] = useFillHeight();

  if (!Number.isInteger(id) || id < 1) return <NotFound />;
  if (contest.isLoading) {
    return (
      <main className="max-w-[1320px] mx-auto px-4 sm:px-6 py-6">
        <LoadingMark label="Loading validation" />
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

  if (ended) {
    return (
      <>
        {freshBreak && <BrokenBanner c={c} />}
        <main className="max-w-[1320px] mx-auto px-4 sm:px-6 pt-6 pb-16 flex flex-col gap-5">
          <ContestHeader c={c} />
          <ResultsView c={c} hideOutcome={freshBreak} />
          <BotRunCard contestId={c.contestId} />
        </main>
      </>
    );
  }

  // Live contest: on wide screens the chat fills the left half from the header down to the bottom of the
  // screen (input pinned at the bottom), and the contest info scrolls independently on the right.
  return (
    <main
      ref={fillRef}
      style={{ "--fill-h": `${fillHeight}px` } as CSSProperties}
      className="max-w-[1600px] mx-auto px-4 sm:px-6 py-4 lg:py-0 grid gap-5 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)] lg:h-[var(--fill-h)] lg:overflow-hidden"
    >
      <section aria-label="Chat with the agent" className="order-2 lg:order-1 min-h-0 h-[80dvh] lg:h-auto lg:py-4 flex flex-col">
        <Card className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {c.phase === "scheduled" ? (
            <div className="flex-1 p-10 flex flex-col items-center gap-2 text-center justify-center">
              <span className="eyebrow">Upcoming</span>
              <Countdown to={c.startTime} className="text-[44px] font-semibold" />
              <span className="text-[13px] text-muted">Chat opens when the validation starts.</span>
            </div>
          ) : c.phase === "awaiting_close" ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <ClosingPanel c={c} revealGraceSeconds={cfg.data?.revealGraceSeconds ?? REVEAL_GRACE_SECONDS} />
            </div>
          ) : (
            <>
              <div role="tablist" aria-label="Validation actions" className="flex items-center gap-0.5 px-3 py-2.5 border-b border-border">
                {(["chat", ...(hasSecret ? (["claim"] as const) : []), "bot"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={cx(
                      "px-3 py-1.5 rounded-none text-[13px] font-medium cursor-pointer border-0",
                      tab === t ? "bg-chip text-text" : "bg-transparent text-muted hover:text-text",
                    )}
                  >
                    {t === "chat" ? "Chat" : t === "claim" ? "Claim a secret" : "Breaker bot"}
                  </button>
                ))}
              </div>
              {tab === "chat" ? (
                <ChatPanel c={c} />
              ) : tab === "bot" ? (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <BotPanel c={c} />
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <ClaimPanel c={c} />
                </div>
              )}
            </>
          )}
        </Card>
      </section>

      {/* On phones this section dissolves (`contents`) so the order reads: contest info, chat, rules. */}
      <section aria-label="Validation details" className="contents lg:flex lg:order-2 lg:min-h-0 lg:overflow-y-auto lg:py-4 lg:pr-1 lg:flex-col lg:gap-5">
        <div className="order-1">
          <ContestHeader c={c} compact />
        </div>
        <div className="order-3 flex flex-col gap-5">
          <RuleList invariants={c.invariants} brokenIndex={null} />
          {c.phase === "open" && <HealthIndicator c={c} />}
        </div>
      </section>
    </main>
  );
}

/** Height from the element's top edge to the bottom of the viewport, kept current on resize. */
function useFillHeight() {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(window.innerHeight - top, 480));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });
  return [ref, height] as const;
}

function NotFound({ message }: { message?: string }) {
  return (
    <main className="max-w-[720px] mx-auto px-4 py-20 flex flex-col items-center gap-4 text-center">
      <h1 className="m-0 text-2xl font-bold">Validation not found</h1>
      <p className="m-0 text-muted">{message ?? "This validation doesn't exist or couldn't be loaded."}</p>
      <ButtonLink href="/" variant="ghost">
        All validations
      </ButtonLink>
    </main>
  );
}
