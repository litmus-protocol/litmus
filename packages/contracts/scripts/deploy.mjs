// Deploys DefectArena to Hedera testnet and records it in packages/shared/src/deployments.json.
// Usage: node scripts/deploy.mjs <demo|prod>   (env from the repo's .env or the shell)
// demo = 900 s window, prod = 28800 s window (build plan D13).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const deploymentsPath = resolve(pkg, "../shared/src/deployments.json");
const WINDOWS = { demo: 900, prod: 28800 };

const target = process.argv[2];
if (!(target in WINDOWS)) {
  console.error("Usage: node scripts/deploy.mjs <demo|prod>");
  process.exit(1);
}
for (const name of ["DEPLOYER_PRIVATE_KEY", "USDC_ADDRESS", "OPERATOR_ADDRESS", "RUNNER_ADDRESS", "TREASURY_ADDRESS", "HEDERA_RPC_URL"]) {
  if (!process.env[name]) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
}

execFileSync(
  "forge",
  ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", "hedera", "--broadcast", "--slow", "--gas-estimate-multiplier", "200"],
  { cwd: pkg, stdio: "inherit", env: { ...process.env, WINDOW_SECONDS: String(WINDOWS[target]) } },
);

// forge writes broadcast/<script>/<chainId>/run-latest.json
const run = JSON.parse(readFileSync(resolve(pkg, "broadcast/Deploy.s.sol/296/run-latest.json"), "utf8"));
const create = run.transactions.find((t) => t.transactionType === "CREATE" && t.contractName === "DefectArena");
const receipt = run.receipts.find((r) => r.transactionHash === create.hash);

// Associate with USDC on the real network (HTS calls are expensive: fixed 1.5M gas).
const rpc = process.env.HEDERA_RPC_URL;
execFileSync(
  "cast",
  ["send", create.contractAddress, "associateUsdc()", "--rpc-url", rpc, "--private-key", process.env.DEPLOYER_PRIVATE_KEY, "--gas-limit", "1500000"],
  { cwd: pkg, stdio: ["ignore", "ignore", "inherit"] },
);
const associated = execFileSync("cast", ["call", create.contractAddress, "usdcAssociated()(bool)", "--rpc-url", rpc], { cwd: pkg })
  .toString()
  .trim();
if (associated !== "true") {
  console.error(`associateUsdc did not take effect on ${create.contractAddress}`);
  process.exit(1);
}
console.log("usdcAssociated: true");

const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
deployments.hederaTestnet[target] = {
  arena: create.contractAddress.toLowerCase(),
  block: Number(BigInt(receipt.blockNumber)),
};
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
console.log(`Recorded ${target}: ${create.contractAddress} (block ${deployments.hederaTestnet[target].block})`);
