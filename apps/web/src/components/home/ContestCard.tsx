"use client";

import Link from "next/link";
import { formatUsdc, shortAddress, type ContestSummary } from "@defect/shared";
import { BoltIcon, ShieldIcon } from "../ui/icons";
import { Countdown, PhaseChip, hoursMinutes, useNow } from "../ui/primitives";

export function ContestCard({ c }: { c: ContestSummary }) {
  const now = useNow(1000);
  const ended = c.phase === "broken" || c.phase === "held" || c.phase === "void" || c.phase === "cancelled";

  return (
    <Link
      href={`/contests/${c.contestId}`}
      className="group flex flex-col gap-3.5 p-5 rounded-none bg-surface border border-border no-underline text-text hover:border-border-strong transition-colors"
    >
      <div className="flex justify-between items-start gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-base font-semibold truncate">{c.card.name}</span>
          <span className="text-[13px] text-muted leading-snug line-clamp-2">{c.card.purpose}</span>
        </div>
        <PhaseChip phase={c.phase} />
      </div>

      {c.phase === "broken" ? (
        <div className="flex items-center gap-2.5 p-3 rounded-none bg-[color-mix(in_srgb,var(--broken)_7%,transparent)] border border-[color-mix(in_srgb,var(--broken)_20%,transparent)]">
          <BoltIcon size={18} className="text-broken-text flex-none" />
          <span className="text-[13px] text-soft">
            Broken by <span className="mono text-text">{c.winner ? shortAddress(c.winner) : "?"}</span> · won <span className="mono text-text">{formatUsdc(c.pool)} USDC</span>
          </span>
        </div>
      ) : c.phase === "held" ? (
        <div className="flex items-center gap-2.5 p-3 rounded-none bg-[color-mix(in_srgb,var(--held)_7%,transparent)] border border-[color-mix(in_srgb,var(--held)_20%,transparent)]">
          <ShieldIcon size={18} className="text-held flex-none" />
          <span className="text-[13px] text-soft">
            Held for {hoursMinutes(c.endTime - c.startTime)} · <span className="mono text-text">{c.messageCount}</span> attacks survived
          </span>
        </div>
      ) : (
        <div className="flex justify-between items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="eyebrow text-[10px]">Prize pool</span>
            <span className="mono text-[32px] leading-none font-semibold tracking-tight">
              {formatUsdc(c.pool)}
              <span className="ml-1.5 text-sm font-medium text-muted tracking-normal">USDC</span>
            </span>
          </div>
          {!ended && (
            <div className="flex flex-col gap-1 items-end">
              <span className="eyebrow text-[10px]">{c.phase === "scheduled" ? "Starts in" : c.phase === "awaiting_close" ? "Final claims" : "Ends in"}</span>
              {c.phase === "awaiting_close" ? (
                <Countdown to={c.endTime + 600} className="text-sm text-warn" />
              ) : (
                <Countdown to={c.phase === "scheduled" ? c.startTime : c.endTime} className="text-sm" />
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-4 pt-3 border-t border-line text-xs text-muted">
        {ended ? (
          <span>
            {c.phase === "broken" && c.brokenRuleText ? `Rule: ${c.brokenRuleText} · ${hoursMinutes(Math.max(0, Math.min(now, c.endTime) - c.startTime))} in` : null}
            {c.phase === "held" && `${formatUsdc(c.pool)} USDC returned to the Warden`}
            {c.phase === "void" && "Cancelled: the agent failed its health checks"}
            {c.phase === "cancelled" && "Cancelled before it started"}
          </span>
        ) : (
          <>
            <span>
              <span className="mono text-text">{c.messagePrice}</span> USDC / msg
            </span>
            <span>
              <span className="mono text-text">{c.ruleCount}</span> {c.ruleCount === 1 ? "rule" : "rules"}
            </span>
            <span>
              <span className="mono text-text">{c.messageCount}</span> messages
            </span>
          </>
        )}
      </div>
    </Link>
  );
}
