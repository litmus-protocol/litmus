"use client";

import { useEffect, useRef } from "react";
import { BAYER } from "./DitherBox";

/**
 * "The open test": the same cube as DitherBox, now see-through, under
 * attack. Probes stream in and ripple off its surface. Each 9-second cycle
 * ends one of two ways, alternating: it HOLDS (the cube fills in solid, the
 * mark) or it BREAKS (the cube shatters and the stake bursts toward the
 * breaker), then it reassembles and the next cycle starts.
 */

const N = 176;
const WORLD = 1.3;
const HALF = 0.5;
const TILT = 0.5;
const CYCLE = 9; // seconds
const PROBES = 12;

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// deterministic pseudo-random so cycles repeat identically
const rnd = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const L = (() => {
  const v = [-0.5, 0.65, -0.75];
  const n = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((c) => c / n) as [number, number, number];
})();

export function DitherTest({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(N, N);
    const px = img.data;
    const over = new Float32Array(N * N);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const cell = (x: number, y: number) => [Math.round(((x / WORLD + 1) / 2) * (N - 1)), Math.round(((-y / WORLD + 1) / 2) * (N - 1))] as const;
    const put = (x: number, y: number, v: number) => {
      const [cx, cy] = cell(x, y);
      if (cx >= 0 && cy >= 0 && cx < N && cy < N) over[cy * N + cx] = Math.max(over[cy * N + cx]!, v);
    };

    const frame = (t: number) => {
      const sec = t / 1000;
      const cyc = Math.floor(sec / CYCLE);
      const p = (sec % CYCLE) / CYCLE;
      const held = cyc % 2 === 0;
      const a = sec * 0.25;
      const ca = Math.cos(a), sa = Math.sin(a);
      const cb = Math.cos(TILT), sb = Math.sin(TILT);
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

      // --- cube presence ---------------------------------------------
      const BREAK_AT = 0.64;
      let vis = smooth(p / 0.07); // assembles at the start of a cycle
      if (!held) vis *= 1 - smooth((p - BREAK_AT) / 0.1);
      const fill = held ? smooth((p - 0.6) / 0.15) : 0; // Held: fills in solid

      // --- overlay: probes, ripples, debris ----------------------------
      over.fill(0);
      const FLY = 0.07;
      const impactR = 0.6;
      for (let i = 0; i < PROBES; i++) {
        const start = 0.05 + i * 0.043;
        const theta = rnd(i, 1) * Math.PI * 2;
        const dx = Math.cos(theta), dy = Math.sin(theta);
        const k = (p - start) / FLY;
        if (k >= 0 && k < 1) {
          const r = 1.3 - k * (1.3 - impactR);
          for (let tail = 0; tail < 4; tail++) {
            const rr = r + tail * 0.045;
            put(dx * rr, dy * rr, 1 - tail * 0.22);
            put(dx * rr + 0.012, dy * rr, 1 - tail * 0.22);
          }
        } else if (k >= 1) {
          // ripple from the impact point, expanding and fading
          const age = (p - start - FLY) * CYCLE; // seconds
          if (age < 1.1) {
            const ix = dx * impactR, iy = dy * impactR;
            const rad = age * 0.5;
            const fade = 1 - age / 1.1;
            const steps = Math.max(10, Math.floor(rad * 140));
            for (let s = 0; s < steps; s++) {
              const ang = (s / steps) * Math.PI * 2;
              put(ix + Math.cos(ang) * rad, iy + Math.sin(ang) * rad, fade * 0.95);
            }
          }
        }
      }
      if (!held && p > BREAK_AT) {
        // the stake bursts toward the breaker (lower right)
        const age = (p - BREAK_AT) * CYCLE;
        for (let j = 0; j < 64; j++) {
          const ang = 0.55 + (rnd(j, 2) - 0.5) * 1.9;
          const sp = 0.25 + rnd(j, 3) * 0.75;
          const life = 1.2 + rnd(j, 4) * 1.4;
          if (age > life) continue;
          const dist = sp * age * 0.9;
          const x = Math.cos(ang) * dist + (rnd(j, 5) - 0.5) * 0.18;
          const y = -Math.sin(ang) * dist + (rnd(j, 6) - 0.5) * 0.18;
          put(x, y, 1 - age / life);
          put(x + 0.012, y, 1 - age / life);
        }
      }

      // --- raycast the wireframe cube -----------------------------------
      const d = toLocal(0, 0, 1);
      for (let iy = 0; iy < N; iy++) {
        const wy = -((iy / (N - 1)) * 2 - 1) * WORLD;
        for (let ix = 0; ix < N; ix++) {
          const wx = ((ix / (N - 1)) * 2 - 1) * WORLD;
          let v = over[iy * N + ix]!;
          if (vis > 0.001) {
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
            if (tmin < tmax && tmax > 0) {
              const edgeAt = (tt: number) => {
                const q = [o[0]! + d[0]! * tt, o[1]! + d[1]! * tt, o[2]! + d[2]! * tt];
                let near = 0;
                for (let i = 0; i < 3; i++) if (Math.abs(q[i]!) / HALF > 0.93) near++;
                return near >= 2;
              };
              let cv = 0;
              if (edgeAt(tmin)) cv = 1; // front edges
              else if (edgeAt(tmax)) cv = 0.55; // back edges, fainter
              else {
                const n: [number, number, number] = [0, 0, 0];
                n[axis] = -Math.sign(d[axis]!);
                const nw = toWorld(n[0], n[1], n[2]);
                const lam = Math.max(0, nw[0] * L[0] + nw[1] * L[1] + nw[2] * L[2]);
                cv = 0.1 + 0.22 * lam; // sparse, see-through
                cv = cv + (0.95 - 0.7 * lam - cv) * fill; // Held fills it in
              }
              if (fill > 0 && (edgeAt(tmin) || edgeAt(tmax))) cv = 1;
              v = Math.max(v, cv * vis);
            }
          }
          const ink = v > BAYER[(iy & 7) * 8 + (ix & 7)]!;
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
      frame(6500); // a settled "held" frame
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
      aria-label="A see-through cube under attack. Probes fly in and ripple off its surface. It alternately holds and fills in solid, or shatters and pays its stake out to the attacker."
      className={`mx-auto aspect-square w-full max-w-md lg:max-w-none ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
