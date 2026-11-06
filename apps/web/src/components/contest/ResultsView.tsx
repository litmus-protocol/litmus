"use client";

import Link from "next/link";
import { useState } from "react";
import { keccak256, toBytes } from "viem";
import { formatUsdc, hashscanContract, hashscanTx, shortAddress, type ContestDetail } from "@defect/shared";
import { api, friendlyError, sessionsFromAttempts } from "@/lib/api";
import { attemptsFinal, useAttempts, useAttestation, useCanaryRounds, useCertificate } from "@/lib/hooks";
import { ChainIcon, CheckIcon, ChevronIcon, DownloadIcon, WarnIcon, XIcon } from "../ui/icons";
import { Button, Card, CardHeader, Chip, cx, hoursMinutes } from "../ui/primitives";
import { AgentFeedbackLine } from "./AgentFeedbackLine";
import { HeldCertificate } from "./HeldCertificate";
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
      <section className="grid gap-8 bg-text p-8 text-bg sm:p-10 lg:grid-cols-12 lg:items-end">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-bg/60">
            Verdict · after {duration} of {hoursMinutes(c.endTime - c.startTime)}
          </span>
          <span className="text-[clamp(3rem,7vw,5.5rem)] font-bold leading-[0.9] tracking-[-0.04em]">Broken</span>
          {rule && <p className="m-0 max-w-[52ch] text-[clamp(1.1rem,1.4vw,1.35rem)] leading-snug text-bg/85">“{rule.text}”</p>}
          <span className="text-[15px] text-bg/70">
            <span className="mono text-bg">{c.winner ? shortAddress(c.winner, 6, 2) : "?"}</span> was awarded{" "}
            <span className="mono text-bg">{formatUsdc(c.pool)} USDC</span>, paid by the contract in the same transaction as the break.
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-bg/20 border border-bg/20 lg:col-span-4">
          <Big label="Messages" value={c.messageCount.toLocaleString()} />
          <Big label="Breakers" value={c.stats.breakers.toLocaleString()} />
        </div>
      </section>
    );
  }
  if (c.phase === "held") {
    return (
      <section className="grid gap-8 bg-accent p-8 text-on-accent sm:p-10 lg:grid-cols-12 lg:items-end">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-on-accent/70">Verdict · after {hoursMinutes(c.endTime - c.startTime)}</span>
          <span className="text-[clamp(3rem,7vw,5.5rem)] font-bold leading-[0.9] tracking-[-0.04em]">Held</span>
          <p className="m-0 max-w-[52ch] text-[clamp(1.1rem,1.4vw,1.35rem)] leading-snug text-on-accent/90">
            Every guarantee survived <span className="mono">{c.messageCount.toLocaleString()}</span> attempts.
          </p>
          <span className="text-[15px] text-on-accent/75">
            The <span className="mono text-on-accent">{formatUsdc(c.pool)} USDC</span> pool returned to the Warden, and the result was recorded on chain.
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-on-accent/30 border border-on-accent/30 lg:col-span-4">
          <Big label="Breakers" value={c.stats.breakers.toLocaleString()} />
          <Big label="Health checks" value={`${c.canary.rounds}/${c.canary.rounds}`} />
        </div>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-3 border border-border-strong bg-surface p-8">
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text/60">Verdict · {c.phase === "void" ? "Void" : "Cancelled"}</span>
      <span className="text-[clamp(1.5rem,2.4vw,2rem)] font-bold leading-tight tracking-[-0.02em]">
        {c.phase === "void" ? "Cancelled after the agent failed three health checks in a row." : "Cancelled before the validation opened."}
      </span>
      <span className="max-w-[70ch] leading-relaxed text-text/75">
        {c.phase === "void"
          ? "Breakers were refunded the fees paid since the last passing check, from the Warden's bond. No “survived” record was written, and the pool returned to the Warden."
          : "Litmus could not load the agent, so the validation never opened. No one was charged, and all deposits returned to the Warden."}
      </span>
    </section>
  );
}

/** The soulbound Held certificate NFT (§8.9), rendered from the SVG the contract generates on chain. */
function CertificateCard({ c }: { c: ContestDetail }) {
  const withheld = c.certificate?.status === "withheld";
  const cert = useCertificate(c.contestId, c.certificate !== null && !withheld);
  const attempts = useAttempts(c.contestId, c.certificate !== null && !withheld, attemptsFinal(c));
  if (!c.certificate) return null;
  if (withheld) {
    return (
      <Card className="overflow-hidden">
        <CardHeader title="Held certificate" aside={<span className="text-xs text-faint">Not issued</span>} />
        <div className="p-5 flex items-start gap-2.5 text-[13px] text-muted leading-relaxed">
          <WarnIcon size={16} className="text-broken-text shrink-0 mt-0.5" />
          <span>
            No certificate was minted. The agent held, but Chainlink&apos;s independent audit of this contest did not pass (see Proof),
            so the result can&apos;t be certified.
          </span>
        </div>
      </Card>
    );
  }
  const meta = cert.data;
  const contractUrl = hashscanContract(c.certificate.address);
  const attr = (name: string) => meta?.attributes.find((a) => a.trait_type === name)?.value;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Held certificate" aside={<span className="text-xs text-faint">Soulbound NFT · minted to the Warden</span>} />
      <div className="p-5 flex flex-wrap gap-6 items-center">
        {meta ? (
          // The site's own rendering of the certificate's data (the NFT's on-chain image is made by the contract).
          <HeldCertificate
            contestId={c.contestId}
            agentName={c.card.name}
            agentId={c.agent?.agentId ?? c.card.agentId ?? null}
            model={c.model}
            attacks={Number(attr("Messages survived") ?? c.messageCount)}
            timeTested={String(attr("Time tested") ?? "").replace(/ minutes?/, " min").replace(/ hours?/, " h")}
            attack={attempts.data?.find((a) => a.charged)?.text ?? attempts.data?.[0]?.text ?? null}
          />
        ) : (
          <div className="w-full max-w-[420px] aspect-[600/380] rounded-none border border-dashed border-border-strong grid place-items-center text-[13px] text-muted text-center p-6">
            {cert.isError ? "Couldn't read the certificate from the chain." : "Being issued. The gateway mints it once Chainlink's independent audit of this contest passes."}
          </div>
        )}
        <div className="flex-[1_1_220px] min-w-0 flex flex-col gap-3 text-[13px]">
          <span className="text-muted leading-relaxed">
            Proof this exact agent version held its rules. The numbers are read from the arena contract; it can&apos;t be
            transferred or sold.
          </span>
          {meta && (
            <div className="grid grid-cols-2 gap-3">
              {(["Time tested", "Messages survived", "Pool at stake (USDC)", "Unique Breakers (reported)"] as const).map((k) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <span className="eyebrow text-[10px]">{k}</span>
                  <span className="mono text-text">{String(attr(k) ?? "-")}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <a href={contractUrl} target="_blank" rel="noreferrer" className="text-soft hover:text-accent no-underline">
              Certificate contract ↗
            </a>
            {c.certificate.txHash && (
              <a href={hashscanTx(c.certificate.txHash)} target="_blank" rel="noreferrer" className="text-soft hover:text-accent no-underline">
                Mint transaction ↗
              </a>
            )}
            <span className="text-faint">Token #{c.certificate.tokenId}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  // Sits on the dark or purple verdict band: colours come from the band (currentColor), not the page tokens.
  return (
    <div className="flex flex-col gap-2 p-4">
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] opacity-60">{label}</span>
      <span className="mono text-[clamp(1.5rem,2.2vw,2rem)] font-semibold leading-none">{value}</span>
    </div>
  );
}

function RevealedPrompt({ c }: { c: ContestDetail }) {
  if (!c.revealed) return null;
  const { systemPrompt } = c.revealed.package;
  const parts = systemPrompt.split(/(\{\{SECRET:inv-\d+\}\})/g);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Revealed instructions" aside="Hidden during the validation" />
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
  const attempts = useAttempts(c.contestId, true, attemptsFinal(c));
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
      <h2 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-[0.08em]">Where the money went</h2>
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
    setErr(null);
    try {
      // Compare with fresh contest data: the copy this page loaded can predate finalization, when no log hash is
      // published yet. A missing hash means "not published yet", never "does not match".
      const expected = (await api.getContest(c.contestId)).revealed?.logHash;
      if (!expected) {
        setErr("The log is still being published. Try again in a few seconds.");
        setState("error");
        return;
      }
      const { text } = await api.getLog(c.contestId);
      const local = keccak256(toBytes(text));
      setState(local.toLowerCase() === expected.toLowerCase() ? "match" : "mismatch");
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
      a.download = `litmus-validation-${c.contestId}-log.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  const a = attestation.data;
  return (
    <Card className="p-5 flex flex-col gap-3.5">
      <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em]">Proof</h2>
      <div className="flex items-center justify-between gap-3 flex-wrap p-3 rounded-none bg-sunken border border-border">
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
        <div className="flex flex-col gap-2.5 p-3.5 rounded-none border border-[color-mix(in_srgb,var(--held)_30%,transparent)] bg-[color-mix(in_srgb,var(--held)_6%,transparent)]">
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
  const attempts = useAttempts(c.contestId, true, attemptsFinal(c));
  const sessions = sessionsFromAttempts(attempts.data ?? [], c.winner, c.messagePrice);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Transcripts" aside={`${sessions.length} Breakers with published chats`} />
      {attempts.isError && !attempts.data && <p className="m-0 px-4 py-3 text-muted text-[13px]">{friendlyError(attempts.error)}</p>}
      {sessions.length === 0 && !!attempts.data && <p className="m-0 px-4 py-3 text-muted text-[13px]">No messages were sent in this contest.</p>}
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
      <CertificateCard c={c} />
      {(c.phase === "held" || c.phase === "broken") && (c.agent || c.winnerAgent) && (
        <div className="flex flex-col gap-1.5">
          {c.agent && <AgentFeedbackLine agentId={c.agent.agentId} feedback={c.agent.feedback} feedbackTx={c.agent.feedbackTx} />}
          {c.winnerAgent && (
            <AgentFeedbackLine kind="bounty" agentId={c.winnerAgent.agentId} feedback={c.winnerAgent.feedback} feedbackTx={c.winnerAgent.feedbackTx} />
          )}
        </div>
      )}
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
