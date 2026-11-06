import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { AgentPackage, RunRequest } from "@defect/shared";
import { runAgent } from "../src/agent";
import { FallbackClient, OpenAiCompatibleClient, type ChatRequest, type ModelClient } from "../src/llm";
import { FakeChain, ScriptedModel, tempDir } from "./helpers";
import { HistoryStore } from "../src/stores";

const PIN = "0xD179F4526064846dE9a9E9D93683AF75CB72E503";
const REQ: ChatRequest = { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], tools: [], temperature: 0 };
const OK = { choices: [{ message: { content: "ok" } }], x_0g_trace: { request_id: "r1", provider: PIN, billing: { total_cost: "5" } } };

/** Fake OpenAI SDK: records request headers, answers with the scripted results in order. */
function fakeSdk(results: (unknown | Error)[]) {
  const headers: (Record<string, string> | undefined)[] = [];
  const sdk = {
    chat: {
      completions: {
        create: async (_body: unknown, opts: { headers?: Record<string, string> }) => {
          headers.push(opts.headers);
          const r = results.shift() ?? OK;
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  } as unknown as OpenAI;
  return { sdk, headers };
}
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const client = (sdk: OpenAI, zeroGExtras = true) => new OpenAiCompatibleClient("https://router-api.0g.ai/v1", "k", { zeroGExtras, retryDelayMs: 0 }, sdk);

describe("0G provider pinning", () => {
  it("sends X-0G-Provider-Address when pinned, latency sort otherwise, nothing to non-0G hosts", async () => {
    const f = fakeSdk([]);
    const res = await client(f.sdk).chat({ ...REQ, providerAddress: PIN }, AbortSignal.timeout(1000));
    await client(f.sdk).chat(REQ, AbortSignal.timeout(1000));
    await client(f.sdk, false).chat({ ...REQ, providerAddress: PIN }, AbortSignal.timeout(1000));
    expect(f.headers).toEqual([{ "X-0G-Provider-Address": PIN }, { "X-0G-Provider-Sort": "latency" }, undefined]);
    expect(res.og?.provider).toBe(PIN);
  });

  it("retries a 500 'Failed to select providers' exactly once, and nothing else", async () => {
    const once = fakeSdk([httpError(500, "500 Failed to select providers")]);
    expect((await client(once.sdk).chat(REQ, AbortSignal.timeout(1000))).content).toBe("ok");
    expect(once.headers).toHaveLength(2);

    const twice = fakeSdk([httpError(500, "Failed to select providers"), httpError(500, "Failed to select providers")]);
    await expect(client(twice.sdk).chat(REQ, AbortSignal.timeout(1000))).rejects.toThrow(/select providers/);
    expect(twice.headers).toHaveLength(2);

    const other = fakeSdk([httpError(500, "boom")]);
    await expect(client(other.sdk).chat(REQ, AbortSignal.timeout(1000))).rejects.toThrow("boom");
    expect(other.headers).toHaveLength(1);
  });

  it("never falls back to the non-0G model for a pinned call", async () => {
    const primary: ModelClient = { chat: async () => Promise.reject(httpError(503, "busy")) };
    const fallback = new ScriptedModel([{ content: "fallback" }, { content: "fallback" }]);
    const fc = new FallbackClient(primary, fallback, "local");
    await expect(fc.chat({ ...REQ, providerAddress: PIN }, AbortSignal.timeout(1000))).rejects.toThrow("busy");
    expect((await fc.chat(REQ, AbortSignal.timeout(1000))).content).toBe("fallback");
    expect(fallback.requests).toHaveLength(1);
  });

  it("the agent loop (live and canary) passes the package pin on every model call", async () => {
    const pkg: AgentPackage = { model: "glm-5.3", systemPrompt: "Bot.", tools: ["vault_balance"], temperature: 0, providerAddress: PIN };
    for (const mode of ["live", "canary"] as const) {
      const model = new ScriptedModel([{ content: "hello" }]);
      const req = { contestId: 5, attemptId: "a1", mode, breaker: null, text: "hi", history: [] } as unknown as RunRequest;
      await runAgent(req, pkg, {}, { model, chain: new FakeChain(), history: new HistoryStore(tempDir()) });
      expect(model.requests[0]!.providerAddress).toBe(PIN);
    }
  });
});
