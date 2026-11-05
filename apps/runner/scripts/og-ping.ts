// P3 acceptance check: one chat completion WITH the four tool definitions and the prompt
// "What is your vault balance?". Prints the tool calls and the 0G request id (build plan §14 P3).
import { DEFAULT_MODEL, TOOL_NAMES, OG_ROUTER_MAINNET } from "@defect/shared";
import { OpenAiCompatibleClient, isZeroGEndpoint } from "../src/llm";
import { TOOL_DEFINITIONS } from "../src/tools";

const baseUrl = process.env.OG_ROUTER_BASE_URL ?? OG_ROUTER_MAINNET;
const apiKey = process.env.OG_API_KEY;
const model = (process.env.RUNNER_ALLOWED_MODELS ?? DEFAULT_MODEL).split(",")[0]!.trim();
if (!apiKey) {
  console.error("OG_API_KEY is not set. Put an sk- key from pc.0g.ai in .env (or any key when pointing at a local model).");
  process.exit(1);
}

const client = new OpenAiCompatibleClient(baseUrl, apiKey, { zeroGExtras: isZeroGEndpoint(baseUrl) });
const started = Date.now();
const res = await client.chat(
  {
    model,
    temperature: 0.3,
    tools: TOOL_NAMES.map((t) => TOOL_DEFINITIONS[t]),
    messages: [
      { role: "system", content: "You are TreasuryBot. Use your tools to answer questions about your vault." },
      { role: "user", content: "What is your vault balance?" },
    ],
  },
  AbortSignal.timeout(60_000),
);

console.log(`endpoint   ${baseUrl}`);
console.log(`model      ${model}`);
console.log(`latency    ${Date.now() - started} ms`);
console.log(`tool calls ${res.toolCalls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ") || "(none)"}`);
console.log(`content    ${res.content ?? "(none)"}`);
if (res.og)
  console.log(
    `0G         request ${res.og.requestId} · provider ${res.og.provider} · cost ${res.og.totalCost} · tee ${res.og.teeVerified}`,
  );
else console.log("0G         no x_0g_trace in the response (not a 0G endpoint, or the field is missing)");

const ok = res.toolCalls.some((t) => t.function.name === "vault_balance");
console.log(ok ? "\nPASS: the model called vault_balance" : "\nFAIL: the model did not call vault_balance");
process.exit(ok ? 0 : 1);
