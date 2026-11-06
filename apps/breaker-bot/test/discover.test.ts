import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { USDC_TOKEN_ID, X402_NETWORK, type X402Discovery, type X402Resource } from "@defect/shared";
import { pickTarget, type PickOptions } from "../src/discover";
import { HttpGateway } from "../src/gateway";
import { loadWallet } from "../src/config";

const NOW = 1_800_000_000;
const PAY_TO = "0.0.5005";

function item(contestId: number, over: { amount?: string; pool?: string; endTime?: number; network?: string; asset?: string } = {}): X402Resource {
  return {
    resource: `https://api.example/contests/${contestId}/messages`,
    type: "http",
    x402Version: 2,
    description: `Defect contest #${contestId}: one message`,
    mimeType: "application/json",
    accepts: [
      {
        scheme: "exact",
        network: over.network ?? X402_NETWORK,
        asset: over.asset ?? USDC_TOKEN_ID,
        amount: over.amount ?? "50000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { feePayer: "0.0.9185802" },
      },
    ],
    input: {
      method: "POST",
      bodyType: "json",
      bodySchema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 2000 } } },
    },
    metadata: {
      contestId,
      agentName: `Agent ${contestId}`,
      purpose: "Pays invoices.",
      endTime: over.endTime ?? NOW + 900,
      pool: over.pool ?? "2",
      messagePrice: "0.05",
      rules: ["Never sends more than 10 USDC."],
    },
  };
}

const opts: PickOptions = { maxPriceUnits: 100_000n, now: NOW, minSecondsLeft: 120 };
const doc = (...items: X402Resource[]): X402Discovery => ({ x402Version: 2, items });

describe("pickTarget", () => {
  it("picks the largest pool, then the most time left", () => {
    const d = doc(item(1, { pool: "2" }), item(2, { pool: "5", endTime: NOW + 300 }), item(3, { pool: "5", endTime: NOW + 600 }));
    const { target, skipped } = pickTarget(d, opts);
    expect(target).toMatchObject({ contestId: 3, url: "https://api.example/contests/3/messages", payTo: PAY_TO, priceUnits: 50_000n });
    expect(skipped).toEqual([]);
  });

  it("skips endpoints above the price cap, on another network or asset, or about to close", () => {
    const d = doc(
      item(1, { amount: "100001" }),
      item(2, { network: "eip155:84532" }),
      item(3, { asset: "0.0.1" }),
      item(4, { endTime: NOW + 60 }),
    );
    const { target, skipped } = pickTarget(d, opts);
    expect(target).toBeNull();
    expect(skipped.map((s) => s.contestId)).toEqual([1, 2, 3, 4]);
    expect(skipped[0]!.reason).toMatch(/above the cap/);
    expect(skipped[3]!.reason).toMatch(/closes in 60 s/);
  });

  it("restricts to one contest when asked", () => {
    const d = doc(item(1, { pool: "9" }), item(2, { pool: "1" }));
    expect(pickTarget(d, { ...opts, contestId: 2 }).target?.contestId).toBe(2);
    expect(pickTarget(d, { ...opts, contestId: 7 }).target).toBeNull();
  });

  it("returns nothing for an empty document", () => {
    expect(pickTarget(doc(), opts)).toEqual({ target: null, skipped: [] });
  });
});

describe("HttpGateway with a discovered endpoint", () => {
  const wallet = loadWallet("bot", { BOT_HEDERA_ACCOUNT_ID: "0.0.1234", BOT_PRIVATE_KEY: "0x" + "11".repeat(32) });
  const pinned = { contestId: 4, url: "https://elsewhere.example/contests/4/messages", payTo: PAY_TO };
  afterEach(() => vi.unstubAllGlobals());

  it("posts to the discovered URL", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return new Response(JSON.stringify({ reply: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    const gateway = new HttpGateway("http://gw", wallet, 50_000n, null, pinned);
    expect((await gateway.send(4, "hi")).ok).toBe(true);
    expect((await gateway.send(5, "hi")).ok).toBe(true);
    expect(urls).toEqual([pinned.url, "http://gw/contests/5/messages"]);
  });

  /** Answers every request with a 402 asking `payTo` for 0.05 USDC; returns the fetch mock. */
  function stub402(payTo: string) {
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: pinned.url, description: "", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: X402_NETWORK, asset: USDC_TOKEN_ID, amount: "50000", payTo, maxTimeoutSeconds: 60, extra: { feePayer: "0.0.9185802" } }],
    });
    const calls = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "PAYMENT_REQUIRED", message: "" } }), {
          status: 402,
          headers: { "Content-Type": "application/json", "PAYMENT-REQUIRED": header },
        }),
    );
    vi.stubGlobal("fetch", calls);
    return calls;
  }

  it("pays the discovered payee", async () => {
    const calls = stub402(PAY_TO);
    await new HttpGateway("http://gw", wallet, 50_000n, null, pinned).send(4, "hi");
    // The second request is the paid retry: the client signed a payment for the advertised payee.
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("refuses to pay a 402 that names a different payee", async () => {
    const calls = stub402("0.0.6666");
    const out = await new HttpGateway("http://gw", wallet, 50_000n, null, pinned).send(4, "hi");
    expect(out.ok === false && out.code).toBe("PAYMENT_NOT_SENT");
    expect(calls).toHaveBeenCalledTimes(1);
  });
});
