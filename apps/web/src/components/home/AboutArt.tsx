"use client";

import { smoothstep, useScene, type Buf, type Scene } from "./StepArt";

/**
 * The three ways a break is proven, as small dithered loops for the About page.
 * Same dither and canvas machinery as the step animations.
 */

const CYCLE = 6.5;

const line = (b: Buf, x0: number, y0: number, x1: number, y1: number, v: number, r = 0.7) => {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let s = 0; s <= n; s++) b.disc(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, r, v);
};

const fadeOut = (p: number) => 1 - smoothstep((p - 0.93) / 0.07);

// ------------------------------------------------------- Secret: leak = hash match
// A code sealed in a box. If it ever comes out, it is hashed and compared with
// the fingerprint that was posted on-chain before anyone could try.

const secretScene: Scene = (b, sec) => {
  const p = (sec % CYCLE) / CYCLE;
  const f = fadeOut(p);

  // the box holding the code
  b.frameRect(6, 18, 34, 46, f);
  b.frameRect(7, 19, 33, 45, 0.6 * f);
  const inside = 1 - smoothstep((p - 0.22) / 0.1);
  for (let x = 11; x <= 28; x++) if ((x - 11) % 5 < 3) b.rect(x, 31, x, 33, f * inside);

  // the on-chain fingerprint, fixed from the start
  b.frameRect(60, 14, 90, 30, f);
  for (let y = 17; y <= 27; y += 3) b.rect(64, y, 64 + 8 + ((y * 7) % 14), y, 0.7 * f);
  b.rect(60, 12, 72, 12, 0.5 * f);

  // the code escapes, is hashed, and is compared
  const out = smoothstep((p - 0.22) / 0.25);
  if (out > 0 && p < 0.62) {
    const x0 = 11 + out * 38;
    for (let x = x0; x <= x0 + 17; x++) if (Math.round(x - x0) % 5 < 3) b.rect(x, 31, x, 33, f);
  }
  const hashing = smoothstep((p - 0.5) / 0.15);
  if (p >= 0.5) {
    const hx = 50 + hashing * 6;
    b.rect(hx, 28, hx + 7, 35, f * (0.35 + 0.65 * hashing));
    b.frameRect(hx, 28, hx + 7, 35, f);
  }
  // match: the fingerprint fills in and a check is cut into it
  const match = smoothstep((p - 0.72) / 0.1);
  if (match > 0) {
    b.rect(61, 15, 89, 29, f * 0.9 * match);
    if (match > 0.9) {
      line(b, 69, 22, 73, 26, 0, 1);
      for (let s = 0; s <= 8; s++) b.erase(69 + (s * 4) / 8, 22 + (s * 4) / 8, 0.9);
      for (let s = 0; s <= 12; s++) b.erase(73 + (s * 11) / 12, 26 - (s * 8) / 12, 0.9);
    }
    // the equals sign between them
    b.rect(47, 40, 56, 40, f);
    b.rect(47, 43, 56, 43, f);
  }
};

export function SecretProofArt({ className = "" }: { className?: string }) {
  const ref = useScene(secretScene, 5);
  return (
    <canvas
      ref={ref}
      width={96}
      height={64}
      role="img"
      aria-label="A secret code sealed in a box. If it leaks it is hashed and matched against the fingerprint posted on-chain."
      className={`block aspect-[3/2] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// -------------------------------------------------- Transfer limit: crossing the line
// Coins stack up inside a tube with a limit line. Cross the line and the
// contract sees it in the same transaction.

const limitScene: Scene = (b, sec) => {
  const p = (sec % CYCLE) / CYCLE;
  const f = fadeOut(p);
  const LIMIT_Y = 26;

  // the tube
  b.frameRect(34, 6, 62, 58, f);
  b.frameRect(35, 7, 61, 57, 0.6 * f);
  // the limit line, dashed
  const crossed = p > 0.58;
  for (let x = 28; x <= 68; x += 3) b.rect(x, LIMIT_Y, x + 1, LIMIT_Y, f * (crossed ? 1 : 0.8));
  b.rect(28, LIMIT_Y - 2, 28, LIMIT_Y + 2, f);
  b.rect(68, LIMIT_Y - 2, 68, LIMIT_Y + 2, f);

  // coins stack up from the bottom
  const n = Math.min(10, Math.floor(p * 17));
  for (let i = 0; i < n; i++) {
    const y = 54 - i * 4;
    b.disc(48, y, 3, f);
    if (i % 2 === 0) b.erase(48, y, 1);
  }
  // a coin in flight
  const k = (p * 17) % 1;
  if (n < 10) b.disc(48, 6 + k * (54 - n * 4 - 6), 3, f);

  // crossing the line: the alarm
  if (crossed) {
    const age = (p - 0.58) * CYCLE;
    for (let j = 0; j < 22; j++) {
      const a = (j / 22) * Math.PI * 2;
      const d = age * (6 + (j % 5) * 3);
      if (age < 1.4) b.rect(48 + Math.cos(a) * d, LIMIT_Y + Math.sin(a) * d, 48 + Math.cos(a) * d + 1, LIMIT_Y + Math.sin(a) * d + 1, f * (1 - age / 1.4));
    }
    // the payout, an arrow out to the right
    const out = smoothstep((p - 0.66) / 0.15);
    line(b, 64, LIMIT_Y, 64 + 24 * out, LIMIT_Y, f, 1);
    if (out > 0.9) {
      line(b, 86, LIMIT_Y, 82, LIMIT_Y - 3, f);
      line(b, 86, LIMIT_Y, 82, LIMIT_Y + 3, f);
    }
  }
};

export function LimitProofArt({ className = "" }: { className?: string }) {
  const ref = useScene(limitScene, 5);
  return (
    <canvas
      ref={ref}
      width={96}
      height={64}
      role="img"
      aria-label="Coins stack up inside a tube. Crossing the limit line triggers the payout in the same transaction."
      className={`block aspect-[3/2] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ------------------------------------------------------ Forbidden tool: one touch
// A tool that must never be used. The moment the agent reaches for it, the
// contract records the call.

const toolScene: Scene = (b, sec) => {
  const p = (sec % CYCLE) / CYCLE;
  const f = fadeOut(p);

  // the agent, a small figure on the left
  b.disc(12, 24, 4, f);
  b.arc(12, 42, 10, 3, Math.PI, Math.PI * 2, f);
  b.rect(2, 42, 22, 43, 0.9 * f);

  // the forbidden tool, a locked panel on the right
  const hit = smoothstep((p - 0.5) / 0.06);
  b.frameRect(62, 20, 88, 46, f);
  b.frameRect(63, 21, 87, 45, 0.6 * f);
  b.rect(70, 30, 80, 38, f * (0.5 + 0.4 * hit));
  b.arc(75, 30, 5, 3, Math.PI, Math.PI * 2, f);
  // a slash across it: "never"
  line(b, 62, 46, 88, 20, f * 0.9, 0.8);

  // the reach: an arm extends from the agent towards the tool
  const reach = smoothstep((p - 0.12) / 0.38);
  const ex = 22 + reach * 38;
  line(b, 22, 32, ex, 32, f, 1);
  b.disc(ex, 32, 2.2, f);

  // the touch: the tool lights up, the record is written
  if (hit > 0) {
    const age = (p - 0.5) * CYCLE;
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * Math.PI * 2;
      const d = 4 + age * (7 + (j % 4) * 3);
      if (age < 1.3) b.rect(75 + Math.cos(a) * d, 33 + Math.sin(a) * d, 75 + Math.cos(a) * d + 1, 33 + Math.sin(a) * d + 1, f * (1 - age / 1.3));
    }
    // the log line that proves it
    const w = smoothstep((p - 0.62) / 0.15);
    b.rect(40, 54, 40 + 44 * w, 55, f);
    b.rect(40, 58, 40 + 30 * w, 59, f * 0.7);
  }
};

export function ToolProofArt({ className = "" }: { className?: string }) {
  const ref = useScene(toolScene, 5);
  return (
    <canvas
      ref={ref}
      width={96}
      height={64}
      role="img"
      aria-label="An agent reaches for a tool it must never use. The moment it does, the call is written to the record."
      className={`block aspect-[3/2] w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
