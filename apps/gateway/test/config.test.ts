import { describe, expect, it, vi } from "vitest";
import { loadConfig, parseSiteUrl, siteUrlWarnings } from "../src/config";

const REGISTRIES = { identity: "0x000000000000000000000000000000000008004a", reputation: "0x000000000000000000000000000000000008004b" } as const;

vi.mock("@defect/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@defect/shared")>()),
  getErc8004Addresses: () => REGISTRIES,
}));

const BASE_ENV = {
  ARENA_DEPLOYMENT: "demo",
  OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  OPERATOR_ACCOUNT_ID: "0.0.5000",
  RUNNER_TOKEN: "x".repeat(32),
};

describe("gateway config", () => {
  it("reads SITE_URL independently of WEB_ORIGIN, without a trailing slash", () => {
    expect(loadConfig({ ...BASE_ENV, WEB_ORIGIN: "http://localhost:3000" }).siteUrl).toBeNull();
    expect(loadConfig({ ...BASE_ENV, WEB_ORIGIN: "http://localhost:3000", SITE_URL: "https://defect.example/" }).siteUrl).toBe("https://defect.example");
    expect(parseSiteUrl("  ")).toBeNull();
    expect(parseSiteUrl("not a url")).toBeNull();
    expect(parseSiteUrl("ftp://defect.example")).toBeNull();
  });

  it("warns when SITE_URL is unset, invalid, not https or local, and only when ERC-8004 is on", () => {
    const w = (siteUrl: string | null, raw?: string) => siteUrlWarnings({ erc8004: REGISTRIES, siteUrl }, raw ?? siteUrl ?? undefined);
    expect(w(null)).toEqual(["WARNING SITE_URL is unset; ERC-8004 feedback will not be posted"]);
    expect(w(null, "nope")[0]).toContain("is not an http(s) URL");
    expect(w("http://defect.example")[0]).toContain("is not a public https URL");
    expect(w("https://localhost:3000")[0]).toContain("is not a public https URL");
    expect(w("https://127.0.0.1")[0]).toContain("is not a public https URL");
    expect(w("https://defect.example")).toEqual([]);
    expect(siteUrlWarnings({ erc8004: null, siteUrl: null }, undefined)).toEqual([]);
  });

  it("turns ERC-8004 off when ARENA_ADDRESS_OVERRIDE is set, like the certificate", () => {
    expect(loadConfig(BASE_ENV).erc8004).toEqual(REGISTRIES);
    const overridden = loadConfig({ ...BASE_ENV, ARENA_ADDRESS_OVERRIDE: "0x00000000000000000000000000000000000000aa" });
    expect(overridden.erc8004).toBeNull();
    expect(overridden.certificate).toBeNull();
  });

  it("runs the faucet only with a key of its own, never the operator's", () => {
    expect(loadConfig(BASE_ENV).faucet).toBeNull();
    expect(() => loadConfig({ ...BASE_ENV, FAUCET_ENABLED: "true" })).toThrow(/FAUCET_PRIVATE_KEY/);
    const key = `0x${"22".repeat(32)}`;
    const on = loadConfig({ ...BASE_ENV, FAUCET_PRIVATE_KEY: key }).faucet;
    expect(on).toMatchObject({ privateKey: key, perIpDailyCap: 3, proxyHops: 0, privy: null });
    expect(loadConfig({ ...BASE_ENV, FAUCET_PRIVATE_KEY: key, FAUCET_ENABLED: "false" }).faucet).toBeNull();
    expect(() => loadConfig({ ...BASE_ENV, FAUCET_PRIVATE_KEY: key, PRIVY_APP_ID: "app" })).toThrow(/PRIVY_VERIFICATION_KEY/);
    expect(loadConfig({ ...BASE_ENV, FAUCET_PRIVATE_KEY: key, PRIVY_APP_ID: "app", PRIVY_VERIFICATION_KEY: "pem", TRUSTED_PROXY_HOPS: "1" }).faucet).toMatchObject({
      proxyHops: 1,
      privy: { appId: "app", verificationKey: "pem" },
    });
  });
});
