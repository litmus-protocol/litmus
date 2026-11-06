"use client";

import { useEffect, useRef } from "react";
import { BAYER } from "./DitherBox";

/**
 * Small dithered scenes for the "How Litmus works" cards. Each scene paints
 * values in [0,1] into a W x H grid (1 = full ink); an 8x8 Bayer matrix turns
 * them into pure black dots on transparency, like the cube animations.
 */

const W = 96;
const H = 64;

export type Buf = {
  rect: (x0: number, y0: number, x1: number, y1: number, v: number) => void;
  frameRect: (x0: number, y0: number, x1: number, y1: number, v: number) => void;
  disc: (cx: number, cy: number, r: number, v: number) => void;
  arc: (cx: number, cy: number, r: number, thick: number, a0: number, a1: number, v: number) => void;
  /** knock a hole through whatever is already painted (for marks cut into fills) */
  erase: (x: number, y: number, r: number) => void;
};

export type Scene = (b: Buf, sec: number) => void;

export function useScene(scene: Scene, frozenAt: number, w = W, h = H) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const v = new Float32Array(w * h);
    const set = (x: number, y: number, val: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < w && y < h) v[y * w + x] = Math.max(v[y * W + x]!, val);
    };
    const wipe = (x: number, y: number) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x >= 0 && y >= 0 && x < w && y < h) v[y * w + x] = 0;
    };
    const b: Buf = {
      erase: (x, y, r) => {
        for (let yy = Math.floor(y - r); yy <= y + r; yy++)
          for (let xx = Math.floor(x - r); xx <= x + r; xx++) if ((xx - x) ** 2 + (yy - y) ** 2 <= r * r) wipe(xx, yy);
      },
      rect: (x0, y0, x1, y1, val) => {
        for (let y = Math.ceil(y0); y <= y1; y++) for (let x = Math.ceil(x0); x <= x1; x++) set(x, y, val);
      },
      frameRect: (x0, y0, x1, y1, val) => {
        for (let x = Math.ceil(x0); x <= x1; x++) {
          set(x, y0, val);
          set(x, y1, val);
        }
        for (let y = Math.ceil(y0); y <= y1; y++) {
          set(x0, y, val);
          set(x1, y, val);
        }
      },
      disc: (cx, cy, r, val) => {
        for (let y = Math.floor(cy - r); y <= cy + r; y++)
          for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, val);
      },
      arc: (cx, cy, r, thick, a0, a1, val) => {
        const steps = Math.ceil(r * Math.abs(a1 - a0) * 3);
        for (let s = 0; s <= steps; s++) {
          const a = a0 + ((a1 - a0) * s) / steps;
          for (let k = 0; k < thick; k++) set(cx + Math.cos(a) * (r - k), cy + Math.sin(a) * (r - k), val);
        }
      },
    };

    const frame = (sec: number) => {
      v.fill(0);
      scene(b, sec);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4;
          px[o] = 0;
          px[o + 1] = 0;
          px[o + 2] = 0;
          px[o + 3] = v[y * w + x]! > BAYER[(y & 7) * 8 + (x & 7)]! ? 255 : 0;
        }
      ctx.putImageData(img, 0, 0);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      frame(frozenAt);
      return;
    }

    let raf = 0;
    let last = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    io.observe(canvas);
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || t - last < 40) return;
      last = t;
      frame(t / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [scene, frozenAt, w, h]);

  return ref;
}

export const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- 01 Claim
// A promise is written, a stake drops into a vault, a lock closes over it.

const CYCLE_CLAIM = 6.5;
const VX0 = 56, VX1 = 88, VY0 = 30, VY1 = 60; // vault
const SLOT = 72; // x of the coin slot / shackle centre

const claimScene: Scene = (b, sec) => {
  const p = (sec % CYCLE_CLAIM) / CYCLE_CLAIM;
  const fade = 1 - smooth((p - 0.93) / 0.07);
  const f = (v: number) => v * fade;

  // the promise: three lines write themselves in
  const lines = [28, 22, 15];
  lines.forEach((len, i) => {
    const prog = smooth((p - i * 0.07) / 0.14);
    const end = 6 + len * prog;
    for (let x = 6; x <= end; x += 1) {
      if ((x - 6) % 7 < 5) b.rect(x, 10 + i * 6, x, 11 + i * 6, f(0.95));
    }
  });
  // a bar under the text: the claim being underlined once written
  const ul = smooth((p - 0.2) / 0.08);
  b.rect(6, 31, 6 + 28 * ul, 31, f(0.9));

  // vault body, filling from the bottom as coins land
  const coins = 5;
  let landed = 0;
  for (let i = 0; i < coins; i++) {
    const t0 = 0.26 + i * 0.07;
    const k = (p - t0) / 0.1;
    if (k >= 1) landed++;
    else if (k >= 0) {
      const y = -2 + k * (VY0 + 4);
      b.disc(SLOT, y, 2, f(1));
    }
  }
  const level = (landed / coins) * (VY1 - VY0 - 4);
  b.frameRect(VX0, VY0, VX1, VY1, f(1));
  b.frameRect(VX0 + 1, VY0 + 1, VX1 - 1, VY1 - 1, f(0.8));
  b.rect(VX0 + 3, VY1 - 3 - level, VX1 - 3, VY1 - 3, f(0.5)); // the stake
  b.rect(SLOT - 5, VY0, SLOT + 5, VY0 + 1, 0); // slot gap (no-op on the buffer; kept for clarity)

  // the lock: shackle lifts away, then snaps shut
  const close = smooth((p - 0.66) / 0.1);
  const rise = (1 - close) * 9;
  const cy = VY0 - 1 - rise;
  b.arc(SLOT, cy, 7, 2, Math.PI, Math.PI * 2, f(1));
  b.rect(SLOT - 7, cy, SLOT - 6, VY0 - 1, f(1)); // left leg, always fixed
  if (close > 0.98) b.rect(SLOT + 6, cy, SLOT + 7, VY0 - 1, f(1)); // right leg engages when shut
  // a small latch body on the vault
  b.rect(SLOT - 3, VY0 + 4, SLOT + 3, VY0 + 9, f(close > 0.98 ? 1 : 0.35));
};

export function ClaimArt({ className = "" }: { className?: string }) {
  const ref = useScene(claimScene, 5.2);
  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      role="img"
      aria-label="A promise is written line by line, coins drop into a vault, and a padlock closes over it."
      className={`block aspect-[3/2] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ---------------------------------------------------------------- 02 Doubt
// Doubt is open to everyone and free to nobody: attempts rush a sealed box,
// each one is counted (and paid for) in the tally below. The box holds.

const CYCLE_DOUBT = 7;
const BX = 48, BY = 30, BHX = 10, BHY = 12; // box centre + half sizes
const ATTEMPTS = 11;

const frac = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const doubtScene: Scene = (b, sec) => {
  const p = (sec % CYCLE_DOUBT) / CYCLE_DOUBT;
  const fade = 1 - smooth((p - 0.93) / 0.07);
  const f = (v: number) => v * fade;

  // the sealed box
  b.rect(BX - BHX, BY - BHY, BX + BHX, BY + BHY, f(0.2));
  b.frameRect(BX - BHX, BY - BHY, BX + BHX, BY + BHY, f(1));
  b.frameRect(BX - BHX + 1, BY - BHY + 1, BX + BHX - 1, BY + BHY - 1, f(0.7));
  b.disc(BX, BY, 2, f(1)); // the seal

  let hits = 0;
  for (let i = 0; i < ATTEMPTS; i++) {
    const start = 0.04 + i * 0.07;
    const fly = 0.12;
    const theta = (i / ATTEMPTS) * Math.PI * 2 + frac(i, 1) * 0.5;
    const dx = Math.cos(theta), dy = Math.sin(theta);
    // where the ray from the centre meets the box edge
    const tEdge = 1 / Math.max(Math.abs(dx) / BHX, Math.abs(dy) / BHY);
    const ix = BX + dx * (tEdge + 1.5), iy = BY + dy * (tEdge + 1.5);
    const sx = BX + dx * 56, sy = BY + dy * 40;
    const k = (p - start) / fly;
    if (k >= 0 && k < 1) {
      const e = k * k; // accelerates into the box
      const x = sx + (ix - sx) * e, y = sy + (iy - sy) * e;
      b.disc(x, y, 1.4, f(1));
      for (let tr = 1; tr <= 3; tr++) {
        const e2 = Math.max(0, k - tr * 0.07) ** 2;
        b.disc(sx + (ix - sx) * e2, sy + (iy - sy) * e2, 0.6, f(1 - tr * 0.25));
      }
    } else if (k >= 1) {
      hits++;
      const age = (p - start - fly) * CYCLE_DOUBT; // seconds
      if (age < 0.6) {
        const rad = 1 + age * 14;
        const fd = 1 - age / 0.6;
        const steps = Math.max(12, Math.floor(rad * 6));
        for (let s = 0; s < steps; s++) {
          const a = (s / steps) * Math.PI * 2;
          const rx = ix + Math.cos(a) * rad, ry = iy + Math.sin(a) * rad;
          // ripples live outside the box: it is not breached
          if (Math.abs(rx - BX) > BHX + 0.5 || Math.abs(ry - BY) > BHY + 0.5) b.rect(rx, ry, rx, ry, f(fd));
        }
      }
      // the tally: one tick per attempt, popping up as it lands
      const tx = 10 + i * 7.4;
      const h = age < 0.25 ? 8 : 5;
      b.rect(tx, 60 - h, tx + 1, 60, f(1));
    }
  }
  // tally baseline
  b.rect(8, 61, 88, 61, f(0.55));
  void hits;
};

export function DoubtArt({ className = "" }: { className?: string }) {
  const ref = useScene(doubtScene, 5.5);
  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      role="img"
      aria-label="Dots rush a sealed box from every side. Each hit ripples off it and adds a tick to a tally; the box holds."
      className={`block aspect-[3/2] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// -------------------------------------------------------------- 03 Verdict
// A balance. Attempts pile onto one pan and the beam shakes; then the rule
// decides. Alternating cycles: it settles dead level (Held) or tips (Broken).

const CYCLE_VERDICT = 8;

const verdictScene: Scene = (b, sec) => {
  const cyc = Math.floor(sec / CYCLE_VERDICT);
  const p = (sec % CYCLE_VERDICT) / CYCLE_VERDICT;
  const held = cyc % 2 === 0;
  const fade = 1 - smooth((p - 0.94) / 0.06);
  const f = (v: number) => v * fade;

  const PX = 48, PY = 15, L = 33;
  const line = (x0: number, y0: number, x1: number, y1: number, v: number, r = 0.7) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let s = 0; s <= n; s++) b.disc(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, r, v);
  };

  // stand: post, base, pivot
  line(PX, PY, PX - 8, 58, f(1));
  line(PX, PY, PX + 8, 58, f(1));
  b.rect(PX - 16, 58, PX + 16, 59, f(1));
  b.rect(PX - 6, 40, PX + 6, 40, f(0.5));

  // beam angle: wobbling with growing tension, then the verdict
  const attempts = Math.min(9, Math.max(0, Math.floor((p - 0.04) / 0.052)));
  const amp = 0.03 + attempts * 0.011;
  const d = smooth((p - 0.58) / 0.12);
  const wob = Math.sin(sec * 7) * amp * (1 - d);
  const theta = wob + (held ? 0 : 0.36) * d;

  const ca = Math.cos(theta), sa = Math.sin(theta);
  const lx = PX - L * ca, ly = PY - L * sa; // left end
  const rx = PX + L * ca, ry = PY + L * sa; // right end
  line(lx, ly, rx, ry, f(1), 1);
  b.disc(PX, PY, 2.6, f(1));

  const pan = (ex: number, ey: number) => {
    const py = ey + 15;
    line(ex, ey, ex - 8, py, f(0.8), 0.5);
    line(ex, ey, ex + 8, py, f(0.8), 0.5);
    b.rect(ex - 9, py, ex + 9, py + 1, f(1));
    return py;
  };
  const lpy = pan(lx, ly);
  const rpy = pan(rx, ry);

  // left pan: the promise, a solid weight
  b.rect(lx - 4, lpy - 8, lx + 4, lpy - 1, f(0.95));
  b.rect(lx - 2, lpy - 6, lx + 2, lpy - 3, 0);
  b.frameRect(lx - 4, lpy - 8, lx + 4, lpy - 1, f(1));
  b.disc(lx, lpy - 4.5, 1.3, f(1));

  // right pan: attempts, falling in and stacking
  let landed = 0;
  for (let i = 0; i < 9; i++) {
    const t0 = 0.04 + i * 0.052;
    const k = (p - t0) / 0.07;
    if (k >= 1) landed++;
    else if (k >= 0) b.disc(rx + ((i % 3) - 1) * 4, ry - 12 + k * 12, 1.5, f(1));
  }
  for (let j = 0; j < landed; j++) {
    b.disc(rx - 4 + (j % 3) * 4, rpy - 3 - Math.floor(j / 3) * 4, 1.6, f(1));
  }

  // the rule's mark: level guide + lock when Held
  if (held && d > 0.8) {
    for (let x = 6; x <= 90; x += 4) b.rect(x, PY, x + 1, PY, f(0.6 * d));
    b.disc(PX, PY, 4, f(0.7 * d));
    b.disc(PX, PY, 2.6, f(1));
  }
};

export function VerdictArt({ className = "" }: { className?: string }) {
  const ref = useScene(verdictScene, 5.6);
  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      role="img"
      aria-label="A balance scale. Attempts pile onto one pan and the beam shakes, then it either settles level or tips."
      className={`block aspect-[3/2] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ------------------------------------------------- shared bits for 04 / 05

const WW = 144; // half-width cards (04a, 04b)
const HW = 48;
const WL = 320; // full-width strip (05)
const HL = 48;

const polyline = (b: Buf, pts: [number, number][], v: number, upTo = 1, r = 0.7) => {
  const segs = pts.length - 1;
  const total = Math.max(0, Math.min(1, upTo)) * segs;
  for (let i = 0; i < segs; i++) {
    const t = Math.max(0, Math.min(1, total - i));
    if (t <= 0) break;
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2 * t);
    for (let s = 0; s <= n; s++) b.disc(x0 + ((x1 - x0) * t * s) / n, y0 + ((y1 - y0) * t * s) / n, r, v);
  }
};

const ring = (b: Buf, cx: number, cy: number, rad: number, v: number) => {
  const steps = Math.max(12, Math.floor(rad * 7));
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * Math.PI * 2;
    b.disc(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 0.6, v);
  }
};

const fr = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ----------------------------------------------------------- 04a Broken
// Two attempts bounce off. The third cracks the box; the stake arcs out to
// the breaker's pile.

const CYCLE_BROKEN = 7.5;
const BKX = 30, BKY = 24, BKHX = 12, BKHY = 14; // box
const PERSON = 124; // breaker x

const brokenScene: Scene = (b, sec) => {
  const p = (sec % CYCLE_BROKEN) / CYCLE_BROKEN;
  const fade = 1 - smooth((p - 0.94) / 0.06);
  const f = (v: number) => v * fade;
  const SHATTER = 0.4;

  // breaker: head + shoulders
  b.disc(PERSON, 20, 3.5, f(1));
  b.arc(PERSON, 38, 9, 3, Math.PI, Math.PI * 2, f(1));
  b.rect(PERSON - 9, 38, PERSON + 9, 39, f(0.9));

  // the box: intact, then fragments
  if (p < SHATTER) {
    b.rect(BKX - BKHX, BKY - BKHY, BKX + BKHX, BKY + BKHY, f(0.2));
    b.frameRect(BKX - BKHX, BKY - BKHY, BKX + BKHX, BKY + BKHY, f(1));
    b.frameRect(BKX - BKHX + 1, BKY - BKHY + 1, BKX + BKHX - 1, BKY + BKHY - 1, f(0.7));
    b.disc(BKX, BKY, 2, f(1));
    // crack, spreading from the point of the third hit
    const ck = smooth((p - 0.27) / 0.12);
    if (ck > 0) {
      polyline(b, [[BKX + BKHX, 20], [BKX + 6, 22], [BKX + 3, 27], [BKX - 2, 25], [BKX - 6, 31], [BKX - 10, 30]], f(1), ck, 0.8);
      polyline(b, [[BKX + 3, 27], [BKX + 5, 34], [BKX + 1, BKY + BKHY]], f(1), ck, 0.8);
    }
  } else {
    const age = (p - SHATTER) * CYCLE_BROKEN;
    const per = 2 * (2 * BKHX + 2 * BKHY);
    for (let i = 0; i < 40; i++) {
      const q = (i / 40) * per;
      let x: number, y: number;
      if (q < 2 * BKHX) { x = BKX - BKHX + q; y = BKY - BKHY; }
      else if (q < 2 * BKHX + 2 * BKHY) { x = BKX + BKHX; y = BKY - BKHY + (q - 2 * BKHX); }
      else if (q < 4 * BKHX + 2 * BKHY) { x = BKX + BKHX - (q - 2 * BKHX - 2 * BKHY); y = BKY + BKHY; }
      else { x = BKX - BKHX; y = BKY + BKHY - (q - 4 * BKHX - 2 * BKHY); }
      const ang = Math.atan2(y - BKY, x - BKX);
      const d = age * (1.5 + fr(i, 1) * 3);
      const life = 1 + fr(i, 2) * 1.2;
      if (age < life) b.rect(x + Math.cos(ang) * d, y + Math.sin(ang) * d, x + Math.cos(ang) * d + 1, y + Math.sin(ang) * d + 1, f(1 - age / life));
    }
  }

  // three attempts fly in from the breaker's side
  for (let i = 0; i < 3; i++) {
    const t0 = 0.03 + i * 0.095;
    const k = (p - t0) / 0.1;
    const tx = BKX + BKHX + 2, ty = i === 2 ? 20 : 22 + i * 4;
    if (k >= 0 && k < 1) {
      const e = k * k;
      const x = PERSON - 12 + (tx - (PERSON - 12)) * e, y = 20 + (ty - 20) * e;
      b.disc(x, y, 1.5, f(1));
      for (let tr = 1; tr <= 3; tr++) {
        const e2 = Math.max(0, k - tr * 0.08) ** 2;
        b.disc(PERSON - 12 + (tx - (PERSON - 12)) * e2, 20 + (ty - 20) * e2, 0.7, f(1 - tr * 0.25));
      }
    } else if (k >= 1 && i < 2) {
      const age = (p - t0 - 0.1) * CYCLE_BROKEN;
      if (age < 0.6) ring(b, tx, ty, 1 + age * 12, f(1 - age / 0.6));
    }
  }

  // the stake: coins arc out and land in the breaker's pile
  for (let j = 0; j < 14; j++) {
    const t0 = SHATTER + 0.02 + j * 0.026;
    const k = (p - t0) / 0.2;
    const tx = 90 + (j % 7) * 3.2, ty = 44 - Math.floor(j / 7) * 3.4;
    if (k >= 1) b.disc(tx, ty, 1.4, f(1));
    else if (k >= 0) {
      const e = smooth(k);
      b.disc(BKX + (tx - BKX) * e, BKY + (ty - BKY) * e - Math.sin(Math.PI * e) * 16, 1.5, f(1));
    }
  }
  b.rect(84, 47, 136, 47, f(0.55));
};

export function BrokenArt({ className = "" }: { className?: string }) {
  const ref = useScene(brokenScene, 6.2, WW, HW);
  return (
    <canvas
      ref={ref}
      width={WW}
      height={HW}
      role="img"
      aria-label="Two attempts bounce off a sealed box. The third cracks it, and the stake bursts out and lands in the breaker's pile."
      className={`block aspect-[3/1] w-full ink-on-inverse ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ------------------------------------------------------------- 04b Held
// Attempts from both sides ripple off. The box fills in solid and a "$" is
// stamped into it: the funds are held.

const CYCLE_HELD = 7.5;
const HX = 72, HY = 22, HHX = 14, HHY = 16;

const heldScene: Scene = (b, sec) => {
  const p = (sec % CYCLE_HELD) / CYCLE_HELD;
  const fade = 1 - smooth((p - 0.94) / 0.06);
  const f = (v: number) => v * fade;

  // attempts: alternate left and right, each rippling off the surface
  for (let i = 0; i < 8; i++) {
    const t0 = 0.03 + i * 0.055;
    const k = (p - t0) / 0.1;
    const side = i % 2 === 0 ? -1 : 1;
    const ty = HY - 10 + fr(i, 3) * 20;
    const sx = HX + side * 68, tx = HX + side * (HHX + 2);
    if (k >= 0 && k < 1) {
      const e = k * k;
      b.disc(sx + (tx - sx) * e, ty, 1.5, f(1));
      for (let tr = 1; tr <= 3; tr++) {
        const e2 = Math.max(0, k - tr * 0.08) ** 2;
        b.disc(sx + (tx - sx) * e2, ty, 0.7, f(1 - tr * 0.25));
      }
    } else if (k >= 1) {
      const age = (p - t0 - 0.1) * CYCLE_HELD;
      if (age < 0.6) {
        const rad = 1 + age * 12;
        const steps = Math.max(12, Math.floor(rad * 6));
        for (let s = 0; s < steps; s++) {
          const a = (s / steps) * Math.PI * 2;
          const rx = tx + Math.cos(a) * rad, ry = ty + Math.sin(a) * rad;
          if (Math.abs(rx - HX) > HHX + 0.5) b.rect(rx, ry, rx, ry, f(1 - age / 0.6));
        }
      }
    }
  }

  // the box: sealed, then filled solid from the bottom
  const fillK = smooth((p - 0.5) / 0.18);
  b.rect(HX - HHX, HY - HHY, HX + HHX, HY + HHY, f(0.2));
  const top = HY + HHY - (2 * HHY) * fillK;
  if (fillK > 0) b.rect(HX - HHX, top, HX + HHX, HY + HHY, f(0.95));
  b.frameRect(HX - HHX, HY - HHY, HX + HHX, HY + HHY, f(1));
  b.frameRect(HX - HHX + 1, HY - HHY + 1, HX + HHX - 1, HY + HHY - 1, f(0.7));
  if (fillK === 0) b.disc(HX, HY, 2, f(1));

  // the mark: a ring and a symbol cut into the fill, stamped on
  const st = smooth((p - 0.7) / 0.07);
  if (st > 0) {
    const r = 11 - (1 - st) * 6;
    for (let s = 0; s < 40; s++) {
      const a = (s / 40) * Math.PI * 2;
      b.erase(HX + Math.cos(a) * r, HY + Math.sin(a) * r, 0.8);
    }
    // first a check (verified), then it turns into a "$" (the funds, held)
    const cut = (pts: [number, number][]) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i]!;
        const [x1, y1] = pts[i + 1]!;
        const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
        for (let q = 0; q <= n; q++) b.erase(HX + x0 + ((x1 - x0) * q) / n, HY + y0 + ((y1 - y0) * q) / n, 0.9);
      }
    };
    if (p < 0.84) {
      cut([[-5, 0], [-1.5, 4], [6, -5]]);
    } else {
      cut([[3.5, -4.5], [1.5, -6.5], [-1.5, -6.5], [-3.5, -4.5], [-3.5, -2], [-1.5, -0.2], [1.5, 0.2], [3.5, 2], [3.5, 4.5], [1.5, 6.5], [-1.5, 6.5], [-3.5, 4.5]]);
      cut([[0, -9], [0, 9]]);
    }
  }

};

export function HeldArt({ className = "" }: { className?: string }) {
  const ref = useScene(heldScene, 6.4, WW, HW);
  return (
    <canvas
      ref={ref}
      width={WW}
      height={HW}
      role="img"
      aria-label="Attempts from both sides ripple off a sealed box. It fills in solid, a check is stamped into it and turns into a dollar sign: the funds are held."
      className={`block aspect-[3/1] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ------------------------------------------------------------ 05 Record
// A chain of sealed blocks. A new one forms at the end, its hash fills in,
// it links on and is sealed; then the chain slides along.

const CYCLE_RECORD = 8;
const BLK = 24; // block pitch
const BS = 14; // block size

const recordScene: Scene = (b, sec) => {
  const cyc = Math.floor(sec / CYCLE_RECORD);
  const p = (sec % CYCLE_RECORD) / CYCLE_RECORD;
  const shift = BLK * smooth((p - 0.88) / 0.1);
  const y0 = 17;

  for (let j = 0; j <= 13; j++) {
    const x = 12 + j * BLK - shift;
    const seed = cyc + j;
    if (j < 11) {
      // sealed
      b.rect(x, y0, x + BS, y0 + BS, 0.18 + 0.5 * fr(seed, 7));
      b.frameRect(x, y0, x + BS, y0 + BS, 1);
      b.frameRect(x + 1, y0 + 1, x + BS - 1, y0 + BS - 1, 0.7);
      if (j > 0) b.rect(x - (BLK - BS), y0 + BS / 2, x, y0 + BS / 2, 1);
    } else if (j === 11) {
      // the new block: pending -> hashing -> linked -> sealed
      const pend = smooth((p - 0.08) / 0.1);
      const hash = smooth((p - 0.3) / 0.25);
      const link = smooth((p - 0.58) / 0.08);
      const seal = smooth((p - 0.7) / 0.08);
      if (pend > 0) {
        // dotted outline while pending
        for (let t = 0; t <= BS; t += 2) {
          b.rect(x + t, y0, x + t, y0, pend);
          b.rect(x + t, y0 + BS, x + t, y0 + BS, pend);
          b.rect(x, y0 + t, x, y0 + t, pend);
          b.rect(x + BS, y0 + t, x + BS, y0 + t, pend);
        }
      }
      if (hash > 0) b.rect(x + 1, y0 + 1, x + 1 + (BS - 2) * hash, y0 + BS - 1, 0.18 + 0.5 * fr(seed, 7));
      if (link > 0) b.rect(x - (BLK - BS), y0 + BS / 2, x - (BLK - BS) + (BLK - BS) * link, y0 + BS / 2, 1);
      if (seal > 0) {
        b.frameRect(x, y0, x + BS, y0 + BS, seal);
        b.frameRect(x + 1, y0 + 1, x + BS - 1, y0 + BS - 1, 0.7 * seal);
        // a check cut into the block: verified
        if (seal > 0.9) {
          for (let s = 0; s <= 8; s++) b.erase(x + 3 + (s * 3) / 8 * 1, y0 + 8 + (s * 3) / 8, 0.8);
          for (let s = 0; s <= 10; s++) b.erase(x + 6 + (s * 5) / 10, y0 + 11 - (s * 6) / 10, 0.8);
        }
      }
    } else if (j === 12) {
      // the next, faint, waiting in the wings
      for (let t = 0; t <= BS; t += 3) {
        b.rect(x + t, y0, x + t, y0, 0.45);
        b.rect(x + t, y0 + BS, x + t, y0 + BS, 0.45);
      }
    }
  }
};

export function RecordArt({ className = "" }: { className?: string }) {
  const ref = useScene(recordScene, 7, WL, HL);
  return (
    <canvas
      ref={ref}
      width={WL}
      height={HL}
      role="img"
      aria-label="A chain of sealed blocks. A new block forms at the end, its hash fills in, it links on and is sealed, then the chain slides along."
      className={`block aspect-[20/3] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
