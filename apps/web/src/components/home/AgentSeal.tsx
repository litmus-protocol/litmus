"use client";

import { useMemo } from "react";
import { useScene, type Buf, type Scene } from "./StepArt";

/**
 * A dithered, mirror-symmetric glyph unique to one agent. It is derived from the
 * agent id and owner address, so the same agent always gets the same seal, and it
 * shimmers slowly. Think of it as the agent's face on its public record.
 */
const S = 96;
const COLS = 4; // mirrored to 8 columns
const ROWS = 8;

function hash(str: string): () => number {
  // xmur3 + sfc32, so the same seed always yields the same sequence
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h = Math.imul(h ^ (h >>> 16), 2246822507)) >>> 0;
  let b = (h = Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
  let c = (h ^= h >>> 16) >>> 0;
  let d = 0x9e3779b9;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function AgentSeal({ agentId, owner, className = "" }: { agentId: number; owner: string; className?: string }) {
  const cells = useMemo(() => {
    const rnd = hash(`${agentId}:${owner.toLowerCase()}`);
    return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => (rnd() < 0.55 ? 0.35 + rnd() * 0.65 : 0)));
  }, [agentId, owner]);

  const scene = useMemo<Scene>(
    () => (b: Buf, sec: number) => {
      b.frameRect(3, 3, S - 4, S - 4, 1);
      b.frameRect(5, 5, S - 6, S - 6, 0.6);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const base = cells[r]![c]!;
          if (base === 0) continue;
          const pulse = 0.78 + 0.22 * Math.sin(sec * 1.4 + r * 0.9 + c * 1.3);
          const v = Math.min(1, base * pulse + 0.1);
          const y0 = 9 + r * 10;
          const x0 = 9 + c * 10;
          const x1 = 9 + (7 - c) * 10; // mirrored
          b.rect(x0, y0, x0 + 8, y0 + 8, v);
          b.rect(x1, y0, x1 + 8, y0 + 8, v);
        }
      }
    },
    [cells],
  );

  const ref = useScene(scene, 4, S, S);
  return (
    <canvas
      ref={ref}
      width={S}
      height={S}
      role="img"
      aria-label={`Identity seal for ERC-8004 agent ${agentId}`}
      className={`block aspect-square w-full ${className}`}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
