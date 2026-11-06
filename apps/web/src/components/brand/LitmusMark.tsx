"use client";

import { useEffect, useRef } from "react";
import { BAYER } from "../home/DitherBox";
import { markDensity, type MarkMode } from "./mandala-field";

/**
 * The Litmus mark: a dithered, eight-fold mandala around one point. Drawn per pixel on a small grid, the same
 * way as the other dithered art: a density field (mandala-field.ts) against an 8x8 Bayer matrix gives ink or
 * no ink. Ink follows the text colour (`currentColor`), so it is black on light and white on dark, on a
 * transparent background.
 *
 *   mode="still"    the logo. Drawn once, no animation loop.
 *   mode="breathe"  a slow ripple leaves the centre; the shape stays put. Fits a quiet "waiting" state.
 *   mode="load"     the ripple plus the petals and dot rings turning against each other. Fits a spinner.
 *
 * Under `prefers-reduced-motion` every mode shows one still frame. Off-screen it stops drawing.
 * Below `grid` 96 it switches to the bold small-size mark (favicon, buttons, inline loaders).
 *
 *   <LitmusMark className="w-40 text-black dark:text-white" />
 *   <LitmusMark mode="load" grid={64} className="w-10" label="Loading" />
 */
export function LitmusMark({
  mode = "still",
  grid = 160,
  className = "",
  label = "Litmus Protocol",
}: {
  mode?: MarkMode;
  /** Pixels per side of the dither grid. 160 is the full mark; 48-64 gives the bold small mark. */
  grid?: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const N = grid;
    const bold = N < 96;
    const img = ctx.createImageData(N, N);
    const px = img.data;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Ink colour = the element's text colour, read again if the colour scheme changes.
    let rgb: [number, number, number] = [0, 0, 0];
    const readInk = () => {
      const m = getComputedStyle(canvas).color.match(/[\d.]+/g);
      if (m && m.length >= 3) rgb = [Number(m[0]), Number(m[1]), Number(m[2])];
    };
    readInk();
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", readInk);

    // Pixel centres in [-1, 1]; the field is symmetric, so a half-pixel offset keeps it centred.
    const coord = (i: number) => ((i + 0.5) / N) * 2 - 1;
    const xs = Float32Array.from({ length: N }, (_, i) => coord(i));

    const frame = (t: number) => {
      for (let iy = 0; iy < N; iy++) {
        const y = -xs[iy]!;
        for (let ix = 0; ix < N; ix++) {
          const ink = markDensity(xs[ix]!, y, t, mode, bold) > BAYER[(iy & 7) * 8 + (ix & 7)]!;
          const o = (iy * N + ix) * 4;
          px[o] = rgb[0];
          px[o + 1] = rgb[1];
          px[o + 2] = rgb[2];
          px[o + 3] = ink ? 255 : 0;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    // A still frame for "still", and for every mode when motion is reduced (a frame with the ripple mid-way).
    if (mode === "still" || reduced) {
      frame(mode === "still" ? 0 : 6000);
      return () => scheme.removeEventListener("change", readInk);
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
      scheme.removeEventListener("change", readInk);
    };
  }, [mode, grid]);

  return (
    <canvas
      ref={ref}
      width={grid}
      height={grid}
      role="img"
      aria-label={label}
      className={`aspect-square ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}

/** The mark turning, with a caption: for a page or panel that is waiting on data. */
export function LoadingMark({ label = "Loading", className = "" }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={`flex flex-col items-center gap-3 py-16 text-text ${className}`}>
      <LitmusMark mode="load" label={label} className="w-28 sm:w-32" />
      <span className="text-[13px] text-muted">{label}…</span>
    </div>
  );
}
