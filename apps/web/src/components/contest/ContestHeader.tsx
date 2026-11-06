"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ENDED_PHASES, formatUsdc, fromBaseUnits, hashscanContract, shortAddress, toBaseUnits, type ContestDetail } from "@defect/shared";
import { useConfig } from "@/lib/hooks";
import { BackIcon } from "../ui/icons";
import { AgentChip } from "./AgentChip";
import { InferenceHost } from "./InferenceHost";
import { CopyText, Countdown, PhaseChip, cx } from "../ui/primitives";

function usePoolDelta(pool: string) {
  const prev = useRef(pool);
  const [delta, setDelta] = useState<string | null>(null);
  useEffect(() => {
    if (prev.current !== pool) {
      const d = toBaseUnits(pool) - toBaseUnits(prev.current);
      if (d > 0n) setDelta(fromBaseUnits(d));
      prev.current = pool;
    }
  }, [pool]);
  return delta;
}

/** `compact` is for the half-width column of the live contest page: stats and proof details stay at two columns. */
export function ContestHeader({ c, compact = false }: { c: ContestDetail; compact?: boolean }) {
  const ended = ENDED_PHASES.includes(c.phase);
  const delta = usePoolDelta(c.pool);
  const cfg = useConfig();

  const stats: [string, string][] = [
    ["Agent's wallet", `${formatUsdc(c.vault)} USDC`],
    ["Warden's bond", `${formatUsdc(c.bond)} USDC`],
    ["Price per message", `${c.messagePrice} USDC`],
    ["Messages sent", c.messageCount.toLocaleString()],
  ];

  return (
    <header className="flex flex-col gap-6">
      <Link href="/" className="inline-flex items-center gap-1.5 self-start text-[13px] text-text/60 no-underline hover:text-text">
        <BackIcon size={14} />
        All validations
      </Link>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4 text-[13px]">
        <span className="text-[13px] font-semibold tabular-nums text-text/50">#{c.contestId}</span>
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">Validation</span>
        <PhaseChip phase={c.phase} />
        {c.agent && <AgentChip agentId={c.agent.agentId} />}
        {c.phase === "scheduled" && (
          <span className="text-text/70">
            Opens in <Countdown to={c.startTime} className="text-text" />
          </span>
        )}
        {c.phase === "open" && (
          <span className="text-text/70">
            Closes in <Countdown to={c.endTime} className="text-text" />
          </span>
        )}
        {c.phase === "awaiting_close" && (
          <span className="text-text/70">
            Time is up · final claims close in <Countdown to={c.endTime + 600} className="text-warn" />
          </span>
        )}
      </div>

      <div className={cx("grid items-end gap-6", !compact && "lg:grid-cols-12")}>
        <div className={cx("min-w-0", !compact && "lg:col-span-8")}>
          <h1
            className={cx(
              "m-0 font-bold leading-[0.98] tracking-[-0.035em]",
              compact ? "text-[clamp(2rem,3vw,3rem)]" : "text-[clamp(2.25rem,4.4vw,4.25rem)]",
            )}
          >
            {c.card.name}
          </h1>
          <p className="m-0 mt-4 max-w-2xl text-[clamp(1rem,1.15vw,1.2rem)] leading-[1.55] text-text/75">{c.card.purpose}</p>
        </div>
        <div className={cx("flex flex-col gap-1.5", !compact && "lg:col-span-4 lg:items-end")}>
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text/60">
            {c.phase === "broken" ? "Prize pool · paid out" : c.phase === "held" ? "Prize pool · returned" : "Prize pool"}
          </span>
          <span className={cx("mono font-semibold leading-none tracking-[-0.04em]", compact ? "text-[44px] sm:text-[52px]" : "text-[52px] sm:text-[64px]", ended && "text-text/55")}>
            {formatUsdc(c.pool)}
            <span className="ml-2 font-sans text-lg font-medium tracking-normal text-text/55">USDC</span>
          </span>
          {delta && !ended && <span className="mono text-xs text-open">+{delta} from the last message</span>}
        </div>
      </div>

      <div className={cx("grid grid-cols-2 gap-px border border-line bg-line", compact ? "xl:grid-cols-4" : "md:grid-cols-4")}>
        {stats.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-2 bg-bg p-4 sm:p-5">
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text/60">{label}</span>
            <span className="mono text-xl font-semibold">{value}</span>
          </div>
        ))}
      </div>

        <details className="group text-xs text-muted">
          <summary className="cursor-pointer select-none list-none inline-flex items-center gap-1.5 hover:text-text">
            <span className="group-open:rotate-90 transition-transform">▸</span> Proof details
          </summary>
          <div className={cx("mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3", !compact && "lg:grid-cols-4")}>
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-[10px]">Model</span>
              <span className="mono text-text">{c.model}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-[10px]">0G provider</span>
              <InferenceHost model={c.model} providerAddress={c.providerAddress} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-[10px]">Contract</span>
              {cfg.data ? (
                <a href={hashscanContract(cfg.data.arena)} target="_blank" rel="noreferrer" className="mono text-soft hover:text-accent no-underline">
                  {shortAddress(cfg.data.arena, 6, 4)} ↗
                </a>
              ) : (
                <span>…</span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-[10px]">Package fingerprint</span>
              <CopyText text={c.packageHash} display={shortAddress(c.packageHash, 6, 4)} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-[10px]">Canary fingerprint</span>
              <CopyText text={c.canaryHash} display={shortAddress(c.canaryHash, 6, 4)} />
            </div>
          </div>
        </details>
    </header>
  );
}
