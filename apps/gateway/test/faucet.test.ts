import { describe, expect, it } from "vitest";
import type { FaucetResponse, GatewayConfig } from "@defect/shared";
import { hbarDecimal, parseHbar } from "../src/services/faucet";
import { NOW, makeEnv, type TestEnv } from "./helpers";

const ADDR = "0xAbCdEf0000000000000000000000000000000001";
const addr = ADDR.toLowerCase();

function post(env: TestEnv, body: unknown) {
  return env.app.request("/faucet", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

async function faucet(env: TestEnv, address = ADDR) {
  const res = await post(env, { address });
  return { status: res.status, body: (await res.json()) as FaucetResponse & { error?: { code: string } } };
}

describe("POST /faucet", () => {
  it("sends HBAR to a new address and asks for association before USDC", async () => {
    const env = makeEnv();
    const { status, body } = await faucet(env);
    expect(status).toBe(200);
    expect(body.accountId).toBeNull();
    expect(body.hbar).toMatchObject({ status: "sent", amount: "5" });
    expect(body.hbar.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.usdc).toEqual({ status: "needs_account", amount: "1", txHash: null });
    expect(env.faucet.sent).toEqual([{ asset: "hbar", to: addr, amount: 500_000_000n }]);
  });

  it("says needs_association for a hollow or unassociated account", async () => {
    const env = makeEnv();
    env.faucet.accounts.set(addr, { accountId: "0.0.9001", hasKey: false, usdcAssociated: true });
    expect((await faucet(env)).body.usdc.status).toBe("needs_association");
    env.faucet.accounts.set(addr, { accountId: "0.0.9001", hasKey: true, usdcAssociated: false });
    expect((await faucet(env)).body.usdc.status).toBe("needs_association");
    expect(env.faucet.sent.filter((s) => s.asset === "usdc")).toHaveLength(0);
  });

  it("sends USDC once the account is complete and associated, then never again", async () => {
    const env = makeEnv();
    await faucet(env);
    env.faucet.accounts.set(addr, { accountId: "0.0.9001", hasKey: true, usdcAssociated: true });
    const second = await faucet(env);
    expect(second.body.accountId).toBe("0.0.9001");
    expect(second.body.hbar.status).toBe("already_sent");
    expect(second.body.usdc).toMatchObject({ status: "sent", amount: "1" });
    const third = await faucet(env, ADDR.toLowerCase());
    expect(third.body.hbar.status).toBe("already_sent");
    expect(third.body.usdc.status).toBe("already_sent");
    expect(third.body.usdc.txHash).toBe(second.body.usdc.txHash);
    expect(env.faucet.sent.map((s) => s.asset)).toEqual(["hbar", "usdc"]);
  });

  it("handles parallel requests for one address with a single transfer", async () => {
    const env = makeEnv();
    const results = await Promise.all([faucet(env), faucet(env), faucet(env)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(env.faucet.sent).toHaveLength(1);
  });

  it("enforces the daily cap across addresses, and frees it after 24 h", async () => {
    const env = makeEnv(); // cap 5
    for (let i = 0; i < 5; i++) expect((await faucet(env, `0x${(i + 1).toString(16).padStart(40, "0")}`)).status).toBe(200);
    const over = await faucet(env, `0x${"9".repeat(40)}`);
    expect(over.status).toBe(429);
    expect(over.body.error?.code).toBe("FAUCET_DAILY_LIMIT");
    env.clock.now = NOW + 86_401;
    expect((await faucet(env, `0x${"9".repeat(40)}`)).status).toBe(200);
  });

  it("reports unavailable when the faucet is out of funds, without using up the address", async () => {
    const env = makeEnv();
    env.faucet.hbar = 0n;
    expect((await faucet(env)).body.hbar.status).toBe("unavailable");
    env.faucet.hbar = 10n ** 12n;
    expect((await faucet(env)).body.hbar.status).toBe("sent");
    env.faucet.accounts.set(addr, { accountId: "0.0.9001", hasKey: true, usdcAssociated: true });
    env.faucet.usdc = 0n;
    expect((await faucet(env)).body.usdc.status).toBe("unavailable");
  });

  it("lets the address retry after a failed transfer", async () => {
    const env = makeEnv();
    env.faucet.fail = true;
    const failed = await faucet(env);
    expect(failed.status).toBe(502);
    expect(failed.body.error?.code).toBe("FAUCET_SEND_FAILED");
    env.faucet.fail = false;
    expect((await faucet(env)).body.hbar.status).toBe("sent");
  });

  it("validates the address", async () => {
    const env = makeEnv();
    for (const body of [{}, { address: "0.0.1234" }, { address: "0x123" }, { address: `0x${"0".repeat(40)}` }]) {
      const res = await post(env, body);
      expect(res.status).toBe(400);
    }
    expect(env.faucet.sent).toHaveLength(0);
  });

  it("is 404 when disabled, and /config says whether it exists", async () => {
    const env = makeEnv();
    const cfg = (await (await env.app.request("/config")).json()) as GatewayConfig;
    expect(cfg.faucet).toEqual({ hbar: "5", usdc: "1" });
    env.ctx.faucet = null;
    expect((await faucet(env)).status).toBe(404);
    expect(((await (await env.app.request("/config")).json()) as GatewayConfig).faucet).toBeNull();
  });
});

describe("faucet amounts", () => {
  it("converts HBAR decimals", () => {
    expect(parseHbar("5")).toBe(500_000_000n);
    expect(parseHbar("0.5")).toBe(50_000_000n);
    expect(hbarDecimal(123_450_000n)).toBe("1.2345");
    expect(() => parseHbar("1.123456789")).toThrow();
  });
});
