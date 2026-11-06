"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ENDED_PHASES, formatUsdc, shortAddress, type ContestSummary } from "@defect/shared";
import { ContestCard } from "./ContestCard";
import { BrokenArt, ClaimArt, DoubtArt, HeldArt, RecordArt, VerdictArt } from "./StepArt";
import { Card, Skeleton, cx } from "../ui/primitives";
import { Cta, Folio, H2, LEDE, Reveal, WRAP, useInView } from "../ui/editorial";
import { ScrollText } from "../ui/motion";
import { useContests, useStats } from "@/lib/hooks";

/* ===========================================================================
   Home page: everything below the hero.

   One idea per section, one hairline grid, square corners. Numbers are
   never shown bare: each one is the start of a sentence, so the record reads
   as a track record rather than a dashboard.
=========================================================================== */

function CountUp({ value, decimals = 0, active }: { value: number; decimals?: number; active: boolean }) {
  const [shown, setShown] = useState(0);
  // Where the next animation starts: 0 the first time, then the number on screen, so a live stats update
  // counts on from the old value instead of restarting from zero.
  const from = useRef(0);
  from.current = shown;
  useEffect(() => {
    if (!active) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = from.current;
    const t0 = performance.now();
    const dur = 1400;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setShown(start + (value - start) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, active]);
  return <>{shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}

// -------------------------------------------------------- 01 the record

export function TheRecord() {
  const stats = useStats();
  const [ref, inView] = useInView<HTMLDivElement>(0.3);
  const s = stats.data;
  const paid = s ? Number(s.paidToBreakers) : 0;

  const cells: { value: number; decimals?: number; unit?: string; line: ReactNode }[] = s
    ? [
        { value: s.contests, line: <>agents have been placed under open, capital-backed validation.</> },
        { value: paid, decimals: 2, unit: "USDC", line: <>awarded to participants who demonstrated a break.</> },
        { value: s.attempts, line: <>adversarial conversations entered into the record.</> },
        { value: s.ogRequests, line: <>inference calls served through 0G and logged for audit.</> },
      ]
    : [];

  return (
    <section aria-labelledby="record-title" className={cx(WRAP, "pt-20 sm:pt-24")}>
      <Folio n="01" label="The public record" />
      <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
        <ScrollText
          id="record-title"
          className={cx(H2, "max-w-3xl")}
          segments={[{ text: "An open ledger of what AI systems claim," }, { text: "and what becomes of those claims.", muted: true }]}
        />
      </div>

      <div ref={ref} className="mt-12 grid grid-cols-1 gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {s
          ? cells.map((c, i) => (
              <div key={i} className="flex min-h-[220px] flex-col justify-between gap-8 bg-bg p-6 sm:p-7">
                <span className="mono text-[clamp(2.4rem,3.6vw,3.6rem)] font-bold leading-none tracking-[-0.02em]">
                  <CountUp value={c.value} decimals={c.decimals} active={inView} />
                  {c.unit && <span className="ml-2 font-sans text-base font-medium tracking-normal text-text/50">{c.unit}</span>}
                </span>
                <p className="m-0 max-w-[26ch] text-[16px] leading-snug text-text/75">{c.line}</p>
              </div>
            ))
          : [0, 1, 2, 3].map((i) => (
              <div key={i} className="flex min-h-[220px] flex-col justify-between bg-bg p-7">
                {stats.isError ? (
                  <>
                    <span className="mono text-[clamp(2.4rem,3.6vw,3.6rem)] font-bold leading-none text-text/25">—</span>
                    <span className="text-[14px] text-text/50">The record is temporarily unavailable.</span>
                  </>
                ) : (
                  <>
                    <Skeleton className="h-12 w-32" />
                    <Skeleton className="h-4 w-48" />
                  </>
                )}
              </div>
            ))}
      </div>

      <VerdictTicker />
    </section>
  );
}

function tickerLine(c: ContestSummary) {
  if (c.phase === "broken")
    return {
      tag: "Broken",
      tone: "text-broken",
      text: (
        <>
          {c.card.name} violated {c.brokenRuleText ? <>“{c.brokenRuleText}”</> : "a guarantee"} · {formatUsdc(c.pool)} USDC awarded to{" "}
          {c.winner ? shortAddress(c.winner) : "the breaker"}
        </>
      ),
    };
  if (c.phase === "held")
    return {
      tag: "Held",
      tone: "text-held",
      text: (
        <>
          {c.card.name} withstood {c.messageCount.toLocaleString()} attempts
        </>
      ),
    };
  if (c.phase === "open" || c.phase === "awaiting_close")
    return {
      tag: "Open",
      tone: "text-open",
      text: (
        <>
          {c.card.name} · {formatUsdc(c.pool)} USDC staked · {c.messageCount.toLocaleString()} attempts recorded
        </>
      ),
    };
  if (c.phase === "scheduled")
    return {
      tag: "Scheduled",
      tone: "text-warn",
      text: (
        <>
          {c.card.name} · {formatUsdc(c.pool)} USDC staked ahead of opening
        </>
      ),
    };
  return null;
}

/** Every verdict, scrolling past like a wire feed. Paused on hover. */
function VerdictTicker() {
  const contests = useContests("all");
  const lines = (contests.data ?? []).map((c) => ({ id: c.contestId, ...tickerLine(c) })).filter((l) => l.tag);
  if (lines.length === 0) return null;
  const loop = [...lines, ...lines];
  return (
    <div className="relative mt-px overflow-hidden border border-t-0 border-line bg-surface [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
      <div className="marquee flex w-max">
        {loop.map((l, i) => (
          <Link
            key={i}
            href={`/contests/${l.id}`}
            aria-hidden={i >= lines.length}
            tabIndex={i >= lines.length ? -1 : undefined}
            className="flex shrink-0 items-center gap-3 border-r border-line px-6 py-4 text-[14px] text-text no-underline hover:bg-sunken"
          >
            <span className={cx("text-[12px] font-semibold uppercase tracking-[0.08em]", l.tone)}>{l.tag}</span>
            <span className="whitespace-nowrap">{l.text}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------- 02 the problem

const RECEIPTS = [
  {
    figure: "$47K",
    what: "Freysa, an agent entrusted with a prize pool, was persuaded to release all of it.",
    href: "https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge",
    src: "The Block",
  },
  {
    figure: "55.5 ETH",
    what: "aixbt lost the funds to an attacker. The only account of the failure came from its own team.",
    href: "https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth",
    src: "Cointelegraph",
  },
  {
    figure: "1 prod DB",
    what: "Replit's coding agent deleted a production database during an explicit code freeze.",
    href: "https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure",
    src: "Fortune",
  },
  {
    figure: "1 ruling",
    what: "Air Canada argued its chatbot was responsible for its own statements. A tribunal held the airline liable.",
    href: "https://globalnews.ca/news/10297307/air-canada-chatbot-error-bc-ruling",
    src: "Global News",
  },
];

export function TheProblem() {
  return (
    <section className={cx(WRAP, "pt-32")}>
      <Folio n="02" label="The problem" />
      <div className="mt-8 grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <div className="lg:sticky lg:top-24">
            <ScrollText
              className={H2}
              segments={[{ text: "Trust in AI has always been extended" }, { text: "on the word of its makers.", muted: true }]}
            />
            <Reveal delay={150}>
              <p className={cx(LEDE, "mt-8 max-w-md")}>
                A model is considered safe because the organisation that built it says so, on evidence it alone selects. When those
                assurances fail, the failure is learned afterwards, and usually from the party responsible. That was tolerable while models
                only produced text. It is no longer tolerable now that agents hold capital, execute transactions and act on behalf of
                others. Litmus begins from a simple premise: a guarantee about machine behaviour should be tested in public before it is
                relied upon.
              </p>
            </Reveal>
          </div>
        </div>
        <ol className="m-0 list-none border-t border-line p-0 lg:col-span-7">
          {RECEIPTS.map((r, i) => (
            <li key={r.figure} className="border-b border-line">
              <Reveal delay={i * 80}>
                <a
                  href={r.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group grid grid-cols-[minmax(0,9rem)_1fr] items-baseline gap-6 py-7 text-text no-underline sm:grid-cols-[12rem_1fr_auto]"
                >
                  <span className="mono text-[clamp(1.6rem,2.4vw,2.25rem)] font-bold leading-none">{r.figure}</span>
                  <span className="text-[17px] leading-snug">{r.what}</span>
                  <span className="col-start-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-text/50 transition-colors group-hover:text-accent sm:col-start-auto">
                    {r.src} ↗
                  </span>
                </a>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ 03 the how

function Tile({
  n,
  title,
  body,
  art,
  tone = "base",
  className = "",
  delay = 0,
}: {
  n: string;
  title: string;
  body: string;
  art: ReactNode;
  tone?: "base" | "ink" | "accent";
  className?: string;
  delay?: number;
}) {
  const skin = { base: "bg-surface text-text", ink: "bg-text text-bg", accent: "bg-chip text-text" }[tone];
  return (
    <Reveal delay={delay} className={cx("flex", className)}>
      <div className={cx("flex w-full flex-col gap-6 p-6 sm:p-8", skin)}>
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-semibold tabular-nums opacity-60">{n}</span>
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">{title}</span>
        </div>
        <div className="-mx-2">{art}</div>
        <p className="m-0 mt-auto max-w-[44ch] text-[16px] leading-relaxed opacity-90">{body}</p>
      </div>
    </Reveal>
  );
}

export function TheHow() {
  return (
    <section id="how-litmus-works" className={cx(WRAP, "scroll-mt-24 pt-32")}>
      <Folio n="03" label="The mechanism" />
      <div className="mt-8 grid gap-8 lg:grid-cols-12">
        <ScrollText
          className={cx(H2, "lg:col-span-7")}
          segments={[{ text: "Verification, made adversarial" }, { text: "and economic.", muted: true }]}
        />
        <Reveal delay={150} className="self-end lg:col-span-4 lg:col-start-9">
          <p className={LEDE}>
            Litmus converts the guarantees a model makes into open contests with capital at stake. Terms are fixed before the first attempt,
            outcomes are determined by code rather than judgment, and settlement occurs onchain without discretion from any party, Litmus
            included. Safety ceases to be a statement and becomes a standing, public test.
          </p>
        </Reveal>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-px border border-line bg-line md:grid-cols-6">
        <Tile
          className="md:col-span-2"
          n="01"
          title="Claim"
          art={<ClaimArt />}
          body="A lab publishes an agent together with the guarantees it makes about its behaviour, and commits capital behind them before the validation opens."
        />
        <Tile
          className="md:col-span-2"
          delay={80}
          n="02"
          title="Doubt"
          art={<DoubtArt />}
          body="Anyone may attempt to make the agent violate a guarantee. Participation requires no permission; each message carries a small cost, settled per request over x402."
        />
        <Tile
          className="md:col-span-2"
          delay={160}
          n="03"
          title="Verdict"
          art={<VerdictArt />}
          body="Each guarantee is judged by the rule that defines it. A disclosed secret is matched against its sealed commitment; an unauthorised transfer is observed onchain."
        />
        <Tile
          className="md:col-span-3"
          tone="ink"
          n="04a"
          title="Broken"
          art={<BrokenArt />}
          body="When a guarantee fails, the stake transfers to the participant who demonstrated the failure, immediately and without review."
        />
        <Tile
          className="md:col-span-3"
          tone="accent"
          delay={80}
          n="04b"
          title="Held"
          art={<HeldArt />}
          body="When a guarantee survives, the lab recovers its stake, retains the fees paid by challengers, and receives a permanent onchain record of the result."
        />
        <Reveal className="md:col-span-6">
          <div className="grid items-center gap-8 bg-surface p-6 sm:p-8 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              <div className="flex items-baseline gap-4">
                <span className="text-[13px] font-semibold tabular-nums opacity-60">05</span>
                <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">Record</span>
              </div>
              <p className="m-0 max-w-[48ch] text-[clamp(1.25rem,1.6vw,1.6rem)] font-medium leading-snug tracking-[-0.01em]">
                Every outcome is independently re-verified through Chainlink and recorded permanently, so that no result rests on the
                testimony of a lab, or of Litmus.
              </p>
            </div>
            <div className="-mx-2">
              <RecordArt />
            </div>
          </div>
        </Reveal>
      </div>

      <div className="mt-10 flex flex-wrap justify-center gap-3">
        <Cta href="/about" className="px-8 py-4 text-[16px]">
          Know more
        </Cta>
        <Cta href="/warden/new" tone="ink" incline className="px-8 py-4 text-[16px]">
          Try now
        </Cta>
      </div>
    </section>
  );
}

// ------------------------------------------------------- 04 validations

type Tab = "open" | "upcoming" | "ended";
const TABS: { key: Tab; label: string; match: (c: ContestSummary) => boolean }[] = [
  { key: "open", label: "Open now", match: (c) => c.phase === "open" || c.phase === "awaiting_close" },
  { key: "upcoming", label: "Upcoming", match: (c) => c.phase === "scheduled" },
  { key: "ended", label: "Ended", match: (c) => ENDED_PHASES.includes(c.phase) },
];

export function TheValidations() {
  const [tab, setTab] = useState<Tab>("open");
  const contests = useContests("all");
  const all = contests.data ?? [];
  const current = TABS.find((t) => t.key === tab)!;
  const shown = all.filter(current.match).sort((a, b) => (tab === "open" ? Number(b.pool) - Number(a.pool) : 0));

  return (
    <section id="contests" className={cx(WRAP, "scroll-mt-24 pt-32")}>
      <Folio n="04" label="Active validations" />
      <div className="mt-8 flex flex-wrap items-end justify-between gap-6">
        <ScrollText className={cx(H2, "max-w-3xl")} segments={[{ text: "Validations" }, { text: "open to challenge.", muted: true }]} />
        <div role="tablist" aria-label="Filter validations" className="flex gap-px border border-line bg-line">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cx(
                "min-h-10 cursor-pointer border-0 px-4 text-[13px] font-medium transition-colors",
                tab === t.key ? "bg-text text-bg" : "bg-bg text-text hover:bg-sunken",
              )}
            >
              {t.label} <span className="mono ml-1 opacity-60">{all.filter(t.match).length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-10">
        {contests.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="flex flex-col gap-3.5 p-5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-8 w-40" />
              </Card>
            ))}
          </div>
        ) : contests.isError && !contests.data ? (
          <Card className="p-6">Couldn&apos;t load validations. {String((contests.error as Error).message)}</Card>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-4 border border-dashed border-border-strong p-12 text-center">
            <span className="text-lg font-semibold">
              {tab === "open"
                ? "No validations are open at present."
                : tab === "upcoming"
                  ? "No validations are scheduled."
                  : "No validations have concluded yet."}
            </span>
            <Cta href="/warden/new" tone="ink">
              Start validation
            </Cta>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(340px,100%),1fr))] gap-4">
            {shown.map((c) => (
              <ContestCard key={c.contestId} c={c} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------- 05 two doors

function Door({
  who,
  title,
  points,
  cta,
  href,
  ink,
}: {
  who: string;
  title: string;
  points: string[];
  cta: string;
  href: string;
  ink?: boolean;
}) {
  return (
    <div className={cx("flex flex-col p-8 sm:p-12", ink ? "bg-text text-bg" : "bg-surface text-text")}>
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] opacity-70">{who}</span>
      <h3 className="m-0 mt-5 max-w-[18ch] text-[clamp(1.75rem,2.6vw,2.75rem)] font-bold leading-[1.05] tracking-[-0.03em]">{title}</h3>
      <ul className="m-0 mb-10 mt-8 list-none space-y-3 p-0">
        {points.map((p) => (
          <li key={p} className="flex gap-3 text-[16px] leading-snug">
            <span aria-hidden className={cx("mt-[0.5em] h-[5px] w-[5px] shrink-0", ink ? "bg-bg/60" : "bg-accent")} />
            <span className="opacity-90">{p}</span>
          </li>
        ))}
      </ul>
      <Cta href={href} tone={ink ? "paper" : "accent"} className="mt-auto">
        {cta}
      </Cta>
    </div>
  );
}

export function TwoDoors() {
  return (
    <section className={cx(WRAP, "pt-32")}>
      <Folio n="05" label="Participants" />
      <div className="mt-8 grid grid-cols-1 gap-px border border-line bg-line lg:grid-cols-2">
        <Door
          who="Wardens · Model developers"
          title="For those who build models, a way to demonstrate safety rather than assert it."
          href="/warden/new"
          cta="Publish a model"
          points={[
            "Guarantees are backed by capital and exposed to open challenge.",
            "Every unsuccessful attempt pays the Warden and adds to a public audit.",
            "A guarantee that holds earns a record that cannot be purchased or altered.",
          ]}
        />
        <Door
          ink
          who="Breakers · Researchers"
          title="For those who find failures, a direct claim on what they uncover."
          href="#contests"
          cta="Start validating"
          points={[
            "Participation is open, without application or approval.",
            "Each attempt costs a fraction of a dollar, paid per message.",
            "A demonstrated break transfers the full stake to its discoverer.",
          ]}
        />
      </div>
    </section>
  );
}

// ------------------------------------------------- closing band + footer

export function ClosingBand() {
  return (
    <section className="mt-32 bg-accent text-on-accent">
      <div className={cx(WRAP, "grid gap-10 py-20 sm:py-28 lg:grid-cols-12 lg:items-end")}>
        <Reveal className="lg:col-span-8">
          <h2 className="m-0 text-[clamp(2rem,4.2vw,4.25rem)] font-bold leading-[1] tracking-[-0.035em]">
            Trust should be the result of testing, not a substitute for it.
            <br />
            <span className="text-on-accent/70">Litmus makes the test public.</span>
          </h2>
        </Reveal>
        <div className="flex flex-wrap gap-3 lg:col-span-4 lg:justify-end">
          <Cta href="/warden/new" tone="paper">
            Start validation
          </Cta>
          <Cta href="#contests" tone="line">
            View validations
          </Cta>
        </div>
      </div>
    </section>
  );
}
