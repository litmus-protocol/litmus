"use client";

import Link from "next/link";
import { usePathParams } from "@/lib/route-params";
import { ENDED_PHASES, formatUsdc, fromBaseUnits, shortAddress, toBaseUnits } from "@defect/shared";
import { LoadingMark } from "@/components/brand/LitmusMark";
import { Exchange } from "@/components/contest/messages";
import { BackIcon } from "@/components/ui/icons";
import { Card, Chip } from "@/components/ui/primitives";
import { friendlyError, isTransientError } from "@/lib/api";
import { attemptsFinal, useAttempts, useContest } from "@/lib/hooks";

export default function TranscriptPage() {
  const params = usePathParams();
  const id = Number(params.contestId);
  const address = decodeURIComponent(params.address).toLowerCase();
  const contest = useContest(id);
  const c = contest.data;
  // Transcripts are published when the contest ends; a page opened earlier picks them up once the polled contest ends.
  const ended = !!c && ENDED_PHASES.includes(c.phase);
  const attempts = useAttempts(id, ended, !c || attemptsFinal(c));

  const mine = (attempts.data ?? []).filter((a) => a.breaker.toLowerCase() === address);
  const isWinner = !!c?.winner && c.winner.toLowerCase() === address;
  const paid = c ? fromBaseUnits(BigInt(mine.filter((a) => a.charged).length) * toBaseUnits(c.messagePrice)) : "0";

  return (
    <main className="max-w-[960px] mx-auto px-4 sm:px-6 pt-6 pb-16 flex flex-col gap-5">
      <Link href={`/contests/${id}`} className="inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:text-text self-start">
        <BackIcon size={14} />
        {c ? `${c.card.name} results` : "Back"}
      </Link>

      <Card className="px-6 py-5 flex flex-wrap gap-x-8 gap-y-4 items-center">
        <div className="flex flex-col gap-1.5 flex-[1_1_260px]">
          <span className="eyebrow">Transcript</span>
          <span className="mono text-xl font-semibold">{shortAddress(address, 8, 6)}</span>
        </div>
        {isWinner && <Chip tone="broken">Winner</Chip>}
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">Messages</span>
          <span className="mono text-lg">{mine.length}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">Paid</span>
          <span className="mono text-lg">{formatUsdc(paid)} USDC</span>
        </div>
        {isWinner && c && (
          <div className="flex flex-col gap-0.5">
            <span className="eyebrow">Won</span>
            <span className="mono text-lg text-accent">{formatUsdc(c.pool)} USDC</span>
          </div>
        )}
      </Card>

      <p className="m-0 text-xs text-faint">Every message is signed by Litmus and included in the published log.</p>

      <Card className="overflow-hidden">
        <div className="p-5 flex flex-col gap-4 bg-sunken">
          {c && !ended ? (
            <span className="text-muted">Transcripts are published when the validation ends.</span>
          ) : !c && contest.isError && !isTransientError(contest.error) ? (
            <span className="text-muted">{friendlyError(contest.error)}</span>
          ) : !attempts.data && !(attempts.isError && !isTransientError(attempts.error)) ? (
            <LoadingMark label={attempts.isError || (!c && contest.isError) ? "Can't reach Litmus right now. Retrying" : "Loading messages"} className="py-8" />
          ) : !attempts.data ? (
            <span className="text-muted">{friendlyError(attempts.error)}</span>
          ) : mine.length === 0 ? (
            <span className="text-muted">No messages from this address.</span>
          ) : (
            mine.map((a) => <Exchange key={a.attemptId} a={a} price={c?.messagePrice ?? "0"} />)
          )}
        </div>
      </Card>
    </main>
  );
}
