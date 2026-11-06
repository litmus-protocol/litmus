"use client";

import { useEffect, useMemo, useRef } from "react";
import { smoothstep, useScene, type Buf, type Scene } from "./StepArt";

/**
 * The vault that fills as a validation is assembled. `progress` (0..1) is how
 * far through the form the lab is: coins keep dropping in, the stake level
 * rises, and at 1 the shackle snaps shut. `rules` ticks the promises written
 * so far down the left edge.
 */
const S = 96;

export function ForgeArt({ progress, rules, className = "" }: { progress: number; rules: number; className?: string }) {
  const target = useRef({ progress, rules });
  useEffect(() => {
    target.current = { progress, rules };
  }, [progress, rules]);

  const scene = useMemo<Scene>(() => {
    let shown = 0;
    return (b: Buf, sec: number) => {
      shown += (target.current.progress - shown) * 0.08;
      const lvl = Math.max(0, Math.min(1, shown));
      const X0 = 22, X1 = 74, Y0 = 44, Y1 = 90;

      // the promises, as ticks down the left edge
      const n = Math.min(10, target.current.rules);
      for (let i = 0; i < n; i++) b.rect(6, 84 - i * 6, 14, 85 - i * 6, 1);
      b.rect(4, 36, 4, 90, 0.35);

      // vault
      b.frameRect(X0, Y0, X1, Y1, 1);
      b.frameRect(X0 + 1, Y0 + 1, X1 - 1, Y1 - 1, 0.75);
      const h = (Y1 - Y0 - 6) * lvl;
      if (h > 0) b.rect(X0 + 3, Y1 - 3 - h, X1 - 3, Y1 - 3, 0.5);

      // coins keep dropping in while it is being built
      if (lvl < 0.98) {
        for (let k = 0; k < 3; k++) {
          const q = ((sec * 0.55 + k / 3) % 1);
          const y = -2 + q * (Y0 + 2);
          b.disc(48 + Math.sin(k * 2.1) * 3, y, 2.2, 1);
        }
      }

      // the lock closes at the end
      const close = smoothstep((lvl - 0.9) / 0.1);
      const cy = Y0 - 1 - (1 - close) * 12;
      b.arc(48, cy, 10, 3, Math.PI, Math.PI * 2, 1);
      b.rect(38, cy, 39, Y0 - 1, 1);
      if (close > 0.98) b.rect(57, cy, 58, Y0 - 1, 1);
      b.rect(44, Y0 + 5, 52, Y0 + 12, close > 0.98 ? 1 : 0.35);
    };
  }, []);

  const ref = useScene(scene, 6, S, S);
  return (
    <canvas
      ref={ref}
      width={S}
      height={S}
      role="img"
      aria-label="A vault that fills with coins as the validation is assembled, and locks when it is complete."
      className={`block aspect-square w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
