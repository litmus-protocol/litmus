"use client";

import Link from "next/link";
import { useState } from "react";
import { keccak256, toBytes } from "viem";
import { formatUsdc, shortAddress, type ContestDetail } from "@defect/shared";
import { api, friendlyError, sessionsFromAttempts } from "@/lib/api";
import { useAttempts, useAttestation, useCanaryRounds } from "@/lib/hooks";
import { ChainIcon, CheckIcon, ChevronIcon, DownloadIcon, ShieldIcon, WarnIcon, XIcon } from "../ui/icons";
import { Button, Card, CardHeader, Chip, cx, hoursMinutes } from "../ui/primitives";
import { Exchange } from "./messages";
import { RuleList } from "./RuleList";

/** How long the contest ran before it ended. */
function hoursMinutesSafe(c: ContestDetail): string {
  const end = Math.min(c.endedAt ?? Math.floor(Date.now() / 1000), c.endTime);
  return hoursMinutes(Math.max(0, end - c.startTime));
}

function OutcomeCard({ c }: { c: ContestDetail }) {
  const duration = hoursMinutesSafe(c);
  if (c.phase === "broken") {
    const rule = c.brokenInvariant != null ? c.invariants[c.brokenInvariant] : null;
    return (
      <section className="rounded-[14px] border border-[color-mix(in_srgb,var(--broken)_40%,transparent)] bg-[color-mix(in_srgb,var(--broken)_6%,var(--surface))] p-7 flex flex-wrap gap-x-10 gap-y-6 items-center">
        <span className="mono text-[44px] font-bold tracking-[-0.03em] text-broken-text">BROKEN</span>
        <div className="flex-[1_1_360px] min-w-0 flex flex-col gap-2">
          <div className="flex gap-2.5 items-center flex-wrap text-[13px] text-muted">
            <Chip tone="broken">Broken</Chip>
            {c.card.name} · after {duration} of {hoursMinutes(c.endTime - c.startTime)}
          </div>
          <span className="text-[26px] font-bold tracking-tight">
            <span className="mono">{c.winner ? shortAddress(c.winner, 6, 2) : "?"}</span> won <span className="mono">{formatUsdc(c.pool)} USDC</span>
          </span>
          {rule && <span className="text-sm text-broken-text">Rule broken: {rule.text} · paid in the same transaction</span>}
        </div>
        <div className="flex gap-8 flex-wrap">
          <Big label="Messages" value={c.messageCount.toLocaleString()} />
          <Big label="Breakers" value={c.stats.breakers.toLocaleString()} />
        </div>
      </section>
    );
  }
  if (c.phase === "held") {
    return (
      <section className="rounded-[14px] border border-[color-mix(in_srgb,var(--held)_35%,transparent)] bg-[color-mix(in_srgb,var(--held)_6%,var(--surface))] p-7 flex flex-wrap gap-x-10 gap-y-6 items-center">
        <span className="flex-none w-[72px] h-[72px] rounded-[18px] grid place-items-center bg-[color-mix(in_srgb,var(--held)_14%,transparent)] text-held">
          <ShieldIcon size={36} />
        </span>
        <div className="flex-[1_1_360px] min-w-0 flex flex-col gap-2">
          <div className="flex gap-2.5 items-center flex-wrap text-[13px] text-muted">
            <Chip tone="held">Held</Chip>
            {c.card.name}
          </div>
          <span className="text-[30px] font-bold tracking-tight">
            Survived {hoursMinutes(c.endTime - c.startTime)} · <span className="mono">{c.messageCount.toLocaleString()}</span> attacks
          </span>
          <span className="text-sm text-held">
            <span className="mono">{formatUsdc(c.pool)} USDC</span> pool returned to the Warden · public &quot;survived&quot; record written on chain
          </span>
        </div>
        <div className="flex gap-8 flex-wrap">
          <Big label="Breakers" value={c.stats.breakers.toLocaleString()} />
          <Big label="Health checks" value={`${c.canary.rounds}/${c.canary.rounds}`} />
        </div>
      </section>
    );
  }
  return (
    <section className="rounded-[14px] border border-border-strong bg-surface p-7 flex flex-col gap-2.5">
      <Chip>{c.phase === "void" ? "Void" : "Cancelled"}</Chip>
      <span className="text-[24px] font-bold tracking-tight">
        {c.phase === "void" ? "Cancelled: the agent failed 3 health checks in a row" : "Cancelled before it started"}
      </span>
      <span className="text-muted leading-relaxed">
        {c.phase === "void"
          ? "Breakers were refunded the fees they paid since the last passing check, from the Warden's bond. No “survived” record. The pool returned to the Warden."
          : "The arena couldn't load this agent, so the contest never opened. Nobody was charged and all deposits returned to the Warden."}
      </span>
    </section>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className="mono text-[22px] font-semibold">{value}</span>
    </div>
  );
}

function RevealedPrompt({ c }: { c: ContestDetail }) {
  if (!c.revealed) return null;
  const { systemPrompt } = c.revealed.package;
  const parts = systemPrompt.split(/(\{\{SECRET:inv-\d+\}\})/g);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Revealed instructions" aside="Hidden during the contest" />
      <pre className="mono m-0 p-5 text-[12.5px] leading-[1.75] text-soft whitespace-pre-wrap break-words bg-sunken">
        {parts.map((p, i) => {
          const m = /^\{\{SECRET:(inv-\d+)\}\}$/.exec(p);
          if (!m) return <span key={i}>{p}</span>;
          return (
            <mark key={i} className="bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-accent px-1.5 rounded outline outline-1 outline-[color-mix(in_srgb,var(--accent)_45%,transparent)] break-all">
              {c.revealed!.secrets[m[1]!] ?? p}
            </mark>
          );
        })}
      </pre>
    </Card>
  );
}

function WinningChat({ c }: { c: ContestDetail }) {
  const attempts = useAttempts(c.contestId, true);
  if (c.phase !== "broken" || !c.winner) return null;
  const mine = (attempts.data ?? []).filter((a) => a.breaker.toLowerCase() === c.winner!.toLowerCase());
  const last = mine.slice(-2);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Winning chat"
        aside={
          <Link href={`/contests/${c.contestId}/transcripts/${c.winner}`} className="text-muted hover:text-accent no-underline">
            Open full transcript →
          </Link>
        }
      />
      <div className="p-5 flex flex-col gap-4 bg-sunken">
        {last.length ? last.map((a) => <Exchange key={a.attemptId} a={a} price={c.messagePrice} />) : <span className="text-muted text-[13px]">Loading…</span>}
      </div>
    </Card>
  );
}

function MoneyBreakdown({ c }: { c: ContestDetail }) {
  if (c.phase !== "broken") return null;
  return (
    <Card className="p-5 flex flex-col">
      <h2 className="m-0 mb-2 text-[15px] font-semibold">Where the money went</h2>
      {[
        [`Prize pool → ${c.winner ? shortAddress(c.winner, 6, 2) : "winner"}`, c.pool],
        ["Bond → Warden", c.bond],
        ["Warden's 10% of fees → Warden", c.escrow],
      ].map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-2.5 border-b border-line last:border-b-0 text-sm">
          <span className="text-muted">{label}</span>
          <span className="mono">{formatUsdc(value!)}</span>
        </div>
      ))}
    </Card>
  );
}

function Proof({ c }: { c: ContestDetail }) {
  const [state, setState] = useState<"idle" | "checking" | "match" | "mismatch" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const attestation = useAttestation(c.contestId, c.phase === "broken" || c.phase === "held");

  async function verify() {
    setState("checking");
    try {
      const { text } = await api.getLog(c.contestId);
      const local = keccak256(toBytes(text));
      setState(c.revealed?.logHash && local === c.revealed.logHash ? "match" : "mismatch");
    } catch (e) {
      setErr(friendlyError(e));
      setState("error");
    }
  }

  async function download() {
    try {
      const { text } = await api.getLog(c.contestId);
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `defect-contest-${c.contestId}-log.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  const a = attestation.data;
  return (
    <Card className="p-5 flex flex-col gap-3.5">
      <h2 className="m-0 text-[15px] font-semibold">Proof</h2>
      <div className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-[10px] bg-sunken border border-border">
        <span
          className={cx(
            "inline-flex items-center gap-2 text-[13px]",
            state === "match" && "text-open",
            (state === "mismatch" || state === "error") && "text-broken-text",
            (state === "idle" || state === "checking") && "text-muted",
          )}
        >
          {state === "match" ? <CheckIcon size={16} /> : state === "mismatch" || state === "error" ? <XIcon size={16} /> : null}
          {state === "idle" && "Check the published log against the fingerprint on chain"}
          {state === "checking" && "Checking…"}
          {state === "match" && "Log matches the fingerprint on chain"}
          {state === "mismatch" && "Log does NOT match the fingerprint on chain"}
          {state === "error" && (err ?? "Couldn't check the log")}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" className="min-h-[34px] text-[13px]" onClick={() => void verify()} disabled={state === "checking"}>
            {state === "idle" ? "Verify log" : "Verify again"}
          </Button>
          <Button variant="ghost" className="min-h-[34px] text-[13px]" onClick={() => void download()} aria-label="Download log">
            <DownloadIcon size={14} />
          </Button>
        </div>
      </div>
      {(c.phase === "broken" || c.phase === "held") && (
        <div className="flex flex-col gap-2.5 p-3.5 rounded-[10px] border border-[color-mix(in_srgb,var(--held)_30%,transparent)] bg-[color-mix(in_srgb,var(--held)_6%,transparent)]">
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <ChainIcon size={18} className="text-held" />
            {a ? "Independently audited by Chainlink" : attestation.isLoading ? "Checking Chainlink audit…" : "Chainlink audit pending"}
          </span>
          {a && (
            <div className="flex gap-2 flex-wrap">
              <Chip tone={a.logHashMatches ? "pass" : "broken"}>{a.logHashMatches ? "✓" : "✗"} log</Chip>
              <Chip tone={a.canaryHashMatches ? "pass" : "broken"}>{a.canaryHashMatches ? "✓" : "✗"} tests</Chip>
              <Chip tone={a.secretsMatch ? "pass" : "broken"}>{a.secretsMatch ? "✓" : "✗"} secrets</Chip>
            </div>
          )}
          <span className="text-xs text-faint">Chainlink re-checks the published log, tests and secrets against the fingerprints locked on Hedera, then records the result on Ethereum Sepolia.</span>
        </div>
      )}
    </Card>
  );
}

function HealthTable({ c }: { c: ContestDetail }) {
  const rounds = useCanaryRounds(c.contestId);
  const tasks = c.revealed?.canaries ?? [];
  const list = rounds.data ?? [];
  const passed = list.filter((r) => r.passed).length;
  if (!tasks.length) return null;
  const cols = list.slice(-4);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Health checks" aside={<Chip tone={passed === list.length ? "pass" : "warn"}>{`${passed} of ${list.length} rounds passed`}</Chip>} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse min-w-[520px] text-[13px]">
          <thead>
            <tr>
              <th className="text-left px-4 py-2.5 eyebrow font-semibold border-b border-border">Request</th>
              <th className="text-left px-4 py-2.5 eyebrow font-semibold border-b border-border">Expected</th>
              {cols.map((r) => (
                <th key={r.round} className="text-left px-4 py-2.5 eyebrow font-semibold border-b border-border">
                  R{r.round}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-2.5 border-b border-line break-all">{t.prompt}</td>
                <td className="px-4 py-2.5 border-b border-line mono text-xs text-muted">{t.expectTool ? `uses ${t.expectTool}` : `contains "${t.mustContain?.join('", "')}"`}</td>
                {cols.map((r) => {
                  const ok = r.results?.find((x) => x.taskId === t.id)?.passed ?? r.passed;
                  return (
                    <td key={r.round} className={cx("px-4 py-2.5 border-b border-line", ok ? "text-open" : "text-broken-text")}>
                      {ok ? "✓" : "✗"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Transcripts({ c }: { c: ContestDetail }) {
  const attempts = useAttempts(c.contestId, true);
  const sessions = sessionsFromAttempts(attempts.data ?? [], c.winner, c.messagePrice);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Transcripts" aside={`${sessions.length} Breakers with published chats`} />
      {attempts.isError && <p className="m-0 px-4 py-3 text-muted text-[13px]">{friendlyError(attempts.error)}</p>}
      {sessions.length === 0 && !attempts.isLoading && <p className="m-0 px-4 py-3 text-muted text-[13px]">No messages were sent in this contest.</p>}
      {sessions.slice(0, 12).map((s) => (
        <Link
          key={s.breaker}
          href={`/contests/${c.contestId}/transcripts/${s.breaker}`}
          className={cx("flex items-center gap-3 px-4 py-3 border-t border-line no-underline text-text hover:bg-raised", s.isWinner && "bg-[color-mix(in_srgb,var(--broken)_6%,transparent)]")}
        >
          {s.isWinner && <Chip tone="broken">Winner</Chip>}
          <span className="mono text-[13px] flex-1">{shortAddress(s.breaker, 6, 4)}</span>
          <span className="text-xs text-muted">{s.messages} messages</span>
          <span className="mono text-xs text-muted">{formatUsdc(s.paid)} USDC</span>
          <ChevronIcon size={14} className="text-faint" />
        </Link>
      ))}
    </Card>
  );
}

export function ResultsView({ c, hideOutcome = false }: { c: ContestDetail; hideOutcome?: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      {!hideOutcome && <OutcomeCard c={c} />}
      {c.phase === "void" && (
        <div className="flex">
          <span className="inline-flex items-center gap-2 text-[13px] text-warn">
            <WarnIcon size={14} /> If you chatted with this agent, your refund was sent automatically.
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-5 items-start">
        <div className="flex-[1.3_1_560px] min-w-0 flex flex-col gap-5">
          <WinningChat c={c} />
          <RevealedPrompt c={c} />
          <HealthTable c={c} />
        </div>
        <div className="flex-[1_1_380px] min-w-0 flex flex-col gap-5">
          <RuleList invariants={c.invariants} brokenIndex={c.brokenInvariant} subtitle={c.phase === "broken" ? "One rule was broken" : "Final"} />
          <MoneyBreakdown c={c} />
          <Proof c={c} />
          <Transcripts c={c} />
        </div>
      </div>
    </div>
  );
}
