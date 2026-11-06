"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { LitmusMark } from "../brand/LitmusMark";

/**
 * The Held certificate as shown on the site: a black card with the Litmus medallion, the facts running round its rim
 * as a sentence, the agent's name, and a prompt slip with a real attack and REFUSED. It tilts in 3D under the cursor,
 * each layer at its own depth, with a highlight that follows the pointer (and a slow idle sway otherwise).
 *
 * This is the site's own rendering of the data the certificate NFT carries; the NFT's on-chain image is made by the
 * contract. Under `prefers-reduced-motion` the card stays flat and still.
 */
export interface HeldCertificateProps {
  contestId: number;
  agentName: string;
  /** ERC-8004 agent id, when the Warden linked one. */
  agentId: number | null;
  model: string;
  /** Attacks (paid messages) the agent refused. */
  attacks: number;
  timeTested: string;
  /** The attack to quote on the slip; null shows the counts instead. */
  attack: string | null;
}

const W = 340;
const H = 425;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const px: CSSProperties = { fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" };
const layer: CSSProperties = { position: "absolute", transformStyle: "preserve-3d", willChange: "transform" };
const par = (z: number, k: number) => `translate3d(calc((var(--px) - .5) * ${-k}px), calc((var(--py) - .5) * ${-k}px), ${z}px)`;

export function HeldCertificate({ contestId, agentName, agentId, model, attacks, timeTested, attack }: HeldCertificateProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const pathId = `rim-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // Fit the fixed 340 x 425 design into narrow columns.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 3D tilt: the pointer sets a target, the card eases towards it; without a pointer it sways gently.
  useEffect(() => {
    const st = stage.current;
    const cd = card.current;
    if (!st || !cd || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let x = 0.5, y = 0.5, tx = 0.5, ty = 0.5, hover = false, raf = 0;
    const move = (e: PointerEvent) => {
      const r = st.getBoundingClientRect();
      tx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      ty = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      hover = true;
      cd.dataset.hover = "1";
    };
    const leave = () => {
      hover = false;
      delete cd.dataset.hover;
    };
    st.addEventListener("pointermove", move);
    st.addEventListener("pointerleave", leave);
    const tick = (t: number) => {
      const ax = hover ? tx : Math.sin(t / 2600) * 0.18 + 0.5;
      const ay = hover ? ty : Math.cos(t / 3100) * 0.14 + 0.5;
      x += (ax - x) * 0.12;
      y += (ay - y) * 0.12;
      const amp = hover ? 1 : 0.28;
      cd.style.transform = `rotateX(${(0.5 - y) * 24 * amp}deg) rotateY(${(x - 0.5) * 30 * amp}deg) scale(${hover ? 1.035 : 1})`;
      cd.style.setProperty("--px", x.toFixed(3));
      cd.style.setProperty("--py", y.toFixed(3));
      cd.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
      cd.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      st.removeEventListener("pointermove", move);
      st.removeEventListener("pointerleave", leave);
    };
  }, []);

  const name = clip(agentName, 18);
  const rim = `AGENT ${name}${agentId !== null ? ` Nº ${agentId}` : ""} · MODEL ${clip(model, 14)} · ${plural(attacks, "ATTACK")} REFUSED · RUN ON 0G · AUDITED BY CHAINLINK · SEALED ON HEDERA · `.toUpperCase();
  const quote = attack ? `> ${attack.replace(/\s+/g, " ").trim()}` : `> ${plural(attacks, "attack")} · ${timeTested}`;
  const label = `Litmus certified: ${agentName}${agentId !== null ? `, agent ${agentId}` : ""} survived ${plural(attacks, "attack")} over ${timeTested}. Contest ${contestId}.`;

  return (
    <div ref={wrap} className="w-full max-w-[340px]" style={{ height: H * scale }}>
      <div
        ref={stage}
        role="img"
        aria-label={label}
        style={{ width: W, height: H, perspective: 1000, position: "relative", touchAction: "pan-y", transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        <div ref={card} className="mono" style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d", willChange: "transform", ["--px" as string]: 0.5, ["--py" as string]: 0.5, ["--mx" as string]: "50%", ["--my" as string]: "50%" }}>
          {/* depth shadow */}
          <div style={{ position: "absolute", inset: 14, background: "rgba(0,0,0,.45)", filter: "blur(26px)", opacity: 0.55, transform: "translateZ(-40px) translate(calc((var(--px) - .5) * -26px), calc(8px + (var(--py) - .5) * -18px))" }} />
          <div style={{ position: "absolute", inset: 0, overflow: "hidden", transformStyle: "preserve-3d", background: "#0b0b0c", color: "#fff" }}>
            <div style={{ ...layer, inset: 12, border: "1px solid rgba(255,255,255,.2)" }} />
            <div style={{ ...layer, ...px, left: 0, right: 0, top: 26, textAlign: "center", fontSize: 10.5, opacity: 0.9, transform: "translateZ(30px)" }}>Litmus certified</div>

            <div style={{ ...layer, left: "50%", top: 44, width: 236, height: 236, marginLeft: -118 }}>
              <div style={{ ...layer, inset: 0, transform: "translateZ(10px) rotate(calc((var(--px) - .5) * 34deg))" }}>
                <svg viewBox="0 0 252 252" style={{ width: "100%", height: "100%", overflow: "visible", display: "block" }} aria-hidden>
                  <defs>
                    <path id={pathId} d="M126,126 m-112,0 a112,112 0 1,1 224,0 a112,112 0 1,1 -224,0" />
                  </defs>
                  <circle cx="126" cy="126" r="124" fill="none" stroke="#fff" strokeOpacity=".5" />
                  <circle cx="126" cy="126" r="98" fill="none" stroke="#fff" strokeOpacity=".28" />
                  <text fontFamily="inherit" fontWeight={700} fontSize={10} fill="#fff">
                    <textPath href={`#${pathId}`} textLength={700} lengthAdjust="spacing">
                      {rim}
                    </textPath>
                  </text>
                </svg>
              </div>
              <div style={{ ...layer, left: "50%", top: "50%", width: 140, height: 140, margin: "-70px 0 0 -70px", transform: par(50, 12) }}>
                <LitmusMark grid={144} label="" className="w-[140px] h-[140px] text-white" />
              </div>
            </div>

            <div style={{ ...layer, left: 24, right: 24, top: 288, textAlign: "center", transform: "translateZ(30px)" }}>
              <div style={{ fontFamily: "var(--font-sans)", fontWeight: 900, fontSize: 25, lineHeight: 1, letterSpacing: "-0.012em" }}>{clip(agentName, 20)}</div>
              <div style={{ ...px, fontSize: 10, marginTop: 8, opacity: 0.8 }}>
                Held · survived {plural(attacks, "attack")}
              </div>
            </div>

            <div style={{ ...layer, ...px, left: 24, right: 24, bottom: 24, border: "1px solid rgba(255,255,255,.28)", padding: "9px 11px", fontSize: 9.5, lineHeight: 1.65, transform: "translateZ(18px)", background: "rgba(255,255,255,.04)" }}>
              <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.07em" }}>{quote}</div>
              <div style={{ letterSpacing: "0.07em" }}>
                &lt; REFUSED
                <span aria-hidden style={{ display: "inline-block", width: "0.55em", height: "1em", background: "#fff", verticalAlign: "-0.12em", marginLeft: 3, animation: "litmus-blink 1s steps(2) infinite" }} />
              </div>
            </div>

            {/* highlight that follows the pointer */}
            <div className="litmus-glare" style={{ position: "absolute", inset: 0, pointerEvents: "none", mixBlendMode: "overlay", background: "radial-gradient(circle at var(--mx) var(--my), rgba(255,255,255,.34), rgba(255,255,255,0) 52%)" }} />
          </div>
        </div>
      </div>
    </div>
  );
}
