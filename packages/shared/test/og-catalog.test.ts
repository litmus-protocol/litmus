import { describe, expect, it } from "vitest";
import {
  ModelCatalog,
  OG_PSEUDO_PROVIDER,
  buildCatalog,
  modelsOfProvider,
  providerIssue,
  providersByAddress,
  type OgModelInfo,
  treasuryBotSubmission,
  validateSubmission,
  withStartTime,
} from "../src";

const PIN = "0xD179F4526064846dE9a9E9D93683AF75CB72E503";
const DOWN = "0x15aDd680050Ecd0B25eb7d480e7BB1f48594Eabe";
const tools = ["temperature", "tools"];
const MODELS = {
  data: [
    { id: "glm-5.3", name: "GLM-5.3", type: "chatbot", supported_parameters: tools, verifiability: "TeeML", tee_attested: true },
    { id: "claude-opus-5", type: "chatbot", supported_parameters: tools },
    { id: "laya", type: "chatbot", supported_parameters: ["temperature"] },
    { id: "qwen3-embedding-8b", type: "embedding", supported_parameters: tools },
  ],
};
const PROVIDERS = {
  data: [
    { address: PIN, canonical_id: "glm-5.3", model_id: "glm-5.3", is_healthy: true, latency: 3001, tee_acknowledged: true, tee_attested: true, tee_type: "TDX" },
    { address: DOWN, canonical_id: "glm-5.3", is_healthy: false, latency: 1200, tee_acknowledged: true },
    { address: "0x787A66B5dB48F23494aA7384f51EDfEF1911341D", canonical_id: "glm-5.3", is_healthy: true, tee_acknowledged: false },
    { address: OG_PSEUDO_PROVIDER, canonical_id: "claude-opus-5", is_healthy: true, tee_acknowledged: true },
    { address: OG_PSEUDO_PROVIDER, canonical_id: "glm-5.3", is_healthy: true, tee_acknowledged: true },
    { address: "0x787A66B5dB48F23494aA7384f51EDfEF1911341D", canonical_id: "laya", is_healthy: true, tee_acknowledged: true },
  ],
};

describe("0G Router catalog", () => {
  it("keeps tool-capable chat models served by an acknowledged on-chain 0G provider", () => {
    const c = buildCatalog(MODELS, PROVIDERS);
    expect(c.map((m) => m.id)).toEqual(["glm-5.3"]);
    // pseudo-address (centralized upstream) and unacknowledged providers are excluded; sorted by latency
    expect(c[0]!.providers.map((p) => p.address)).toEqual([DOWN, PIN]);
    expect(c[0]!.providers[1]).toMatchObject({ healthy: true, teeAttested: true, teeType: "TDX", latencyMs: 3001 });
  });

  it("caches for the TTL, keeps the last good snapshot on failure, else serves the env list", async () => {
    let t = 0;
    let fail = false;
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      if (fail) throw new Error("down");
      return new Response(JSON.stringify(url.endsWith("/models") ? MODELS : PROVIDERS));
    }) as typeof fetch;
    const cat = new ModelCatalog({ baseUrl: "https://r/v1/", fallbackModels: ["x"], ttlMs: 1000, fetchFn, now: () => t });
    expect((await cat.get()).source).toBe("router");
    await cat.get();
    expect(calls).toBe(2);
    t = 2000;
    fail = true;
    const stale = await cat.get();
    expect(stale.source).toBe("router");
    expect(stale.models[0]!.id).toBe("glm-5.3");

    const cold = new ModelCatalog({ baseUrl: "https://r/v1", fallbackModels: ["x"], fetchFn: (async () => new Response("", { status: 500 })) as typeof fetch });
    expect(await cold.get()).toMatchObject({ source: "static", models: [{ id: "x", providers: [] }] });
    expect((await new ModelCatalog({ baseUrl: null, fallbackModels: ["y"] }).get()).models[0]!.id).toBe("y");
  });

  it("providerIssue checks model, membership and (optionally) health", () => {
    const view = { source: "router" as const, fetchedAt: 0, models: buildCatalog(MODELS, PROVIDERS) };
    expect(providerIssue(view, "glm-5.3", PIN.toLowerCase(), { requireHealthy: true })).toBeNull();
    expect(providerIssue(view, "glm-5.3", DOWN, { requireHealthy: true })).toMatch(/not healthy/);
    expect(providerIssue(view, "glm-5.3", DOWN, { requireHealthy: false })).toBeNull();
    expect(providerIssue(view, "glm-5.3", OG_PSEUDO_PROVIDER, { requireHealthy: false })).toMatch(/not a 0G provider/);
  });
});

describe("package.providerAddress", () => {
  const base = withStartTime(treasuryBotSubmission, 1_800_000_000);
  const sub = (providerAddress?: string) => ({ ...base, package: { ...base.package, model: "glm-5.3", providerAddress } });
  const providers = buildCatalog(MODELS, PROVIDERS).flatMap((m) => m.providers);
  const opts = { allowedModels: ["glm-5.3"], now: 1_800_000_000 - 3600, providers };

  it("is optional and checked against the live provider list", () => {
    expect(validateSubmission(sub(), opts)).toEqual([]);
    expect(validateSubmission(sub(PIN), opts)).toEqual([]);
    expect(validateSubmission(sub(DOWN), opts).map((i) => i.path)).toEqual(["package.providerAddress"]);
    expect(validateSubmission(sub(OG_PSEUDO_PROVIDER), opts).map((i) => i.path)).toEqual(["package.providerAddress"]);
    expect(validateSubmission(sub("0x12"), opts).map((i) => i.path)).toEqual(["package.providerAddress"]);
    // without a provider list (client-side pre-check) only the format is checked
    expect(validateSubmission(sub(DOWN), { allowedModels: ["glm-5.3"], now: opts.now })).toEqual([]);
  });
});

describe("provider-first view", () => {
  const prov = (address: `0x${string}`, model: string, healthy: boolean, latencyMs: number | null) =>
    ({ address, model, healthy, latencyMs, uptime: null, teeAcknowledged: true, teeAttested: true, teeType: "TDX" }) as const;
  const A = "0xD179F4526064846dE9a9E9D93683AF75CB72E503" as const;
  const B = "0x15aDd680050Ecd0B25eb7d480e7BB1f48594Eabe" as const;
  const models: OgModelInfo[] = [
    { id: "glm-5.3", name: "g", verifiability: null, teeAttested: true, providers: [prov(A, "glm-5.3", true, 3000), prov(B, "glm-5.3", false, 100)] },
    { id: "0gm", name: "o", verifiability: null, teeAttested: true, providers: [prov(A.toLowerCase() as `0x${string}`, "0gm", false, 2000)] },
  ];

  it("groups by address (case-insensitive), a provider can serve several models", () => {
    const v = providersByAddress(models);
    expect(v.map((p) => p.address)).toEqual([A, B]);
    expect(v[0]).toMatchObject({ healthy: true, latencyMs: 2000, models: [{ id: "glm-5.3", healthy: true }, { id: "0gm", healthy: false }] });
    expect(v[1]!.healthy).toBe(false);
  });

  it("modelsOfProvider returns the healthy models or a reason", () => {
    expect(modelsOfProvider(models, A.toLowerCase())).toMatchObject({ ok: true, models: ["glm-5.3"] });
    expect(modelsOfProvider(models, B)).toEqual({ ok: false, reason: expect.stringMatching(/not healthy/) });
    expect(modelsOfProvider(models, `0x${"ab".repeat(20)}`)).toEqual({ ok: false, reason: expect.stringMatching(/Not an approved/) });
    expect(modelsOfProvider(models, "0x12")).toEqual({ ok: false, reason: expect.stringMatching(/40 hex/) });
  });
});
