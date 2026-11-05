// Deploys DefectAttestations to Ethereum Sepolia and records it in packages/shared/src/deployments.json (build plan §13.2).
// Usage: node scripts/deploy-attestations.mjs   (env: SEPOLIA_RPC_URL, SEPOLIA_DEPLOYER_KEY; optional CRE_FORWARDER)
// The default forwarder is Chainlink's Sepolia simulation forwarder (MockKeystoneForwarder), which is what
// `cre workflow simulate --broadcast` writes through. A deployed (non-simulated) workflow needs the production
// KeystoneForwarder instead: deploy a second instance with CRE_FORWARDER set, or call setForwarderAddress as owner.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIMULATION_FORWARDER = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const deploymentsPath = resolve(pkg, "../shared/src/deployments.json");

for (const name of ["SEPOLIA_RPC_URL", "SEPOLIA_DEPLOYER_KEY"]) {
  if (!process.env[name]) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
}
const forwarder = process.env.CRE_FORWARDER || SIMULATION_FORWARDER;

const out = execFileSync(
  "forge",
  [
    "create",
    "src/DefectAttestations.sol:DefectAttestations",
    "--rpc-url",
    process.env.SEPOLIA_RPC_URL,
    "--private-key",
    process.env.SEPOLIA_DEPLOYER_KEY,
    "--broadcast",
    "--constructor-args",
    forwarder,
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

const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
deployments.sepolia = { ...(deployments.sepolia ?? {}), attestations: address.toLowerCase(), forwarder: forwarder.toLowerCase() };
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
console.log(`DefectAttestations: ${address} (forwarder ${forwarder})`);
console.log(`Tx: https://sepolia.etherscan.io/tx/${txHash}`);
console.log("Recorded in packages/shared/src/deployments.json under sepolia.attestations");
