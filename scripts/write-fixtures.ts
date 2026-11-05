// Regenerates /fixtures/*.submission.json from packages/shared/src/fixtures.ts (the source of truth).
// Run: pnpm fixtures:write
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "@defect/shared";

for (const [name, fixture] of Object.entries(FIXTURES)) {
  const path = fileURLToPath(new URL(`../fixtures/${name}.submission.json`, import.meta.url));
  writeFileSync(path, `${JSON.stringify({ ...fixture, startTime: 0 }, null, 2)}\n`);
  console.log(`wrote fixtures/${name}.submission.json`);
}
