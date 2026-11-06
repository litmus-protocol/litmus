"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ENDED_PHASES, formatUsdc, fromBaseUnits, hashscanContract, shortAddress, toBaseUnits, type ContestDetail } from "@defect/shared";
import { useConfig } from "@/lib/hooks";
import { BackIcon } from "../ui/icons";
import { AgentChip } from "./AgentChip";
import { InferenceHost } from "./InferenceHost";
import { Card, CopyText, Countdown, PhaseChip, cx } from "../ui/primitives";

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

  return (
    <div className="flex flex-col gap-4">
      <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:text-text self-start">
        <BackIcon size={14} />
        All validations
      </Link>
      <Card className="p-6 flex flex-col gap-6">
        <div className="flex flex-wrap gap-6 justify-between items-end">
          <div className="flex flex-col gap-2.5 flex-[1_1_420px] min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap text-[13px] text-muted">
              <PhaseChip phase={c.phase} />
              {c.agent && <AgentChip agentId={c.agent.agentId} />}
              {c.phase === "scheduled" && (
                <span>
                  Starts in <Countdown to={c.startTime} className="text-text" />
                </span>
              )}
              {c.phase === "open" && (
                <span>
                  Ends in <Countdown to={c.endTime} className="text-text" />
                </span>
              )}
              {c.phase === "awaiting_close" && (
                <span>
                  Time&apos;s up · final claims close in <Countdown to={c.endTime + 600} className="text-warn" />
                </span>
              )}
            </div>
            <h1 className="m-0 text-[32px] font-bold tracking-tight">{c.card.name}</h1>
            <p className="m-0 text-[15px] text-muted leading-relaxed">{c.card.purpose}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="eyebrow">{c.phase === "broken" ? "Prize pool · paid out" : c.phase === "held" ? "Prize pool · returned" : "Prize pool"}</span>
            <span className={cx("mono leading-none font-semibold tracking-[-0.04em]", compact ? "text-[48px] sm:text-[56px]" : "text-[52px] sm:text-[64px]", ended && "text-muted")}>
              {formatUsdc(c.pool)}
              <span className="text-lg font-medium tracking-normal ml-2 text-muted">USDC</span>
            </span>
            {delta && !ended && <span className="text-xs text-open mono">+{delta} from the last message</span>}
          </div>
        </div>

        <div className={cx("grid grid-cols-2 gap-4 pt-5 border-t border-line", compact ? "xl:grid-cols-4" : "md:grid-cols-4")}>
          {[
            ["Agent's wallet", `${formatUsdc(c.vault)} USDC`],
            ["Warden's bond", `${formatUsdc(c.bond)} USDC`],
            ["Price per message", `${c.messagePrice} USDC`],
            ["Messages sent", c.messageCount.toLocaleString()],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="eyebrow">{label}</span>
              <span className="mono text-lg font-semibold">{value}</span>
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
      </Card>
    </div>
  );
}
