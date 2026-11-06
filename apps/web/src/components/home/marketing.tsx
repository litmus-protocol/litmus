"use client";

import Image from "next/image";
import Link from "next/link";
import type { Application } from "@splinetool/runtime";
import { DitherBox } from "./DitherBox";
import { DitherTest } from "./DitherTest";
import { BrokenArt, ClaimArt, DoubtArt, HeldArt, RecordArt, VerdictArt } from "./StepArt";
import { SplineScene } from "./SplineScene";

/* ===========================================================================
   Marketing sections, ported from the standalone landing site onto the real
   app. Everything here uses the app's own tokens (text / muted / surface /
   accent), so it re-themes with the rest of the product rather than carrying
   its own palette.
   ======================================================================== */

// --------------------------------------------------------------- hero bot

// The Spline scene ships a looping idle animation that swings the arms. The
// runtime cannot stop a single animation, and stop() would also kill the
// cursor-driven head tracking — so the joints it drives are pinned to their
// load-time rotation every frame instead.
const PINNED_JOINTS = new Set(["Hand LEFT", "Hand", "Hand Instance", "arm", "elbow", "forearm"]);
let pinFrame: number | null = null;

function handleLoad(app: Application) {
  const light = app.findObjectByName("Point Light") as unknown as { intensity?: number };
  if (light && typeof light.intensity === "number") light.intensity = 26;
  app.setGlobalEvents(true);

  const pose = app
    .getAllObjects()
    .filter((o) => PINNED_JOINTS.has(o.name))
    .map((o) => ({ o, x: o.rotation.x, y: o.rotation.y, z: o.rotation.z }));
  if (!pose.length) return;
  if (pinFrame !== null) cancelAnimationFrame(pinFrame);
  const pin = () => {
    for (const p of pose) {
      p.o.rotation.x = p.x;
      p.o.rotation.y = p.y;
      p.o.rotation.z = p.z;
    }
    pinFrame = requestAnimationFrame(pin);
  };
  pinFrame = requestAnimationFrame(pin);
}

// Bot and dome come off ONE set of numbers, both as a share of the stage
// height, so they stay in proportion at every viewport. The dome hangs off
// the HEAD, not the bot's midpoint, which sits below the fold.
const BOT = { top: 56, height: 72, scale: 0.95, width: 26 };
const BOT_SPAN = BOT.height * BOT.scale;
const DOME_TO_BOT = 1.45;
const HEAD_DEPTH = 0.29;
const DOME_HEIGHT = BOT_SPAN * DOME_TO_BOT;
const DOME_TOP = BOT.top - DOME_HEIGHT * HEAD_DEPTH;
const DOME_POS = { top: `${DOME_TOP}%`, height: `${DOME_HEIGHT}%` };
const DOME_BOX = "pointer-events-none absolute left-1/2 w-auto max-w-none -translate-x-1/2 select-none";

const NETWORKS = [
  { src: "/logos/hedera.svg", alt: "Hedera", href: "https://hedera.com", w: 1283, h: 362, cls: "h-[30px]" },
  { src: "/logos/0g.webp", alt: "0G", href: "https://0g.ai", w: 1024, h: 528, cls: "h-[28px]" },
  { src: "/logos/chainlink.svg", alt: "Chainlink", href: "https://chain.link", w: 925, h: 235, cls: "h-[30px]" },
];

export function Hero({ openCount }: { openCount: number }) {
  return (
    <section
      // Exactly one viewport: the first scroll must land on the next
      // section, never on more hero. `--chrome` is the measured height of
      // the banner + header above this (see ChromeFrame) — a hard-coded
      // subtraction goes wrong as soon as the header's flex-wrap adds a
      // row. Landing flush with the fold also hides the stage's
      // overflow-hidden cut, which the bot runs through below.
      className="relative flex min-h-[calc(100svh-var(--chrome))] w-full flex-col overflow-hidden"
    >
      <div className="relative z-20 mx-auto max-w-4xl shrink-0 px-6 pt-10 text-center">

        <h1 className="m-0 text-[clamp(2.5rem,3.8vw+2.8vh,5.75rem)] font-bold leading-[0.98] tracking-[-0.03em] text-text">
          Trustless validation of
          <br />
          <span className="font-accent text-[0.86em] font-black tracking-[-0.01em]">agents.</span>
        </h1>

      </div>

      <div className="relative z-20 mt-8 flex shrink-0 flex-col items-center gap-4 px-6">
        <span className="font-accent text-[15px] font-bold uppercase tracking-[0.22em] text-faint">Powered by</span>
        <div className="flex flex-wrap items-center justify-center gap-x-9 gap-y-4 sm:gap-x-11">
          {NETWORKS.map((n) => (
            <a
              key={n.src}
              href={n.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${n.alt} (opens in a new tab)`}
              className="opacity-90 transition-opacity hover:opacity-100"
            >
              {/* the marks are near-black art */}
              <Image src={n.src} alt={n.alt} width={n.w} height={n.h} className={`${n.cls} w-auto`} />
            </a>
          ))}
        </div>
      </div>

      <div className="relative -mt-6 min-h-0 w-full flex-[1.25] overflow-hidden">
        <Image src="/dome.webp" alt="" aria-hidden width={1006} height={558} priority unoptimized className={DOME_BOX} style={DOME_POS} />
        <div
          className="absolute left-1/2 origin-top"
          // independent properties, not a composed transform: that way the
          // -50% centring is not multiplied by the scale
          style={{ top: `${BOT.top}%`, height: `${BOT.height}%`, width: `${BOT.width}%`, translate: "-50%", scale: `${BOT.scale}` }}
        >
          <SplineScene scene="https://prod.spline.design/kZDDjO5HuC9GJUM2/scene.splinecode" className="h-full w-full" onLoad={handleLoad} />
        </div>
        <Image
          src="/dome.webp"
          alt=""
          aria-hidden
          width={1006}
          height={558}
          unoptimized
          className={`${DOME_BOX} [mask-image:linear-gradient(to_bottom,transparent_42%,black_56%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_42%,black_56%)]`}
          style={{ ...DOME_POS, mixBlendMode: "screen" }}
        />
      </div>
    </section>
  );
}

// ------------------------------------------------------------- the thesis

function Ref({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-text underline decoration-border-strong decoration-1 underline-offset-[3px] transition-colors hover:text-accent hover:decoration-accent"
    >
      {children}
    </a>
  );
}

export function Custodial() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pt-28">
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-7">
          <h2 className="m-0 max-w-4xl text-[clamp(2rem,3.4vw,3.75rem)] font-bold leading-[1.02] tracking-[-0.03em] text-text">
            AI safety is <span className="font-accent text-[0.84em] font-black tracking-[-0.01em]">custodial.</span>
          </h2>
          <div className="mt-8 max-w-2xl text-[clamp(1rem,1.05vw,1.1875rem)] leading-[1.62] text-muted">
            <p className="m-0">
              A lab says its model is safe. The evidence is the lab&apos;s own: benchmarks it picked, red-teaming it ran, a report it
              wrote. You can read the code and audit the chain, but you cannot check that sentence. You hold it on trust.
            </p>
            <p className="mt-5">Failures arrive the same way, late and from whoever has to admit them.</p>
            <ul className="mt-5 list-none space-y-3 border-l border-border pl-5">
              <li>
                <Ref href="https://www.theblock.co/post/328747/human-player-outwits-freysa-ai-agent-in-47000-crypto-challenge">
                  Freysa, an agent guarding a prize pool, was talked into paying out all of it: about $47K
                </Ref>
                .
              </li>
              <li>
                <Ref href="https://cointelegraph.com/news/hacker-breaches-ai-crypto-bot-aixbt-steals-55-eth">
                  aixbt lost 55.5 ETH to an attacker
                </Ref>
                . The explanation came from its own team.
              </li>
              <li>
                <Ref href="https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure">
                  Replit&apos;s coding agent deleted a production database during a code freeze
                </Ref>
                .
              </li>
              <li>
                <Ref href="https://globalnews.ca/news/10297307/air-canada-chatbot-error-bc-ruling">
                  Air Canada told a tribunal its chatbot was responsible for its own answers
                </Ref>
                . The tribunal disagreed.
              </li>
              <li>
                Even the labs&apos; own disclosures, <Ref href="https://openai.com/index/sycophancy-in-gpt-4o/">a rolled-back GPT-4o update</Ref>{" "}
                and <Ref href="https://www.anthropic.com/research/agentic-misalignment">simulated blackmail by frontier models</Ref>, were
                written by the labs that ship them.
              </li>
            </ul>
            <p className="mt-5">
              Each of these was learned after the fact. A model should not have to cause harm before we find out what it was willing to
              do. Litmus moves the test ahead of the damage: anyone can attack the model today, with a stake on the table.
            </p>
          </div>
        </div>
        <div className="lg:col-span-5">
          <DitherBox />
        </div>
      </div>
    </section>
  );
}

export function WhatIsLitmus() {
  return (
    <section id="what-is-defect" className="mx-auto w-full max-w-6xl scroll-mt-24 px-6 pt-28">
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-5">
          <DitherTest />
        </div>
        <div className="lg:col-span-7">
          <h2 className="m-0 text-[clamp(2rem,3.4vw,3.75rem)] font-bold leading-[1.02] tracking-[-0.03em] text-text">
            What is <span className="font-accent text-[0.84em] font-black tracking-[-0.01em]">Litmus?</span>
          </h2>
          <p className="mt-6 max-w-2xl font-accent text-[15px] font-bold uppercase tracking-[0.16em] text-faint">
            Non-custodial model validation
          </p>
          <div className="mt-6 max-w-2xl text-[clamp(1rem,1.05vw,1.1875rem)] leading-[1.62] text-muted">
            <p className="m-0">
              Litmus is a public proving ground for AI models. A lab publishes a model together with the promises it makes about it:
              this assistant will never reveal what you told it in private, this agent will never move funds it does not own. Then it
              puts real money behind those promises and opens the door.
            </p>
            <p className="mt-5">
              Researchers, red-teamers and anyone curious can try to make the model do the opposite of what it swore, or do what it
              must never do. If they succeed, the stake is theirs. If the model holds, it has survived open doubt rather than a
              friendly test, and carries a mark that says so.
            </p>
            <p className="mt-5">
              <strong className="font-medium text-text">Non-custodial</strong> is the point. We never hold the money, never judge the
              attempt and never decide who was right. The rules were fixed before anyone tried, the outcome is settled by code on
              Hedera, and Chainlink re-checks the result independently, so the verdict never rests on trusting a lab, or us.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// -------------------------------------------------------------- the steps

type StepTone = "base" | "inverse" | "accent";

const STEPS = [
  { n: "01", title: "Claim", body: "A lab publishes a model and the promises it makes about it: what it will never reveal, never do, never be talked into. Real money is locked behind the words before anyone is allowed to try." },
  { n: "02", title: "Doubt", body: "Anyone may try to make the model betray its promise: researchers, red-teamers, other agents. No application, no permission. Each attempt costs a few cents, so doubt is open to everyone and free to nobody." },
  { n: "03", title: "Verdict", body: "The promise held or it did not, and the rule itself decides which. No committee, no review, no appeal, and no part for us to play." },
];

const OUTCOMES: { n: string; title: string; tone: StepTone; body: string }[] = [
  { n: "04a", title: "Broken", tone: "inverse", body: "The model did what it swore it never would. The researcher who showed it takes everything staked behind it, immediately, with nobody's approval required." },
  { n: "04b", title: "Held", tone: "accent", body: "The promise survived open doubt. The lab takes its stake back, keeps every fee, and earns a mark that cannot be bought, sold or edited." },
];

const AUDIT = { n: "05", title: "Record", body: "Chainlink checks the result again, independently, and writes it down where it outlives the argument. Nobody has to take a lab's word, or ours, for anything." };

function StepCell({ n, title, body, tone = "base", className = "", art, artBottom }: { n: string; title: string; body: string; tone?: StepTone; className?: string; art?: React.ReactNode; artBottom?: boolean }) {
  const skin =
    tone === "inverse"
      ? "bg-text border-transparent text-bg"
      : tone === "accent"
        ? "bg-chip border-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-text"
        : "bg-surface border-border text-text";
  const chip =
    tone === "inverse"
      ? "bg-[color-mix(in_srgb,var(--bg)_18%,transparent)] text-bg"
      : tone === "accent"
        ? "bg-accent text-on-accent"
        : "bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-muted";
  return (
    <div className={`${skin} flex flex-col border p-6 ${className}`}>
      {art && !artBottom && <div className="-mx-2 mb-5">{art}</div>}
      <span className={`${chip} inline-flex h-7 w-fit shrink-0 items-center justify-center self-start px-2.5 font-accent text-[13px] font-bold tabular-nums`}>{n}</span>
      <h3 className="m-0 mt-4 text-lg font-bold tracking-[-0.02em]">{title}</h3>
      <p className="m-0 mt-2 text-[16px] leading-relaxed opacity-[0.92]">{body}</p>
      {art && artBottom && <div className="-mx-2 mt-auto pt-5">{art}</div>}
    </div>
  );
}

// Dotted connectors around the fork. `split` leaves the centre of 03 (the
// third of three columns, so 5/6 across) and runs to the centres of the two
// half-width cards below (1/4 and 3/4); `merge` gathers both back into the
// middle for 05.
function Branch({ dir }: { dir: "split" | "merge" }) {
  const dot = "border-dotted border-text/40";
  if (dir === "split") {
    return (
      <div aria-hidden className="relative hidden h-14 md:block">
        <div className={`absolute top-0 h-1/2 border-l-2 ${dot}`} style={{ left: "83.3333%" }} />
        <div className={`absolute top-1/2 border-t-2 ${dot}`} style={{ left: "25%", width: "58.3333%" }} />
        <div className={`absolute top-1/2 h-1/2 border-l-2 ${dot}`} style={{ left: "25%" }} />
        <div className={`absolute top-1/2 h-1/2 border-l-2 ${dot}`} style={{ left: "75%" }} />
      </div>
    );
  }
  return (
    <div aria-hidden className="hidden md:block">
      <div className={`mx-auto h-7 w-1/2 border-x-2 border-b-2 ${dot}`} />
      <div className={`mx-auto h-7 w-0 border-l-2 ${dot}`} />
    </div>
  );
}

export function HowLitmusWorks() {
  return (
    <section id="how-litmus-works" className="mx-auto w-full max-w-7xl scroll-mt-24 px-6 pt-28">
      <h2 className="m-0 text-[clamp(2rem,3.4vw,3.75rem)] font-bold leading-[1.02] tracking-[-0.03em] text-text">How Litmus works</h2>
      <p className="m-0 mt-4 font-accent text-[14px] font-bold uppercase tracking-[0.18em] text-faint">
        Claim · Doubt · Verdict · Consequence · Record
      </p>

      {/* 01-03 are a straight line. 04 is the only fork, so it gets its own
          row: two equal cards joined to 03 above and 05 below by a dotted
          branch, which says "one of these", not "step four, then five". */}
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {STEPS.map((s) => (
          <StepCell
            key={s.n}
            {...s}
            art={s.n === "01" ? <ClaimArt /> : s.n === "02" ? <DoubtArt /> : s.n === "03" ? <VerdictArt /> : undefined}
            artBottom={s.n === "02"}
          />
        ))}
      </div>

      <Branch dir="split" />
      <p className="m-0 mb-4 text-center font-accent text-[12px] font-bold uppercase tracking-[0.2em] text-faint">
        04 · Consequence · one of two
      </p>
      <div className="relative grid gap-4 md:grid-cols-2">
        {OUTCOMES.map((o) => (
          <StepCell key={o.n} {...o} art={o.n === "04a" ? <BrokenArt /> : <HeldArt />} />
        ))}
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 border border-text/40 bg-bg px-3 py-1.5 font-accent text-[12px] font-bold uppercase tracking-[0.2em] text-text md:block"
        >
          or
        </span>
      </div>
      <Branch dir="merge" />

      <StepCell {...AUDIT} art={<RecordArt />} />

      {/* Framed rather than dropped straight on the page: the chart carries
          its own near-cream background, and a near-miss reads as a mistake
          where a deliberate frame does not. */}
      <figure className="m-0 mt-12 overflow-hidden border border-border">
        <Image
          src="/defect-flow.svg"
          alt="Litmus flow chart. Stake: write the rules, seal secrets, lock the prize, open the contest. Attack: send a message, pay per message via x402, the agent thinks and acts, repeated until it breaks. Prove: commit the leak, reveal it, check the rule, decide broken or held. Broken pays the breaker and refunds the owner; Held closes the window, pays the owner and mints the NFT. Audit: hash the log, publish secrets, re-verify and attest the result."
          width={1920}
          height={1080}
          unoptimized
          className="h-auto w-full"
        />
      </figure>

    </section>
  );
}

// ----------------------------------------------------------- pick a side

function Bullets({ items, inverse }: { items: string[]; inverse?: boolean }) {
  return (
    <ul className="m-0 mt-6 list-none space-y-3 p-0">
      {items.map((t) => (
        <li key={t} className="flex gap-3 text-[15px] leading-relaxed">
          <span aria-hidden className={`mt-[0.55em] h-[5px] w-[5px] shrink-0 ${inverse ? "bg-[color-mix(in_srgb,var(--bg)_55%,transparent)]" : "bg-accent"}`} />
          <span className="opacity-[0.92]">{t}</span>
        </li>
      ))}
    </ul>
  );
}

function SideCard({ icon, role, lede, items, cta, href, inverse }: { icon: string; role: string; lede: string; items: string[]; cta: string; href: string; inverse?: boolean }) {
  return (
    <div className={`flex flex-col border p-8 md:p-10 ${inverse ? "border-transparent bg-text text-bg" : "border-border bg-surface text-text"}`}>
      {/* dots are near-black; inverted on the black card rather than shipping
          a second asset */}
      <Image src={icon} alt="" aria-hidden width={320} height={320} unoptimized className={`h-14 w-14 ${inverse ? "invert" : ""}`} />
      <span className="mt-6 font-accent text-[12px] font-bold uppercase tracking-[0.2em]">{role}</span>
      <h3 className="m-0 mt-3 text-[clamp(1.35rem,1.6vw,1.75rem)] font-bold leading-[1.15] tracking-[-0.02em]">{lede}</h3>
      <Bullets items={items} inverse={inverse} />
      <Link
        href={href}
        className={`mt-8 inline-flex w-fit items-center gap-3 px-6 py-3.5 text-[15px] font-medium no-underline transition-colors ${
          inverse ? "bg-bg text-text hover:bg-sunken" : "bg-accent text-on-accent hover:bg-accent-hover"
        }`}
      >
        {cta}
        <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

export function PickYourSide() {
  return (
    <section id="pick-your-side" className="mx-auto w-full max-w-7xl scroll-mt-24 px-6 pt-28">
      <h2 className="m-0 text-[clamp(2rem,3.4vw,3.75rem)] font-bold leading-[1.02] tracking-[-0.03em] text-text">Pick your side</h2>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        <SideCard
          icon="/icons/warden.webp"
          role="Labs · you built a model (Wardens)"
          lede="Say what your model will never do. Then let the world try."
          href="/warden/new"
          cta="Publish a model"
          items={[
            "Put money behind your model's promise and let anyone in the world test it.",
            "Every attempt that fails pays you, and every one is a free audit.",
            "If the promise holds, you earn a mark that cannot be bought, sold or edited.",
            "Real adversaries, without having to hire them.",
          ]}
        />
        <SideCard
          inverse
          icon="/icons/breaker.webp"
          role="Researchers · you break things (Breakers)"
          lede="Find the crack. Prove it. Take what is behind it."
          href="#contests"
          cta="Start breaking"
          items={[
            "No sign-up, no application, nobody deciding whether you qualify.",
            "A few cents a message to try to make the model slip.",
            "Break the promise and what was staked behind it is yours at once.",
            "No “we will review your report”. The rule already decided.",
          ]}
        />
      </div>

      {/* No call to action: this audience reads, it does not sign up */}
      <div className="mt-4 flex flex-col items-start gap-6 bg-sunken p-8 md:flex-row md:items-center md:gap-10 md:p-10">
        <Image src="/icons/observer.webp" alt="" aria-hidden width={320} height={320} unoptimized className="h-12 w-12 shrink-0" />
        <div>
          <span className="font-accent text-[12px] font-bold uppercase tracking-[0.2em] text-faint">Everyone else · you use AI models</span>
          <h3 className="m-0 mt-2 text-[clamp(1.25rem,1.5vw,1.6rem)] font-bold tracking-[-0.02em] text-text">Check the record before you trust it.</h3>
          <p className="m-0 mt-3 max-w-3xl text-[15px] leading-relaxed text-muted">
            Every claim, every attempt and every verdict is public.{" "}
            <Link href="#contests" className="text-text underline decoration-border-strong underline-offset-[3px] hover:text-accent hover:decoration-accent">
              See which models survived open doubt
            </Link>{" "}
            and which did not, instead of relying on what the company says about itself.
          </p>
        </div>
      </div>
    </section>
  );
}
