// Writes packages/shared/test/vectors.json: the commit/reveal hash vector shared with the Solidity tests (§8.6 test 20).
// Run once: pnpm vector:write. P2 hard-codes these values in DefectArena.t.sol.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commitment, secretHash } from "@defect/shared";

const secret = "DFT-AAAAAAAAAAAAAAAAAAAAAAAAAA";
const address = "0x1111111111111111111111111111111111111111" as const;
const salt = `0x${"22".repeat(32)}` as const;

const vector = { secret, address, salt, secretHash: secretHash(secret), commitment: commitment(secret, address, salt) };
const path = fileURLToPath(new URL("../packages/shared/test/vectors.json", import.meta.url));
writeFileSync(path, `${JSON.stringify(vector, null, 2)}\n`);
console.log(vector);
