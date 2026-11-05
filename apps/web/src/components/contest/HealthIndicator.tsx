"use client";

import type { ContestDetail } from "@defect/shared";
import { CheckIcon, WarnIcon } from "../ui/icons";
import { useConfig } from "@/lib/hooks";
import { Callout, relativeTime, useNow } from "../ui/primitives";

export function HealthIndicator({ c }: { c: ContestDetail }) {
  const now = useNow(30_000);
  const interval = useConfig().data?.canaryIntervalSec ?? 900;
  const every = interval % 60 === 0 ? `${interval / 60} minutes` : `${interval} seconds`;
  const { lastRoundAt, lastRoundPassed, consecutiveFailed } = c.canary;

  if (lastRoundPassed === false) {
    return (
      <Callout tone="warn" icon={<WarnIcon size={16} />}>
        <b>Agent failed its last health check.</b> Fees paid since the last passing check will be refunded from the Warden&apos;s bond.
        {consecutiveFailed > 0 && ` ${consecutiveFailed} of 3 failed checks in a row; at 3 the contest is cancelled.`}
      </Callout>
    );
  }
  return (
    <div className="flex items-start gap-2.5 px-4 py-3 rounded-[10px] border border-border bg-surface text-[13px]">
      <span className="text-open mt-0.5">
        <CheckIcon size={14} />
      </span>
      <span className="text-muted leading-relaxed">
        <span className="text-text">Health checks: {lastRoundAt ? "passing" : "first check soon"}</span>
        {lastRoundAt && <> · last check {relativeTime(lastRoundAt, now)}</>}
        <br />
        Every {every} we test that the agent still does its normal job.
      </span>
    </div>
  );
}
