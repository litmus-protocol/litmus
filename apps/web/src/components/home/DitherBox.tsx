"use client";

import { useEffect, useRef } from "react";

/**
 * "The black box": a dithered cube turning slowly, stamped SAFE, while probes
 * drift in and dissolve before they touch it. A sealed claim, seen from the
 * outside.
 *
 * Drawn per pixel on a small grid: an analytic ray-vs-box hit gives a shade,
 * an 8x8 Bayer matrix turns the shade into ink or no ink. Ink is pure black on
 * transparency, like the other line art.
 */

const N = 176; // grid cells per side
const WORLD = 1.3; // canvas spans [-WORLD, WORLD] in both axes
const HALF = 0.5; // cube half-size
const TILT = 0.5;
const PROBES = 16;

// 8x8 Bayer thresholds in (0,1)
export const BAYER: number[] = (() => {
  let m = [[0]];
  for (let s = 1; s < 8; s *= 2) {
    const n = m.length;
    const next: number[][] = Array.from({ length: n * 2 }, () => new Array<number>(n * 2).fill(0));
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = m[y]![x]! * 4;
        next[y]![x] = v;
        next[y]![x + n] = v + 2;
        next[y + n]![x] = v + 3;
        next[y + n]![x + n] = v + 1;
      }
    m = next;
  }
  return m.flat().map((v) => (v + 0.5) / 64);
})();

const L = (() => {
  const v = [-0.5, 0.65, -0.75];
  const n = Math.hypot(...(v as [number, number, number]));
  return v.map((c) => c / n) as [number, number, number];
})();

function stampMask(): Uint8Array {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  g.rotate(-0.14);
  g.fillStyle = "#000";
  g.strokeStyle = "#000";
  g.lineWidth = 3;
  g.strokeRect(-27, -13, 54, 26);
  g.font = "900 22px 'Arial Black', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("SAFE", 0, 1);
  const d = g.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) out[i] = d[i * 4 + 3]! > 90 ? 1 : 0;
  return out;
}

export function DitherBox({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(N, N);
    const px = img.data;
    const mask = stampMask();
    const probe = new Float32Array(N * N);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // probes: fixed bearings, staggered phases
    const seeds = Array.from({ length: PROBES }, (_, i) => ({
      theta: (i / PROBES) * Math.PI * 2 + (i % 3) * 0.17,
      phase: (i * 0.61803) % 1,
      speed: 0.16 + (i % 4) * 0.025,
    }));

    const frame = (t: number) => {
      const a = t * 0.00035;
      const ca = Math.cos(a), sa = Math.sin(a);
      const cb = Math.cos(TILT), sb = Math.sin(TILT);
      // R = Ry(a) Rx(b); local = R^T world = Rx(-b) Ry(-a) world
      const toLocal = (x: number, y: number, z: number): [number, number, number] => {
        const x1 = ca * x - sa * z;
        const z1 = sa * x + ca * z;
        return [x1, cb * y + sb * z1, -sb * y + cb * z1];
      };
      const toWorld = (x: number, y: number, z: number): [number, number, number] => {
        const y1 = cb * y - sb * z;
        const z1 = sb * y + cb * z;
        return [ca * x + sa * z1, y1, -sa * x + ca * z1];
      };

      // probes -> alpha buffer
      probe.fill(0);
      const sec = t / 1000;
      for (const p of seeds) {
        const k = (sec * p.speed + p.phase) % 1;
        const r = 1.3 - k * 0.5; // 1.3 -> 0.8
        const fade = r > 1.08 ? 1 : Math.max(0, (r - 0.84) / 0.24);
        const wob = Math.sin(sec * 1.3 + p.theta * 5) * 0.03;
        const x = Math.cos(p.theta) * (r + wob);
        const y = Math.sin(p.theta) * (r + wob);
        const cx = Math.round(((x / WORLD + 1) / 2) * (N - 1));
        const cy = Math.round(((y / WORLD + 1) / 2) * (N - 1));
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const ix = cx + dx, iy = cy + dy;
          if (ix >= 0 && iy >= 0 && ix < N && iy < N) probe[iy * N + ix] = Math.max(probe[iy * N + ix]!, fade);
        }
      }

      // stamp flickers: asserted, then a brief dropout
      const flick = Math.sin(sec * 1.7) > -0.55 ? (Math.sin(sec * 23) > 0.92 ? 0.4 : 1) : 0.15;

      const d = toLocal(0, 0, 1);
      for (let iy = 0; iy < N; iy++) {
        const wy = -((iy / (N - 1)) * 2 - 1) * WORLD;
        for (let ix = 0; ix < N; ix++) {
          const wx = ((ix / (N - 1)) * 2 - 1) * WORLD;
          const o = toLocal(wx, wy, -5);
          let tmin = -Infinity, tmax = Infinity, axis = 0;
          for (let i = 0; i < 3; i++) {
            const di = d[i]!;
            if (Math.abs(di) < 1e-6) {
              if (Math.abs(o[i]!) > HALF) {
                tmax = -Infinity;
                break;
              }
              continue;
            }
            let t1 = (-HALF - o[i]!) / di;
            let t2 = (HALF - o[i]!) / di;
            if (t1 > t2) [t1, t2] = [t2, t1];
            if (t1 > tmin) {
              tmin = t1;
              axis = i;
            }
            if (t2 < tmax) tmax = t2;
          }
          const thr = BAYER[(iy & 7) * 8 + (ix & 7)]!;
          let ink = false;
          if (tmin < tmax && tmax > 0) {
            const n: [number, number, number] = [0, 0, 0];
            n[axis] = -Math.sign(d[axis]!);
            const nw = toWorld(n[0], n[1], n[2]);
            const lam = Math.max(0, nw[0] * L[0] + nw[1] * L[1] + nw[2] * L[2]);
            const pl = [o[0]! + d[0]! * tmin, o[1]! + d[1]! * tmin, o[2]! + d[2]! * tmin];
            const ai = (axis + 1) % 3, aj = (axis + 2) % 3;
            const ui = pl[ai]! / HALF, uj = pl[aj]! / HALF; // [-1,1]
            let density = 0.92 - 0.72 * lam;
            if (Math.max(Math.abs(ui), Math.abs(uj)) > 0.93) density = 1;
            else {
              const mx = Math.min(63, Math.max(0, Math.floor(((ui + 1) / 2) * 64)));
              const my = Math.min(63, Math.max(0, Math.floor(((uj + 1) / 2) * 64)));
              if (mask[my * 64 + mx]) density = 1 - flick * 0.9;
            }
            ink = density > thr;
          } else {
            ink = probe[iy * N + ix]! > thr;
          }
          const o4 = (iy * N + ix) * 4;
          px[o4] = 0;
          px[o4 + 1] = 0;
          px[o4 + 2] = 0;
          px[o4 + 3] = ink ? 255 : 0;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    if (reduced) {
      frame(9000);
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
      if (!visible || t - last < 33) return;
      last = t;
      frame(t);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      width={N}
      height={N}
      role="img"
      aria-label="A sealed black cube stamped SAFE, turning slowly while probes drift toward it and dissolve before they touch it."
      className={`mx-auto aspect-square w-full max-w-md lg:max-w-none ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
