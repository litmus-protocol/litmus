import { keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  agentRegistryId,
  buildAgentCard,
  ERC8004_REGISTRATION_TYPE,
  feedbackTag2,
  fromJsonDataUri,
  getErc8004Addresses,
  parseFeedbackTag2,
  toJsonDataUri,
  treasuryBotSubmission,
  validateSubmission,
} from "../src";

describe("erc8004 helpers", () => {
  it("builds a lowercase CAIP-10 style registry id", () => {
    expect(agentRegistryId(296, "0xABCDEF0123456789abcdef0123456789ABCDEF01")).toBe(
      "eip155:296:0xabcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("round-trips feedback tag2", () => {
    expect(parseFeedbackTag2(feedbackTag2("prod", 12))).toEqual({ deployment: "prod", contestId: 12 });
    expect(parseFeedbackTag2("x:1")).toBeNull();
    expect(parseFeedbackTag2("prod:-1")).toBeNull();
  });

  it("round-trips JSON data URIs and hashes the UTF-8 bytes", () => {
    const input = { a: 1, b: ["x", "é"], c: { d: null } };
    const { uri, bytes, hash } = toJsonDataUri(input);
    expect(uri.startsWith("data:application/json;base64,")).toBe(true);
    expect(fromJsonDataUri(uri)).toEqual(input);
    expect(hash).toBe(keccak256(toBytes(JSON.stringify(input))));
    expect(bytes).toEqual(toBytes(JSON.stringify(input)));
    expect(fromJsonDataUri("https://x")).toBeNull();
    expect(fromJsonDataUri("data:application/json;base64,!!!notjson")).toBeNull();
  });

  it("builds an agent card", () => {
    const card = buildAgentCard({ name: "TreasuryBot", description: "d", siteUrl: "https://s" });
    expect(card.type).toBe(ERC8004_REGISTRATION_TYPE);
    expect("registrations" in card).toBe(false);
    expect(card.services).toEqual([{ name: "web", endpoint: "https://s" }]);
    expect(card.active).toBe(true);
    const withReg = buildAgentCard({
      name: "n",
      description: "d",
      siteUrl: "https://s",
      registration: { agentId: 3, agentRegistry: "eip155:296:0xabc" },
    });
    expect(withReg.registrations).toEqual([{ agentId: 3, agentRegistry: "eip155:296:0xabc" }]);
  });

  it("returns null addresses until erc8004 is deployed", () => {
    const a = getErc8004Addresses();
    expect(a === null || (typeof a.identity === "string" && typeof a.reputation === "string")).toBe(true);
  });
});

describe("agent link in submissions", () => {
  const now = 1_762_400_000;
  const opts = { allowedModels: ["0gm-1.0-35b-a3b"], now };
  const base = { ...treasuryBotSubmission, startTime: now + 120 };
  const linked = { ...base, card: { ...base.card, agentId: 3 } };

  it("requires warden when card.agentId is set", () => {
    const issues = validateSubmission(linked, opts);
    expect(issues.some((i) => i.path === "warden")).toBe(true);
  });
  it("accepts agentId with a warden address", () => {
    const issues = validateSubmission({ ...linked, warden: "0x" + "ab".repeat(20) }, opts);
    expect(issues).toEqual([]);
  });
  it("rejects a malformed warden", () => {
    expect(validateSubmission({ ...base, warden: "nope" }, opts).some((i) => i.path === "warden")).toBe(true);
  });
});
