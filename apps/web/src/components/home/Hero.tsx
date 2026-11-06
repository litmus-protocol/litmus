"use client";

import Image from "next/image";
import type { Application } from "@splinetool/runtime";
import { SplineScene } from "./SplineScene";

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
