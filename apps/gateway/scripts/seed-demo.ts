// Creates a demo contest end to end as WARDEN_DEMO (build plan P4 task 3):
// POST /drafts → approve USDC → createContest on Hedera → POST /drafts/:id/confirm.
//
//   pnpm --filter @defect/gateway seed:demo [--fixture weak] [--model qwen2.5:7b] [--start-in 120]
//                                           [--pool 2] [--vault 1.5] [--bond 0.4] [--price 0.05] [--agent-id 3]
//
// Fixtures: treasurybot (default), weak, refuser. --model overrides the fixture's model (e.g. a local
// Ollama model while no 0G key is set; it must be in the gateway's RUNNER_ALLOWED_MODELS). The amount
// flags shrink the deposit when the Warden's test USDC is short (bond must stay ≥ 20% of pool).
import { createPublicClient, createWalletClient, decodeEventLog, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FIXTURES,
  HEDERA_RPC_TESTNET,
  USDC_EVM_ADDRESS,
  defectArenaAbi,
  erc20Abi,
  fromBaseUnits,
  hashscanTx,
  withStartTime,
  type DraftResponse,
  type FixtureName,
  type GatewayConfig,
} from "@defect/shared";
import { hederaTestnet } from "../src/chain";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const gateway = (process.env.GATEWAY_URL ?? `http://localhost:${process.env.GATEWAY_PORT ?? "8787"}`).replace(/\/$/, "");
const fixtureName = (arg("fixture") ?? "treasurybot") as FixtureName;
const fixture = FIXTURES[fixtureName];
if (!fixture) throw new Error(`Unknown fixture "${fixtureName}". Use one of: ${Object.keys(FIXTURES).join(", ")}`);
const startIn = Number(arg("start-in") ?? "120");
const rpcUrl = process.env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET;
const pk = env("WARDEN_DEMO_PRIVATE_KEY");
const warden = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
const chain = hederaTestnet(rpcUrl);
const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 1_000 });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: warden });

async function gw<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${gateway}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${body.error?.code}: ${body.error?.message}`);
  return body;
}

async function send(address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[], gas: bigint): Promise<Hex> {
  const { request } = await pub.simulateContract({ account: warden, address, abi: abi as never, functionName: functionName as never, args: args as never });
  // Hedera charges at least 80% of the gas limit, so estimate × 1.5 (capped at the given limit) instead of always paying for it.
  try {
    const est = (await pub.estimateContractGas({ account: warden, address, abi: abi as never, functionName: functionName as never, args: args as never })) * 3n / 2n;
    if (est < gas) gas = est;
  } catch {
    // keep the given limit
  }
  const hash = await wallet.writeContract({ ...(request as object), gas } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hashscanTx(hash)}`);
  return hash;
}

const cfg = await gw<GatewayConfig>("/config");
const sub = withStartTime(fixture, Math.floor(Date.now() / 1000) + startIn - 120);
sub.package = { ...sub.package, model: arg("model") ?? sub.package.model };
sub.pool = arg("pool") ?? sub.pool;
sub.vaultFunding = arg("vault") ?? sub.vaultFunding;
sub.bond = arg("bond") ?? sub.bond;
sub.messagePrice = arg("price") ?? sub.messagePrice;
// ERC-8004: link the contest to an agent the Warden owns, so its result is posted as feedback on that agent.
const agentId = arg("agent-id");
if (agentId !== undefined) {
  sub.card = { ...sub.card, agentId: Number(agentId) };
  sub.warden = warden.address;
}
console.log(`Gateway ${gateway} · ${cfg.deployment} arena ${cfg.arena} · Warden ${warden.address}`);
console.log(`Fixture ${fixtureName}: pool ${sub.pool}, vault ${sub.vaultFunding}, bond ${sub.bond}, price ${sub.messagePrice} USDC, model ${sub.package.model}`);

const draft = await gw<DraftResponse>("/drafts", { method: "POST", body: JSON.stringify(sub) });
console.log(`1. Draft ${draft.draftId}`);

const total = BigInt(draft.approveTotalUnits);
const balance = await pub.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [warden.address] });
if (balance < total) throw new Error(`Warden needs ${fromBaseUnits(total)} USDC, has ${fromBaseUnits(balance)}`);
const allowance = await pub.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [warden.address, cfg.arena] });
if (allowance < total) {
  const h = await send(USDC_EVM_ADDRESS, erc20Abi, "approve", [cfg.arena, total], 1_000_000n);
  console.log(`2. Approved ${fromBaseUnits(total)} USDC · ${hashscanTx(h)}`);
} else {
  console.log("2. Allowance already sufficient");
}

const createHash = await send(
  cfg.arena,
  defectArenaAbi,
  "createContest",
  [
    draft.packageHash,
    draft.canaryHash,
    draft.invariantsOnchain.map((i) => ({ kind: i.kind, secretHash: i.secretHash, maxAmount: BigInt(i.maxAmount) })),
    BigInt(draft.startTime),
    BigInt(draft.messagePriceUnits),
    BigInt(draft.poolUnits),
    BigInt(draft.vaultUnits),
    BigInt(draft.bondUnits),
  ],
  3_000_000n,
);
const receipt = await pub.getTransactionReceipt({ hash: createHash });
let contestId: number | null = null;
for (const log of receipt.logs) {
  try {
    const ev = decodeEventLog({ abi: defectArenaAbi, data: log.data, topics: log.topics });
    if (ev.eventName === "ContestCreated") contestId = Number(ev.args.id);
  } catch {
    // not ours
  }
}
if (contestId === null) throw new Error(`ContestCreated not found in ${hashscanTx(createHash)}`);
console.log(`3. Contest #${contestId} created · ${hashscanTx(createHash)}`);

await gw(`/drafts/${draft.draftId}/confirm`, { method: "POST", body: JSON.stringify({ contestId }) });
console.log(`4. Confirmed and loaded into the runner`);
console.log(`\nContest #${contestId} opens at ${new Date(draft.startTime * 1000).toLocaleTimeString()} and runs ${cfg.windowSeconds}s.`);
console.log(`  ${gateway}/contests/${contestId}`);
