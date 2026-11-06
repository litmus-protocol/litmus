import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { fromJsonDataUri, getErc8004Addresses, identityRegistryAbi, type Erc8004AgentCard } from "@defect/shared";
import { botAgentCard, registerBotAgent, type AgentClients } from "../src/agent-identity";
import { loadConfig } from "../src/config";

const env = {
  BOT_HEDERA_ACCOUNT_ID: "0.0.1234",
  BOT_PRIVATE_KEY: "0x" + "11".repeat(32),
};
const IDENTITY = "0x00000000000000000000000000000000000000aa" as const;
const cfg = () => loadConfig("bot", env);

describe("botAgentCard", () => {
  it("advertises x402 and has no registrations before registering", () => {
    const card = botAgentCard(cfg(), "https://s");
    expect(card.name).toBe("Defect Breaker Bot");
    expect(card.x402Support).toBe(true);
    expect(card.registrations).toBeUndefined();
    expect(card.services[0]?.endpoint).toBe("https://s");
    expect(card.description).toMatch(/x402/);
  });

  it("includes the registration on an eip155:296 registry", () => {
    const card = botAgentCard(cfg(), "https://s", { agentId: 4, agentRegistry: "eip155:296:" + IDENTITY });
    expect(card.registrations?.[0]?.agentRegistry.startsWith("eip155:296:")).toBe(true);
    expect(card.registrations?.[0]?.agentId).toBe(4);
  });
});

describe("BOT_AGENT_ID config", () => {
  it("parses an integer", () => {
    expect(loadConfig("bot", { ...env, BOT_AGENT_ID: "4" }).agentId).toBe(4);
  });
  it("is null when unset or empty", () => {
    expect(cfg().agentId).toBeNull();
    expect(loadConfig("bot", { ...env, BOT_AGENT_ID: "" }).agentId).toBeNull();
  });
  it("rejects a non-integer", () => {
    expect(() => loadConfig("bot", { ...env, BOT_AGENT_ID: "abc" })).toThrow(/BOT_AGENT_ID/);
    expect(() => loadConfig("bot", { ...env, BOT_AGENT_ID: "1.5" })).toThrow(/BOT_AGENT_ID/);
    expect(() => loadConfig("bot", { ...env, BOT_AGENT_ID: "-2" })).toThrow(/BOT_AGENT_ID/);
  });
});

function fakeClients(agentId: bigint, failSecondWrite = false) {
  const calls: { functionName: string; args: readonly unknown[]; gas?: bigint }[] = [];
  const registered = (): Hex => "0x" + "00".repeat(32) as Hex;
  const clients: AgentClients = {
    identity: IDENTITY,
    walletClient: {
      async writeContract(req) {
        calls.push({ functionName: req.functionName, args: req.args, gas: req.gas });
        if (failSecondWrite && calls.length === 2) throw new Error("rpc timeout");
        return (calls.length === 1 ? "0x" + "a1".repeat(32) : "0x" + "b2".repeat(32)) as Hex;
      },
    },
    publicClient: {
      async waitForTransactionReceipt() {
        const topics = encodeEventTopics({
          abi: identityRegistryAbi,
          eventName: "Registered",
          args: { agentId, owner: "0x00000000000000000000000000000000000000bb" },
        });
        const data = encodeAbiParameters([{ type: "string" }], ["data:x"]);
        return { status: "success" as const, logs: [{ address: IDENTITY.toUpperCase().replace("0X", "0x") as Hex, topics: topics as [Hex, ...Hex[]], data, blockNumber: 1n, blockHash: registered(), transactionHash: registered(), transactionIndex: 0, logIndex: 0, removed: false }] };
      },
    },
  };
  return { clients, calls };
}

describe("registerBotAgent", () => {
  it("registers without registrations, then sets the URI with them", async () => {
    const { clients, calls } = fakeClients(7n);
    const logs: string[] = [];
    const out = await registerBotAgent(cfg(), "https://s", clients, (l) => logs.push(l));
    expect(out.agentId).toBe(7);
    expect(out.txs).toEqual(["0x" + "a1".repeat(32), "0x" + "b2".repeat(32)]);
    expect(calls.map((c) => c.functionName)).toEqual(["register", "setAgentURI"]);
    expect(calls.every((c) => c.gas === 1_500_000n)).toBe(true);

    const first = fromJsonDataUri(calls[0]!.args[0] as string) as Erc8004AgentCard;
    expect(first.registrations).toBeUndefined();
    expect(calls[1]!.args[0]).toBe(7n);
    const second = fromJsonDataUri(calls[1]!.args[1] as string) as Erc8004AgentCard;
    expect(second.registrations).toEqual([{ agentId: 7, agentRegistry: `eip155:296:${IDENTITY}` }]);

    expect(logs).toContain("BOT_AGENT_ID=7");
    expect(logs.some((l) => l.includes("https://hashscan.io/testnet/transaction/0x" + "a1".repeat(32)))).toBe(true);
    expect(logs.some((l) => l.includes("https://hashscan.io/testnet/transaction/0x" + "b2".repeat(32)))).toBe(true);
  });

  it("logs the agent id before setAgentURI and reports it if setAgentURI fails", async () => {
    const { clients } = fakeClients(9n, true);
    const logs: string[] = [];
    const err = await registerBotAgent(cfg(), "https://s", clients, (l) => logs.push(l)).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/agent 9 registered but setAgentURI failed: rpc timeout/);
    expect((err as Error).message).toMatch(/rerun is NOT needed/);
    expect(logs).toContain("BOT_AGENT_ID=9");
    expect(logs.some((l) => l.includes("https://hashscan.io/testnet/transaction/0x" + "a1".repeat(32)))).toBe(true);
  });

  it("ignores Registered events from other contracts", async () => {
    const { clients } = fakeClients(7n);
    const real = clients.publicClient.waitForTransactionReceipt;
    clients.publicClient.waitForTransactionReceipt = async (a) => {
      const r = await real(a);
      return { ...r, logs: r.logs.map((l) => ({ ...l, address: "0x00000000000000000000000000000000000000cc" as Hex })) };
    };
    await expect(registerBotAgent(cfg(), "https://s", clients, () => {})).rejects.toThrow(/no Registered event/);
  });

  it.runIf(getErc8004Addresses() === null)("fails clearly when the registries are not deployed", async () => {
    await expect(registerBotAgent(cfg(), "https://s")).rejects.toThrow(/ERC-8004 registries are not deployed/);
  });
});
