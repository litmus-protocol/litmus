import { describe, expect, it } from "vitest";
import { reputationRegistryAbi, identityRegistryAbi } from "@defect/shared";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, encodeAbiParameters, encodeEventTopics, pad, zeroHash, type Address, type Hex } from "viem";
import { ViemGatewayChain, isNonexistentToken } from "../src/chain";
import { OPERATOR_KEY } from "./helpers";

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

  it("feedbackEvents decodes NewFeedback logs and follows pagination", async () => {
    const chain = makeChain();
    const op = chain.operatorAddress;
    const log = (index: bigint, tag1: string, uri: string) => {
      const topics = encodeEventTopics({
        abi: reputationRegistryAbi,
        eventName: "NewFeedback",
        args: { agentId: 5n, clientAddress: op, indexedTag1: tag1 },
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
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      const first = urls.length === 1;
      return {
        ok: true,
        json: async () => ({
          logs: first ? [log(1n, "broken", "ipfs://a")] : [log(2n, "held", "ipfs://b")],
          links: { next: first ? "/api/v1/page2" : null },
        }),
      };
    }) as unknown as typeof fetch;
    const events = await makeChain(fetchFn).feedbackEvents(5);
    expect(urls[0]).toBe(
      `https://mirror.test/api/v1/contracts/${REPUTATION}/results/logs?topic1=${pad("0x5", { size: 32 })}&topic2=${pad(op, { size: 32 })}&order=asc&limit=100`,
    );
    expect(urls[1]).toBe("https://mirror.test/api/v1/page2");
    expect(events.map((e) => [e.index, e.tag1, e.tag2, e.value, e.valueDecimals, e.feedbackURI, e.timestamp])).toEqual([
      [1, "broken", "t2", 100n, 0, "ipfs://a", 1800000000],
      [2, "held", "t2", 100n, 0, "ipfs://b", 1800000000],
    ]);
  });

  it("is inert when no registries are configured", async () => {
    const chain = new ViemGatewayChain({ arena: IDENTITY, privateKey: OPERATOR_KEY, rpcUrl: "http://rpc.invalid", mirrorNodeUrl: "https://mirror.test" });
    expect(chain.erc8004).toBeNull();
    expect(await chain.agentOwner(1)).toBeNull();
    expect(await chain.feedbackEvents(1)).toEqual([]);
    expect(await chain.readDefectFeedback(1)).toEqual([]);
  });
});
