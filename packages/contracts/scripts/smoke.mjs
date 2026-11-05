// Live smoke test of DefectArena on Hedera testnet (demo deployment), exercising the real HTS USDC paths that
// local Foundry tests can't: approve + transferFrom (createContest), transfer (vault send, payouts, refunds).
// Also measures voidContest gas with MAX_REFUNDS_PER_CALL receivers (build plan §8.6 test 21).
// Usage (from packages/contracts): node --env-file=<path to .env> scripts/smoke.mjs
// Spends ~4.4 USDC from WARDEN_DEMO, most of which returns to it; 1 USDC pool goes to BREAKER_HUMAN.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toBytes, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = (k) => {
  if (!process.env[k]) throw new Error(`Missing env ${k}`);
  return process.env[k];
};
const hedera = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [env("HEDERA_RPC_URL")] } },
});
const deployments = JSON.parse(readFileSync(new URL("../../shared/src/deployments.json", import.meta.url), "utf8"));
const arena = deployments.hederaTestnet.demo.arena;
const { abi } = JSON.parse(readFileSync(new URL("../out/DefectArena.sol/DefectArena.json", import.meta.url), "utf8"));
const usdc = env("USDC_ADDRESS");
const erc20 = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const pub = createPublicClient({ chain: hedera, transport: http() });
const wallet = (k) => createWalletClient({ chain: hedera, transport: http(), account: privateKeyToAccount(env(k)) });
const warden = wallet("WARDEN_DEMO_PRIVATE_KEY");
const operator = wallet("OPERATOR_PRIVATE_KEY");
const runner = wallet("RUNNER_PRIVATE_KEY");
const breaker = privateKeyToAccount(env("BREAKER_HUMAN_PRIVATE_KEY")).address;
const hashscan = (h) => `https://hashscan.io/testnet/transaction/${h}`;

async function send(client, label, params) {
  const hash = await client.writeContract(params);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hashscan(hash)}`);
  console.log(`✓ ${label.padEnd(34)} gas ${String(receipt.gasUsed).padStart(9)}  ${hashscan(hash)}`);
  return receipt;
}
const usdcOf = async (a) => pub.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [a] });
const contest = async (id) => pub.readContract({ address: arena, abi, functionName: "getContest", args: [id] });
const fmt = (u) => (Number(u) / 1e6).toFixed(6);

async function createContest(invs) {
  const now = (await pub.getBlock()).timestamp;
  const r = await send(warden, "createContest", {
    address: arena, abi, functionName: "createContest", gas: 3_000_000n,
    args: [keccak256(toBytes("smoke-package")), keccak256(toBytes("smoke-canaries")), invs, now + 20n, 10_000n, 1_000_000n, 1_000_000n, 200_000n],
  });
  const ev = r.logs.map((l) => { try { return decodeEventLog({ abi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "ContestCreated");
  return ev.args.id;
}
async function waitOpen(id) {
  for (;;) {
    if ((await pub.readContract({ address: arena, abi, functionName: "phase", args: [id] })) === 2) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

console.log(`Arena (demo): ${arena}`);
const wardenStart = await usdcOf(warden.account.address);
const breakerStart = await usdcOf(breaker);
console.log(`Warden USDC ${fmt(wardenStart)} · Breaker USDC ${fmt(breakerStart)}`);

await send(warden, "approve 4.4 USDC", { address: usdc, abi: erc20, functionName: "approve", args: [arena, 4_400_000n], gas: 1_000_000n });

// Contest A: a vault send within the limit, then an over-limit send that breaks it.
const a = await createContest([
  { kind: 2, secretHash: "0x" + "00".repeat(32), maxAmount: 500_000n },
  { kind: 3, secretHash: "0x" + "00".repeat(32), maxAmount: 0n },
]);
console.log(`Contest A = #${a}, waiting for it to open…`);
await waitOpen(a);
await send(runner, "vaultSend 0.1 USDC (within limit)", {
  address: arena, abi, functionName: "vaultSend", gas: 3_000_000n,
  args: [a, breaker, 100_000n, breaker, keccak256(toBytes("smoke-a-1"))],
});
await send(runner, "vaultSend 0.6 USDC (over limit)", {
  address: arena, abi, functionName: "vaultSend", gas: 3_000_000n,
  args: [a, breaker, 600_000n, breaker, keccak256(toBytes("smoke-a-2"))],
});
const ca = await contest(a);
if (ca.status !== 2 || ca.winner.toLowerCase() !== breaker.toLowerCase()) throw new Error("Contest A did not break correctly");
console.log(`  Contest A broken ✓ winner ${ca.winner}`);

// Contest B: void with MAX_REFUNDS_PER_CALL refunds (measures gas, test 21).
const b = await createContest([{ kind: 2, secretHash: "0x" + "00".repeat(32), maxAmount: 500_000n }]);
console.log(`Contest B = #${b}`);
const max = await pub.readContract({ address: arena, abi, functionName: "MAX_REFUNDS_PER_CALL" });
const r = await send(operator, `voidContest (${max} refunds)`, {
  address: arena, abi, functionName: "voidContest", gas: 14_000_000n,
  args: [b, Array(Number(max)).fill(breaker), Array(Number(max)).fill(10_000n)],
});
const cb = await contest(b);
if (cb.status !== 4) throw new Error("Contest B did not void");
console.log(`  Contest B void ✓ · voidContest gas ${r.gasUsed} (${r.gasUsed < 12_000_000n ? "under" : "OVER"} 12M budget)`);

const wardenEnd = await usdcOf(warden.account.address);
const breakerEnd = await usdcOf(breaker);
console.log(`Warden USDC ${fmt(wardenStart)} → ${fmt(wardenEnd)} · Breaker USDC ${fmt(breakerStart)} → ${fmt(breakerEnd)}`);
// Expected: breaker +0.1 +0.6 (vault sends) +1.0 (pool) +0.1 (10 refunds) = +1.8; warden -1.8.
const delta = breakerEnd - breakerStart;
if (delta !== 1_800_000n || wardenStart - wardenEnd !== 1_800_000n) throw new Error(`Unexpected balance change: breaker +${fmt(delta)}`);
console.log("All USDC accounted for ✓");
