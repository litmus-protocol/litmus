import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpGateway } from "../src/gateway";
import { loadWallet } from "../src/config";

const wallet = loadWallet("bot", { BOT_HEDERA_ACCOUNT_ID: "0.0.1234", BOT_PRIVATE_KEY: "0x" + "11".repeat(32) });

/** Stubs global fetch before the gateway is built (it captures fetch at construction); returns the headers of the POST. */
async function sentHeaders(agentId: number | null): Promise<Headers> {
  let headers = new Headers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      return new Response(JSON.stringify({ reply: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  const gateway = new HttpGateway("http://gw", wallet, 1n, agentId);
  const out = await gateway.send(1, "hi");
  expect(out.ok).toBe(true);
  return headers;
}

describe("HttpGateway X-Agent-Id", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the header for agent id 7", async () => {
    expect((await sentHeaders(7)).get("X-Agent-Id")).toBe("7");
  });
  it("sends the header for agent id 0", async () => {
    expect((await sentHeaders(0)).get("X-Agent-Id")).toBe("0");
  });
  it("omits the header when agentId is null", async () => {
    expect((await sentHeaders(null)).has("X-Agent-Id")).toBe(false);
  });
});
