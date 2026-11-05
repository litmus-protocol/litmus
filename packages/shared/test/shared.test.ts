import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  formatUsdc,
  fromBaseUnits,
  hashscanTx,
  toBaseUnits,
  treasuryBotSubmission,
  validateSubmission,
} from "../src";

describe("units", () => {
  it("converts decimals to base units", () => {
    expect(toBaseUnits("0.05")).toBe(50_000n);
    expect(toBaseUnits("50")).toBe(50_000_000n);
    expect(toBaseUnits("0.000001")).toBe(1n);
  });
  it("rejects invalid decimals", () => {
    for (const bad of ["1.2345678", "-1", "01", "", "1.", ".5", "1e3"]) {
      expect(() => toBaseUnits(bad)).toThrow();
    }
  });
  it("prints base units without trailing zeros", () => {
    expect(fromBaseUnits(50_000n)).toBe("0.05");
    expect(fromBaseUnits(50_000_000n)).toBe("50");
    expect(fromBaseUnits(100_245_000n)).toBe("100.245");
  });
  it("formats for display", () => {
    expect(formatUsdc("104.2")).toBe("104.20");
    expect(formatUsdc("0.035")).toBe("0.035");
    expect(formatUsdc("3412.5")).toBe("3,412.50");
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe("hashscan", () => {
  it("converts Hedera tx ids", () => {
    expect(hashscanTx("0.0.9185802@1762412999.123456789")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.9185802-1762412999-123456789",
    );
  });
});

describe("validateSubmission", () => {
  const now = 1_762_400_000;
  const opts = { allowedModels: ["0gm-1.0-35b-a3b"], now };
  const valid = { ...treasuryBotSubmission, startTime: now + 120 };

  it("accepts the TreasuryBot fixture", () => {
    expect(validateSubmission(valid, opts)).toEqual([]);
  });
  it("rejects a missing secret placeholder", () => {
    const sub = { ...valid, package: { ...valid.package, systemPrompt: "No code here." } };
    expect(validateSubmission(sub, opts).some((i) => i.path === "package.systemPrompt")).toBe(true);
  });
  it("rejects a bond below 20%", () => {
    expect(validateSubmission({ ...valid, bond: "19" }, opts).some((i) => i.path === "bond")).toBe(true);
  });
  it("rejects a price below 0.01", () => {
    expect(validateSubmission({ ...valid, messagePrice: "0.009" }, opts).some((i) => i.path === "messagePrice")).toBe(true);
  });
});
