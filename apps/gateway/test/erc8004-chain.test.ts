import { describe, expect, it } from "vitest";
import { reputationRegistryAbi, identityRegistryAbi } from "@defect/shared";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, encodeAbiParameters, encodeEventTopics, pad, zeroHash, type Address, type Hex } from "viem";
import { ViemGatewayChain, isNonexistentToken } from "../src/chain";
import { FakeChain, OPERATOR_KEY } from "./helpers";

const IDENTITY = "0x000000000000000000000000000000000008004a" as Address;
const REPUTATION = "0x000000000000000000000000000000000008004b" as Address;
const NONEXISTENT = {
  type: "error",
  name: "ERC721NonexistentToken",
  inputs: [{ name: "tokenId", type: "uint256" }],
} as const;

function revert(abi: readonly unknown[], data: Hex) {
  const cause = new ContractFunctionRevertedError({ abi: abi as never, data, functionName: "ownerOf" });
  return new BaseError("call failed", { cause });
}

function stubClient(chain: ViemGatewayChain) {
  return (chain as unknown as { publicClient: { readContract: (c: never) => Promise<unknown> } }).publicClient as unknown as {
    readContract: (c: any) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

function makeChain(fetchFn?: typeof fetch) {
  return new ViemGatewayChain({
    arena: "0xd03b5ee5f1b69be9b2b3b0eb8ac0f11c594fcf33",
    erc8004: { identity: IDENTITY, reputation: REPUTATION },
    privateKey: OPERATOR_KEY,
    rpcUrl: "http://rpc.invalid",
    mirrorNodeUrl: "https://mirror.test",
    fetchFn,
  });
}

describe("ERC-8004 chain access", () => {
  const nonexistentData = encodeErrorResult({ abi: [NONEXISTENT], errorName: "ERC721NonexistentToken", args: [7n] });

  it("recognises only ERC721NonexistentToken reverts", () => {
    expect(isNonexistentToken(revert([NONEXISTENT], nonexistentData))).toBe(true);
    // Node returned raw revert data and the ABI in use doesn't know the error: still matched by selector.
    expect(isNonexistentToken(revert(identityRegistryAbi, nonexistentData))).toBe(true);
    const other = encodeErrorResult({ abi: [{ type: "error", name: "Other", inputs: [] }], errorName: "Other" });
    expect(isNonexistentToken(revert([{ type: "error", name: "Other", inputs: [] }], other))).toBe(false);
    expect(isNonexistentToken(new Error("network down"))).toBe(false);
  });

  it("agentOwner maps a nonexistent token to null and rethrows everything else", async () => {
    const chain = makeChain();
    const client = (chain as unknown as { publicClient: { readContract: () => Promise<unknown> } }).publicClient;
    client.readContract = async () => {
      throw revert([NONEXISTENT], nonexistentData);
    };
    expect(await chain.agentOwner(7)).toBeNull();
    client.readContract = async () => {
      throw new Error("fetch failed");
    };
    await expect(chain.agentOwner(7)).rejects.toThrow("fetch failed");
    client.readContract = async () => "0x00000000000000000000000000000000000000aa";
    expect(await chain.agentOwner(7)).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("feedbackEvents scans the registry logs unfiltered, keeps only this agent and operator, and follows pagination", async () => {
    const chain = makeChain();
    const op = chain.operatorAddress;
    const OTHER_CLIENT = "0x00000000000000000000000000000000000000bb" as Address;
    const log = (agentId: bigint, client: Address, index: bigint, tag1: string, uri: string) => {
      const topics = encodeEventTopics({
        abi: reputationRegistryAbi,
        eventName: "NewFeedback",
        args: { agentId, clientAddress: client, indexedTag1: tag1 },
      });
      const data = encodeAbiParameters(
        [
          { type: "uint64" },
          { type: "int128" },
          { type: "uint8" },
          { type: "string" },
          { type: "string" },
          { type: "string" },
          { type: "string" },
          { type: "bytes32" },
        ],
        [index, 100n, 0, tag1, "t2", "ep", uri, zeroHash],
      );
      return { data, topics, transaction_hash: `0x${"ab".repeat(32)}` as Hex, timestamp: `1800000000.${index}00000000` };
    };
    // A different registry event (e.g. FeedbackRevoked) shares topic layout but not topic0; it must be skipped.
    const unrelated = { data: "0x" as Hex, topics: [`0x${"cd".repeat(32)}` as Hex], transaction_hash: `0x${"ef".repeat(32)}` as Hex, timestamp: "1800000000.000000000" };
    const pages = [
      { logs: [log(5n, op, 1n, "broken", "ipfs://a"), log(6n, op, 1n, "broken", "ipfs://other-agent"), unrelated], next: "/api/v1/page2" },
      { logs: [log(5n, OTHER_CLIENT, 1n, "broken", "ipfs://other-client"), log(5n, op, 2n, "held", "ipfs://b")], next: null },
    ];
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      const page = pages[urls.length]!;
      urls.push(url);
      return { ok: true, json: async () => ({ logs: page.logs, links: { next: page.next } }) };
    }) as unknown as typeof fetch;
    const events = await makeChain(fetchFn).feedbackEvents(5);
    expect(urls).toEqual([`https://mirror.test/api/v1/contracts/${REPUTATION}/results/logs?order=asc&limit=100`, "https://mirror.test/api/v1/page2"]);
    expect(events.map((e) => [e.index, e.tag1, e.tag2, e.value, e.valueDecimals, e.feedbackURI, e.timestamp])).toEqual([
      [1, "broken", "t2", 100n, 0, "ipfs://a", 1800000000],
      [2, "held", "t2", 100n, 0, "ipfs://b", 1800000000],
    ]);
  });

  it("feedbackEvents throws on a NewFeedback log it cannot decode instead of dropping it", async () => {
    const chain = makeChain();
    const topics = encodeEventTopics({
      abi: reputationRegistryAbi,
      eventName: "NewFeedback",
      args: { agentId: 5n, clientAddress: chain.operatorAddress, indexedTag1: "broken" },
    });
    const fetchFn = (async () => ({
      ok: true,
      json: async () => ({ logs: [{ data: "0x1234", topics, transaction_hash: `0x${"ab".repeat(32)}`, timestamp: "1800000000.000000000" }], links: { next: null } }),
    })) as unknown as typeof fetch;
    await expect(makeChain(fetchFn).feedbackEvents(5)).rejects.toThrow();
  });

  it("agentWallet maps the zero address to null", async () => {
    const chain = makeChain();
    const client = stubClient(chain);
    client.readContract = async () => "0x0000000000000000000000000000000000000000";
    expect(await chain.agentWallet(1)).toBeNull();
    client.readContract = async () => "0x00000000000000000000000000000000000000aa";
    expect(await chain.agentWallet(1)).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("isAgentOperator and agentURI pass through the registry read", async () => {
    const chain = makeChain();
    const client = stubClient(chain);
    const calls: { address: Address; functionName: string; args: unknown[] }[] = [];
    client.readContract = async (c: { address: Address; functionName: string; args: unknown[] }) => {
      calls.push(c);
      return c.functionName === "tokenURI" ? "ipfs://card" : true;
    };
    const spender = "0x00000000000000000000000000000000000000cc" as Address;
    expect(await chain.isAgentOperator(spender, 9)).toBe(true);
    expect(await chain.agentURI(9)).toBe("ipfs://card");
    expect(calls.map((c) => [c.address, c.functionName, c.args])).toEqual([
      [IDENTITY, "isAuthorizedOrOwner", [spender, 9n]],
      [IDENTITY, "tokenURI", [9n]],
    ]);
  });

  it("readDefectFeedback decodes the positional readAllFeedback tuple for the operator", async () => {
    const chain = makeChain();
    const client = stubClient(chain);
    let seen: { address: Address; functionName: string; args: unknown[] } | null = null;
    client.readContract = async (c: { address: Address; functionName: string; args: unknown[] }) => {
      seen = c;
      return [[chain.operatorAddress, chain.operatorAddress], [1n, 2n], [100n, 100n], [0, 0], ["broken", "held"], ["a", "b"], [false, true]];
    };
    expect(await chain.readDefectFeedback(5)).toEqual([
      { index: 1, tag1: "broken", tag2: "a", revoked: false },
      { index: 2, tag1: "held", tag2: "b", revoked: true },
    ]);
    expect(seen).toMatchObject({ address: REPUTATION, functionName: "readAllFeedback", args: [5n, [chain.operatorAddress], "", "", true] });
  });

  it("is inert when no registries are configured", async () => {
    const chain = new ViemGatewayChain({ arena: IDENTITY, privateKey: OPERATOR_KEY, rpcUrl: "http://rpc.invalid", mirrorNodeUrl: "https://mirror.test" });
    expect(chain.erc8004).toBeNull();
    expect(await chain.agentOwner(1)).toBeNull();
    expect(await chain.feedbackEvents(1)).toEqual([]);
    expect(await chain.readDefectFeedback(1)).toEqual([]);
  });
});

describe("FakeChain ERC-8004 registry", () => {
  const AGENT = 3;
  const seed = (fake: FakeChain, over: Partial<{ owner: Address; wallet: Address }> = {}) =>
    fake.agents.set(AGENT, {
      owner: "0x00000000000000000000000000000000000000aa",
      wallet: "0x00000000000000000000000000000000000000aa",
      uri: "ipfs://card",
      operators: new Set(),
      ...over,
    });
  const feedback = { agentId: AGENT, value: 1n, valueDecimals: 0, tag1: "broken", tag2: "x", endpoint: "", feedbackURI: "ipfs://f", feedbackHash: zeroHash };

  it("treats the operator as an operator regardless of address case", async () => {
    const fake = new FakeChain();
    seed(fake);
    fake.agents.get(AGENT)!.operators.add(fake.operatorAddress); // checksummed
    expect(await fake.isAgentOperator(fake.operatorAddress, AGENT)).toBe(true);
    expect(await fake.isAgentOperator(fake.operatorAddress.toLowerCase() as Address, AGENT)).toBe(true);
    await expect(fake.giveFeedback(feedback)).rejects.toThrow("Self-feedback not allowed");
    expect(fake.callsOf("giveFeedback")).toHaveLength(0);
  });

  it("records feedback for a third-party agent and reports it back", async () => {
    const fake = new FakeChain();
    seed(fake);
    await fake.giveFeedback(feedback);
    expect(fake.callsOf("giveFeedback")).toHaveLength(1);
    expect(await fake.readDefectFeedback(AGENT)).toEqual([{ index: 1, tag1: "broken", tag2: "x", revoked: false }]);
    expect((await fake.feedbackEvents(AGENT))[0]).toMatchObject({ index: 1, tag1: "broken", feedbackURI: "ipfs://f" });
  });

  it("maps an unset wallet to null", async () => {
    const fake = new FakeChain();
    seed(fake, { wallet: "0x0000000000000000000000000000000000000000" });
    expect(await fake.agentWallet(AGENT)).toBeNull();
  });

  it("behaves like the real chain when the registries are not configured", async () => {
    const fake = new FakeChain();
    seed(fake);
    fake.erc8004 = null;
    expect(await fake.agentOwner(AGENT)).toBeNull();
    expect(await fake.readDefectFeedback(AGENT)).toEqual([]);
    expect(await fake.feedbackEvents(AGENT)).toEqual([]);
    await expect(fake.agentURI(AGENT)).rejects.toThrow("No ERC-8004 registries configured");
    await expect(fake.giveFeedback(feedback)).rejects.toThrow("No ERC-8004 registries configured");
  });
});
