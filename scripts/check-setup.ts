// Verifies Phase 0: accounts, HBAR, USDC association and balances, the x402 facilitator and the 0G Router.
// Usage: pnpm setup:check   (reads .env; prints a ✓/✗ line per check and exits 1 if a required check fails)
import { createPublicClient, erc20Abi, http } from "viem";
import { hederaTestnet } from "viem/chains";
import {
  DEFAULT_MODEL,
  getMirrorAccount,
  getTokenBalance,
  HEDERA_RPC_TESTNET,
  HEDERA_TESTNET_CHAIN_ID,
  MIRROR_NODE_TESTNET,
  OG_ROUTER_MAINNET,
  USDC_EVM_ADDRESS,
  USDC_TOKEN_ID,
  X402_FACILITATOR_DEFAULT,
  X402_NETWORK,
  formatUsdc,
  toBaseUnits,
} from "@defect/shared";

interface AccountSpec {
  role: string;
  envVar: string;
  needsUsdc: boolean;
  minUsdc?: string;
  optional?: boolean;
}

// Build plan §4.3. BREAKER_BOT is optional: the product runs without the breaker bot (D24).
const ACCOUNTS: AccountSpec[] = [
  { role: "DEPLOYER", envVar: "DEPLOYER_ACCOUNT_ID", needsUsdc: false },
  { role: "OPERATOR", envVar: "OPERATOR_ACCOUNT_ID", needsUsdc: true },
  { role: "RUNNER", envVar: "RUNNER_ACCOUNT_ID", needsUsdc: false },
  { role: "TREASURY", envVar: "TREASURY_ACCOUNT_ID", needsUsdc: true },
  { role: "WARDEN_DEMO", envVar: "WARDEN_DEMO_ACCOUNT_ID", needsUsdc: true, minUsdc: "200" },
  { role: "BREAKER_HUMAN", envVar: "BREAKER_HUMAN_ACCOUNT_ID", needsUsdc: true, minUsdc: "10" },
  { role: "BREAKER_BOT", envVar: "BOT_HEDERA_ACCOUNT_ID", needsUsdc: true, minUsdc: "10", optional: true },
];

const mirrorNodeUrl = process.env.MIRROR_NODE_URL ?? MIRROR_NODE_TESTNET;
let failures = 0;

function report(ok: boolean, label: string, detail: string, optional = false) {
  const mark = ok ? "✓" : optional ? "–" : "✗";
  if (!ok && !optional) failures++;
  console.log(`${mark} ${label.padEnd(34)} ${detail}`);
}

async function checkAccount(spec: AccountSpec) {
  const id = process.env[spec.envVar];
  const label = `${spec.role}${spec.optional ? " (optional)" : ""}`;
  if (!id) return report(false, label, `${spec.envVar} not set`, spec.optional);
  try {
    const acct = await getMirrorAccount(id, { mirrorNodeUrl });
    const ecdsa = acct.keyType === "ECDSA_SECP256K1";
    const hbar = Number(acct.hbarTinybars) / 1e8;
    const problems: string[] = [];
    if (!ecdsa) problems.push(`key is ${acct.keyType ?? "missing (hollow account?)"}, needs ECDSA`);
    if (acct.hbarTinybars <= 0n) problems.push("no HBAR");
    let usdcText = "USDC not needed";
    if (spec.needsUsdc) {
      const bal = await getTokenBalance(id, USDC_TOKEN_ID, { mirrorNodeUrl });
      if (bal === null) {
        problems.push("not associated with USDC (pnpm associate " + spec.role.replace("BREAKER_BOT", "BOT") + ")");
        usdcText = "USDC not enabled";
      } else {
        usdcText = `${formatUsdc(bal)} USDC`;
        if (spec.minUsdc && bal < toBaseUnits(spec.minUsdc)) problems.push(`needs at least ${spec.minUsdc} USDC`);
      }
    }
    const summary = `${id} · ${acct.evmAddress || "no EVM address"} · ${hbar.toFixed(2)} HBAR · ${usdcText}`;
    report(problems.length === 0, label, problems.length ? `${summary} → ${problems.join("; ")}` : summary, spec.optional);
  } catch (err) {
    report(false, label, `${id}: ${(err as Error).message}`, spec.optional);
  }
}

async function checkRpc() {
  const client = createPublicClient({ chain: hederaTestnet, transport: http(process.env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET) });
  try {
    const chainId = await client.getChainId();
    report(chainId === HEDERA_TESTNET_CHAIN_ID, "Hedera JSON-RPC relay", `chain id ${chainId}`);
    const symbol = await client.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "symbol" });
    const decimals = await client.readContract({ address: USDC_EVM_ADDRESS, abi: erc20Abi, functionName: "decimals" });
    report(symbol === "USDC" && decimals === 6, "USDC long-zero address", `${USDC_EVM_ADDRESS} → ${symbol}, ${decimals} decimals`);
  } catch (err) {
    report(false, "Hedera JSON-RPC relay", (err as Error).message);
  }
}

async function checkFacilitator() {
  const url = process.env.X402_FACILITATOR_URL ?? X402_FACILITATOR_DEFAULT;
  try {
    const res = await fetch(`${url}/supported`);
    const body = (await res.json()) as { kinds?: { x402Version: number; network: string }[] };
    const ok = !!body.kinds?.some((k) => k.x402Version === 2 && k.network === X402_NETWORK);
    report(ok, "x402 facilitator", `${url} ${ok ? "supports" : "does NOT list"} ${X402_NETWORK} (v2)`);
  } catch (err) {
    report(false, "x402 facilitator", `${url}: ${(err as Error).message}`);
  }
}

async function checkOg() {
  const base = process.env.OG_ROUTER_BASE_URL ?? OG_ROUTER_MAINNET;
  try {
    const res = await fetch(`${base}/models`);
    const body = (await res.json()) as { data?: { id: string; supported_parameters?: string[] }[] };
    const model = body.data?.find((m) => m.id === DEFAULT_MODEL);
    const tools = !!model?.supported_parameters?.includes("tools");
    report(
      !!model && tools,
      "0G Router model",
      `${base}: ${DEFAULT_MODEL} ${model ? (tools ? "listed, supports tools" : "listed, NO tools") : "not listed"}`,
    );
  } catch (err) {
    report(false, "0G Router model", `${base}: ${(err as Error).message}`);
  }
  const key = process.env.OG_API_KEY;
  if (!key) return report(false, "0G API key (runner)", "OG_API_KEY not set");
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 5 }),
    });
    const body = (await res.json()) as { x_0g_trace?: { request_id?: string }; error?: { message?: string } };
    const requestId = body.x_0g_trace?.request_id;
    report(
      res.ok && !!requestId,
      "0G API key (runner)",
      res.ok ? `chat works · request ${requestId ?? "missing id"}` : `HTTP ${res.status} ${body.error?.message ?? ""}`,
    );
  } catch (err) {
    report(false, "0G API key (runner)", (err as Error).message);
  }
}

console.log("Defect Phase 0 setup check\n");
await checkRpc();
for (const spec of ACCOUNTS) await checkAccount(spec);
await checkFacilitator();
await checkOg();
console.log(failures === 0 ? "\nAll required checks passed." : `\n${failures} required check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
