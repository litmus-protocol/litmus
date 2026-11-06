// Deploys DefectCertificate for one DefectArena deployment on Hedera testnet and records it in
// packages/shared/src/deployments.json (build plan §8.9).
// Usage: node scripts/deploy-certificate.mjs <demo|prod>   (env: DEPLOYER_PRIVATE_KEY, HEDERA_RPC_URL)
// The certificate contract reads the arena's operator in its constructor, so the arena must already be deployed.
// Redeploying an arena with scripts/deploy.mjs drops its certificate entry; deploy a new certificate afterwards.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const deploymentsPath = resolve(pkg, "../shared/src/deployments.json");

const target = process.argv[2];
const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
const entry = deployments.hederaTestnet?.[target];
if (!entry?.arena) {
  console.error(`Usage: node scripts/deploy-certificate.mjs <demo|prod> (no arena recorded for "${target ?? ""}")`);
  process.exit(1);
}
for (const name of ["DEPLOYER_PRIVATE_KEY", "HEDERA_RPC_URL"]) {
  if (!process.env[name]) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
}

const out = execFileSync(
  "forge",
  [
    "create",
    "src/DefectCertificate.sol:DefectCertificate",
    "--rpc-url",
    process.env.HEDERA_RPC_URL,
    "--private-key",
    process.env.DEPLOYER_PRIVATE_KEY,
    "--broadcast",
    "--gas-limit",
    "6000000",
    "--constructor-args",
    entry.arena,
  ],
  { cwd: pkg, stdio: ["ignore", "pipe", "inherit"] },
).toString();

const address = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)?.[1];
const txHash = out.match(/Transaction hash:\s*(0x[0-9a-fA-F]{64})/)?.[1];
if (!address) {
  console.error(out);
  console.error("Could not read the deployed address from forge output.");
  process.exit(1);
}

const arenaOnChain = execFileSync("cast", ["call", address, "arena()(address)", "--rpc-url", process.env.HEDERA_RPC_URL], { cwd: pkg })
  .toString()
  .trim();
if (arenaOnChain.toLowerCase() !== entry.arena.toLowerCase()) {
  console.error(`Certificate points at ${arenaOnChain}, expected ${entry.arena}`);
  process.exit(1);
}

deployments.hederaTestnet[target] = { ...entry, certificate: address.toLowerCase() };
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
console.log(`DefectCertificate (${target}): ${address} → arena ${entry.arena}`);
console.log(`Tx: https://hashscan.io/testnet/transaction/${txHash}`);
console.log(`Recorded in packages/shared/src/deployments.json under hederaTestnet.${target}.certificate`);
