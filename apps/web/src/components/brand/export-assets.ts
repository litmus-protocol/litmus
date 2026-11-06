/**
 * Writes the static logo files into public/brand/ from the same density field the <LitmusMark> component uses:
 *   pnpm exec tsx apps/web/src/components/brand/export-assets.ts
 * Each SVG is one path of pixel runs (crisp edges), so it scales to any size and stays exactly the dithered mark.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markDensity } from "./mandala-field";
import { BAYER } from "../home/DitherBox";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../../public/brand");
mkdirSync(OUT, { recursive: true });

function pixels(N: number, bold: boolean): boolean[][] {
  const c = (i: number) => ((i + 0.5) / N) * 2 - 1;
  return Array.from({ length: N }, (_, iy) =>
    Array.from({ length: N }, (_, ix) => markDensity(c(ix), -c(iy), 0, "still", bold) > BAYER[(iy & 7) * 8 + (ix & 7)]!),
  );
}

function svg(N: number, bold: boolean, fill: string, title: string): string {
  const rows = pixels(N, bold);
  let d = "";
  rows.forEach((row, y) => {
    let x = 0;
    while (x < N) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < N && row[x + w]) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" role="img" aria-label="${title}" shape-rendering="crispEdges"><title>${title}</title><path fill="${fill}" d="${d}"/></svg>\n`;
}

const T = "Litmus Protocol";
writeFileSync(join(OUT, "litmus-mark.svg"), svg(160, false, "#000", T));
writeFileSync(join(OUT, "litmus-mark-light.svg"), svg(160, false, "#fff", T));
writeFileSync(join(OUT, "litmus-mark-small.svg"), svg(64, true, "#000", T));
writeFileSync(join(OUT, "litmus-mark-small-light.svg"), svg(64, true, "#fff", T));

// A PGM of each, for turning into transparent PNGs with ImageMagick.
for (const [name, N, bold] of [["litmus-mark", 160, false], ["litmus-mark-small", 64, true]] as const) {
  const px = Buffer.alloc(N * N);
  pixels(N, bold).forEach((row, y) => row.forEach((on, x) => (px[y * N + x] = on ? 0 : 255)));
  writeFileSync(join(OUT, `${name}.pgm`), Buffer.concat([Buffer.from(`P5\n${N} ${N}\n255\n`), px]));
}
// Favicon set: the bold small mark in white on a black tile (a white mark on transparency would vanish on a light
// browser tab). Next.js serves src/app/icon.svg, apple-icon.png and favicon.ico automatically.
const APP = join(dirname(fileURLToPath(import.meta.url)), "../../app");
const PAD = 4;
const small = pixels(64, true);
let fd = "";
small.forEach((row, y) => {
  let x = 0;
  while (x < 64) {
    if (!row[x]) {
      x++;
      continue;
    }
    let w = 1;
    while (x + w < 64 && row[x + w]) w++;
    fd += `M${x + PAD} ${y + PAD}h${w}v1h-${w}z`;
    x += w;
  }
});
const SIZE = 64 + PAD * 2;
writeFileSync(
  join(APP, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges"><rect width="${SIZE}" height="${SIZE}" fill="#000"/><path fill="#fff" d="${fd}"/></svg>\n`,
);
// PGM of the same tile (ink = white on black), for ImageMagick to turn into apple-icon.png and favicon.ico.
const tile = Buffer.alloc(SIZE * SIZE, 0);
small.forEach((row, y) => row.forEach((on, x) => on && (tile[(y + PAD) * SIZE + x + PAD] = 255)));
writeFileSync(join(OUT, "_favicon.pgm"), Buffer.concat([Buffer.from(`P5\n${SIZE} ${SIZE}\n255\n`), tile]));
console.log("wrote", OUT);
