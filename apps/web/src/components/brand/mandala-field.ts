/**
 * The Litmus mark: a centre-point mandala drawn as a density field. Every pixel gets an ink density in
 * [0, 1]; the caller compares it with an ordered-dither threshold (8x8 Bayer) to get ink or no ink.
 * Lines are density 1 (crisp), shaded petals are a gradient (the halftone).
 *
 * Eight-fold symmetry around one point. Read from the centre out:
 *   the point (the claim) · eight petals (the rules, solid at the root, thinning as they are pushed)
 *   · eight dots between them · a ring · sixteen dots (the attempts) · a ring and a soft
 *   halo (the record that builds up around it).
 *
 * `t` is time in ms. In "still" mode time is ignored, so the same field gives the static logo.
 */
export type MarkMode = "still" | "breathe" | "load";

const TAU = Math.PI * 2;

/** Nearest-dot distance for `k` dots on a ring of radius `ringR`, turned by `rot`. Returns [dist, dotIndex]. */
function ringDots(r: number, th: number, k: number, ringR: number, rot: number): [number, number] {
  const step = TAU / k;
  const idx = Math.round((th - rot) / step);
  const phi = th - rot - idx * step;
  const px = r * Math.cos(phi) - ringR;
  const py = r * Math.sin(phi);
  return [Math.hypot(px, py), ((idx % k) + k) % k];
}

/** x, y in [-1, 1] (y up). Returns ink density in [0, 1]. */
export function markDensity(x: number, y: number, t = 0, mode: MarkMode = "still", bold = false): number {
  const r = Math.hypot(x, y);
  const th = Math.atan2(y, x);
  const moving = mode === "load";
  const a1 = moving ? t * 0.00025 : 0;
  const a2 = moving ? -t * 0.0004 : 0;
  const a3 = moving ? t * 0.00018 : 0;
  // A ripple that leaves the centre and travels out: the whole figure swells a hair as it passes.
  const rr = mode === "still" ? r : r / (1 + 0.03 * Math.sin(t * 0.0021 - r * 5));
  // Line half-width: about 1.7 px on a 160 grid, so lines never break up. `bold` is the small-size mark
  // (favicon, buttons, inline loaders): fat lines and dots, one ring, no halo, so it survives a 32-64 px grid.
  const W = bold ? 0.05 : 0.0105;
  const DOT = 1;

  let d = 0;
  const put = (v: number) => {
    if (v > d) d = v;
  };

  // 1. the point, and a fine ring around it
  if (rr < (bold ? 0.1 : 0.05)) put(1);
  if (!bold && Math.abs(rr - 0.105) < W) put(1);

  // 2. eight petals: solid ink at the root, thinning towards the tip (the halftone gradient)
  const R1 = (bold ? 0.74 : 0.5) * Math.pow(Math.abs(Math.cos(4 * (th - a1))), 0.9);
  if (rr > (bold ? 0.18 : 0.13) && rr < R1) {
    const g = 1 - (rr - 0.13) / Math.max(R1 - 0.13, 1e-3);
    put(bold ? 0.38 + 0.62 * Math.pow(g, 0.7) : 0.1 + 0.9 * Math.pow(g, 0.8));
  }
  if (R1 > 0.15 && Math.abs(rr - R1) < (bold ? 0.04 : W)) put(1);

  // 3. eight dots between the petals, turning against them
  const [dIn] = ringDots(rr, th, 8, bold ? 0.5 : 0.4, a2 + Math.PI / 8);
  if (dIn < (bold ? 0.075 : 0.03)) put(1);

  // 4. a ring
  if (!bold && Math.abs(rr - 0.6) < W) put(1);

  // 5. sixteen dots, all the same size
  const [dist] = ringDots(rr, th, 16, 0.695, a3);
  if (!bold && dist < 0.027 * DOT) put(1);

  // 6. the outer ring, and a soft dithered halo that fades out from it
  if (Math.abs(rr - (bold ? 0.93 : 0.8)) < (bold ? 0.045 : W)) put(1);
  if (!bold && rr > 0.8 && rr < 0.93) put(0.5 * Math.pow(1 - (rr - 0.8) / 0.13, 1.3));
  return d;
}
