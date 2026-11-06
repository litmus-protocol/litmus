"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fromBaseUnits, hashscanAccount, isDecimalString, toBaseUnits, type BotRunView, type ContestDetail } from "@defect/shared";
import { api, friendlyError } from "@/lib/api";
import { useBot } from "@/lib/hooks";
import { useTx } from "@/lib/useTx";
import { useWallet } from "@/lib/wallet";
import { BoltIcon, WarnIcon } from "../ui/icons";
import { Button, Callout, Card, CardHeader, Chip, CopyText, HashscanLink, Skeleton, Usdc, cx, inputCls } from "../ui/primitives";

// "Run auto breaking bot": the shared breaker bot attacks this validation on request. The user tops up
// the bot's wallet, then presses Run; the bot finds the paid endpoint through x402 discovery and pays
// every message itself. Nothing runs until someone presses the button.

const OUTCOMES: Record<string, string> = {
  broken_by_us: "The bot broke a rule",
  broken_by_other: "Someone else broke it first",
  max_attempts: "The agent held for the whole run",
  budget: "The bot ran out of USDC",
  contest_ended: "The validation ended during the run",
  contest_not_open: "The validation wasn't open",
  claim_failed: "The bot found a secret but its claim failed",
  error: "The run stopped on an error",
};

export function BotPanel({ c }: { c: ContestDetail }) {
  const bot = useBot();
  const { wallet, openDrawer, refreshBalances } = useWallet();
  const { run: runTx, busy } = useTx();
  const qc = useQueryClient();
  const [amount, setAmount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const b = bot.data;
  const run = b ? (b.active?.contestId === c.contestId ? b.active : (b.latest[c.contestId] ?? null)) : null;

  // When a run finishes the pool or the phase may have changed.
  const status = run?.status;
  useEffect(() => {
    if (status && status !== "running") void qc.invalidateQueries({ queryKey: ["contest", c.contestId] });
  }, [status, c.contestId, qc]);

  if (bot.isLoading) {
    return (
      <div className="p-6 flex flex-col gap-3">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (!b) return <p className="m-0 p-6 text-muted text-[13px]">{bot.error ? friendlyError(bot.error) : "Couldn't load the breaker bot."}</p>;
  if (!b.enabled || !b.address || !b.accountId) {
    return <p className="m-0 p-6 text-muted text-[13px]">The breaker bot isn&apos;t set up on this gateway.</p>;
  }
  const botAccount = { address: b.address, accountId: b.accountId };

  const price = toBaseUnits(c.messagePrice);
  const balance = b.usdc === null ? null : toBaseUnits(b.usdc);
  const funded = balance !== null && balance >= price;
  const amt = amount ?? fromBaseUnits(price * BigInt(b.maxAttempts));
  const amountOk = isDecimalString(amt) && toBaseUnits(amt) > 0n;
  const busyElsewhere = b.active && b.active.contestId !== c.contestId ? b.active.contestId : null;
  const running = run?.status === "running";

  async function fund() {
    if (!wallet || !amountOk) return;
    const res = await runTx("Funding the bot", () => api.transferUsdc(wallet, botAccount, toBaseUnits(amt)));
    if (!res) return;
    refreshBalances();
    // The mirror node shows the new balance a few seconds after consensus.
    for (const ms of [0, 3_000, 7_000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ["bot"] }), ms);
  }

  async function start() {
    setError(null);
    setStarting(true);
    try {
      await api.startBotRun(c.contestId);
      await qc.invalidateQueries({ queryKey: ["bot"] });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-xl font-semibold tracking-tight">Let an AI agent try to break it</h3>
        <p className="m-0 text-muted leading-relaxed">
          The breaker bot has its own Hedera wallet. Press Run and it finds this validation&apos;s paid endpoint through x402 discovery, then pays
          for every message itself. Nobody approves a payment. It sends at most {b.maxAttempts} messages per run.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <StepTitle n={1}>Fund the bot</StepTitle>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px] items-center">
          <span className="text-muted">Account</span>
          <span className="flex items-center gap-3 min-w-0">
            <span className="mono">{b.accountId}</span>
            <HashscanLink href={hashscanAccount(b.accountId)} />
          </span>
          <span className="text-muted">Address</span>
          <CopyText text={b.address} display={`${b.address.slice(0, 8)}…${b.address.slice(-6)}`} className="text-[13px] justify-self-start" />
          <span className="text-muted">Balance</span>
          <span>{b.usdc === null ? <span className="text-faint">unknown</span> : <Usdc value={b.usdc} />}</span>
        </div>
        {wallet ? (
          <div className="flex gap-2 flex-wrap items-stretch">
            <label htmlFor="bot-amount" className="sr-only">
              USDC to send to the bot
            </label>
            <div className="w-32">
              <input id="bot-amount" inputMode="decimal" value={amt} onChange={(e) => setAmount(e.target.value.trim())} className={cx(inputCls, "mono")} />
            </div>
            <Button variant="ghost" onClick={() => void fund()} disabled={busy || !amountOk}>
              Send {amountOk ? amt : ""} USDC to the bot
            </Button>
          </div>
        ) : (
          <Button variant="ghost" className="self-start" onClick={openDrawer}>
            Connect a wallet to fund the bot
          </Button>
        )}
        <span className="text-xs text-faint">
          {fromBaseUnits(price * BigInt(b.maxAttempts))} USDC covers a full run. The bot wallet is shared: anyone can fund it and anyone can run it.
        </span>
      </section>

      <section className="flex flex-col gap-3">
        <StepTitle n={2}>Run it</StepTitle>
        <Button className="self-start" onClick={() => void start()} disabled={!funded || running || starting || busyElsewhere !== null}>
          <BoltIcon size={16} />
          {running ? "Bot is running…" : starting ? "Starting…" : "Run auto breaking bot"}
        </Button>
        {!funded && !running && (
          <span className="text-xs text-faint">Send the bot at least {c.messagePrice} USDC first (one message).</span>
        )}
        {busyElsewhere !== null && <span className="text-xs text-faint">The bot is busy on validation #{busyElsewhere}. Try again when it finishes.</span>}
        {error && (
          <Callout tone="broken" icon={<WarnIcon size={14} />}>
            {error}
          </Callout>
        )}
      </section>

      {run && <RunLog run={run} />}
    </div>
  );
}

/** After a validation ends: the breaker bot's run on it, if it had one (the tab is gone by then). */
export function BotRunCard({ contestId }: { contestId: number }) {
  const bot = useBot();
  const run = bot.data?.latest[contestId];
  if (!run) return null;
  return (
    <Card>
      <CardHeader title="Breaker bot run" aside="Found the endpoint via x402 discovery and paid on its own" />
      <div className="p-5">
        <RunLog run={run} />
      </div>
    </Card>
  );
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <h4 className="m-0 flex items-center gap-2 text-[15px] font-semibold">
      <span className="mono inline-flex items-center justify-center w-6 h-6 bg-chip border border-border-strong text-xs">{n}</span>
      {children}
    </h4>
  );
}

function RunLog({ run }: { run: BotRunView }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [run.lines.length]);

  const chip =
    run.status === "running" ? (
      <Chip tone="warn">Running</Chip>
    ) : run.outcome === "broken_by_us" ? (
      <Chip tone="broken">Broke a rule</Chip>
    ) : run.status === "failed" ? (
      <Chip tone="broken">Failed</Chip>
    ) : (
      <Chip tone="pass">Done</Chip>
    );

  return (
    <section className="flex flex-col gap-2.5" aria-label="Bot run log">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="eyebrow">Bot log</span>
        {chip}
      </div>
      <div ref={ref} className="bg-sunken border border-border p-3 max-h-[360px] overflow-y-auto mono text-[12px] leading-relaxed" aria-live="polite">
        {run.lines.length === 0 ? <span className="text-faint">Starting…</span> : run.lines.map((line, i) => <LogLine key={i} line={line} />)}
      </div>
      {run.status !== "running" && (
        <div className="flex flex-col gap-1 text-[13px]">
          <span className="font-medium">
            {(run.outcome && OUTCOMES[run.outcome]) ?? run.error ?? "The run ended"}
            {run.winnings ? ` and won ${run.winnings} USDC` : ""}.
          </span>
          <span className="text-muted">
            {run.attempts} message{run.attempts === 1 ? "" : "s"} · {run.charged} paid over x402 · {run.usdcSpent} USDC spent
            {run.error && run.outcome ? ` · ${run.error}` : ""}
          </span>
        </div>
      )}
    </section>
  );
}

const URL_RE = /(https?:\/\/\S+)/g;

function LogLine({ line }: { line: string }) {
  const tone = /^#\d+ /.test(line)
    ? "text-text font-semibold"
    : line.startsWith("   →")
      ? "text-accent"
      : /BROKE|BROKEN/.test(line)
        ? "text-broken-text font-semibold"
        : line.startsWith("   ←")
          ? "text-soft"
          : "text-muted";
  return (
    <div className={cx("whitespace-pre-wrap break-words", tone)}>
      {line.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {part.includes("hashscan.io") ? "HashScan ↗" : part}
          </a>
        ) : (
          part
        ),
      )}
    </div>
  );
}
