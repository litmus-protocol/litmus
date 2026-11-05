// Sends one paid message as BREAKER_HUMAN with x402 on Hedera (build plan P4 task 3).
//
//   pnpm --filter @defect/gateway send:message <contestId> "<text>"
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { X402_NETWORK, hashscanTx, type MessageResult } from "@defect/shared";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const [contestId, ...words] = process.argv.slice(2);
const text = words.join(" ");
if (!contestId || !text) {
  console.error('Usage: pnpm --filter @defect/gateway send:message <contestId> "<text>"');
  process.exit(1);
}
const gateway = (process.env.GATEWAY_URL ?? `http://localhost:${process.env.GATEWAY_PORT ?? "8787"}`).replace(/\/$/, "");
const accountId = env("BREAKER_HUMAN_ACCOUNT_ID");
const key = env("BREAKER_HUMAN_PRIVATE_KEY");

const signer = createClientHederaSigner(accountId, PrivateKey.fromStringECDSA(key.replace(/^0x/, "")), { network: X402_NETWORK });
const client = new x402Client().register(X402_NETWORK, new ExactHederaScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);

console.log(`Breaker ${accountId} → contest #${contestId}: "${text}"`);
const started = Date.now();
const res = await pay(`${gateway}/contests/${contestId}/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
});
const body = (await res.json()) as MessageResult & { error?: { code: string; message: string } };
if (!res.ok) {
  console.error(`HTTP ${res.status} ${body.error?.code}: ${body.error?.message}`);
  process.exit(1);
}
console.log(`\nReply (${body.latencyMs} ms): ${body.reply}`);
for (const t of body.toolCalls) {
  console.log(`  tool ${t.name} ${JSON.stringify(t.args)} → ${JSON.stringify(t.result)}${t.txHash ? ` · ${hashscanTx(t.txHash)}` : ""}${t.broke ? " · BROKE A RULE" : ""}`);
}
console.log(`Charged: ${body.charged ? "yes" : "no"} (X-Defect-Charged: ${res.headers.get("X-Defect-Charged")})`);
if (body.settlement) {
  console.log(`Settlement tx: ${body.settlement.txId}\n  ${body.settlement.hashscan}`);
  try {
    const s = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
    console.log(`PAYMENT-RESPONSE: success=${s.success} network=${s.network}`);
  } catch {
    // header missing
  }
}
for (const o of body.og) console.log(`0G request ${o.requestId} · provider ${o.provider} · cost ${o.totalCost} · tee ${o.teeVerified}`);
if (body.contestBroken) console.log("\n*** CONTEST BROKEN ***");
console.log(`(round trip ${Date.now() - started} ms)`);
