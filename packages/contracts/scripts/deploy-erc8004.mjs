// Deploys the ERC-8004 IdentityRegistry and ReputationRegistry (UUPS proxies) to Hedera testnet and records them in
// packages/shared/src/deployments.json under hederaTestnet.erc8004 = { identity, reputation, block }.
// Usage: node scripts/deploy-erc8004.mjs   (env: DEPLOYER_PRIVATE_KEY, HEDERA_RPC_URL)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const deploymentsPath = resolve(pkg, "../shared/src/deployments.json");

for (const name of ["DEPLOYER_PRIVATE_KEY", "HEDERA_RPC_URL"]) {
  if (!process.env[name]) {
    console.error(`Missing env ${name}`);
    process.exit(1);
  }
}

execFileSync(
  "forge",
  ["script", "script/DeployErc8004.s.sol:DeployErc8004", "--rpc-url", "hedera", "--broadcast", "--slow", "--gas-estimate-multiplier", "200"],
  { cwd: pkg, stdio: "inherit", env: process.env },
);

// forge writes broadcast/<script>/<chainId>/run-latest.json
const run = JSON.parse(readFileSync(resolve(pkg, "broadcast/DeployErc8004.s.sol/296/run-latest.json"), "utf8"));
const proxies = run.transactions.filter((t) => t.transactionType === "CREATE" && t.contractName === "ERC1967Proxy");
if (proxies.length !== 2) {
  console.error(`Expected 2 ERC1967Proxy deployments in the broadcast, found ${proxies.length}`);
  process.exit(1);
}
const [identity, reputation] = proxies; // the script deploys identity first
const receipt = run.receipts.find((r) => r.transactionHash === reputation.hash);

// The reputation registry must point at the identity proxy, otherwise giveFeedback checks the wrong registry.
const linked = execFileSync("cast", ["call", reputation.contractAddress, "getIdentityRegistry()(address)", "--rpc-url", process.env.HEDERA_RPC_URL], { cwd: pkg })
  .toString()
  .trim();
if (linked.toLowerCase() !== identity.contractAddress.toLowerCase()) {
  console.error(`Reputation registry points at ${linked}, expected ${identity.contractAddress}`);
  process.exit(1);
}

const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8"));
deployments.hederaTestnet.erc8004 = {
  identity: identity.contractAddress.toLowerCase(),
  reputation: reputation.contractAddress.toLowerCase(),
  block: Number(BigInt(receipt.blockNumber)),
};
writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
console.log(`ERC-8004 identity ${identity.contractAddress}, reputation ${reputation.contractAddress} (block ${deployments.hederaTestnet.erc8004.block})`);
