import { describe, expect, it } from "vitest";
import type { Ctx } from "../src/context";
import { CreAttester, buildCliArgs, creEnv, buildRunConfig, parseCreAttest, summarizeOutput, type CreAttestDeps, type CreAttestSettings } from "../src/jobs/cre-attest";

const KEY = "ab".repeat(32);
const SETTINGS: CreAttestSettings = {
  bin: "/fake/cre",
  workflowDir: "/fake/workflows/auditor",
  hederaRpcUrl: "https://hedera.example/api",
  sepoliaRpcUrl: "https://sepolia.example",
  gasLimit: "1500000",
  maxAttempts: 3,
  runTimeoutMs: 1000,
};

function fakeCtx(ids: number[]) {
  const logs: string[] = [];
  const queries: string[] = [];
  const ctx = {
    settings: { arena: "0x9d689302c8cf41df3c2b1ba0e2557dce7d33d472", attestations: "0x30618eaa0a4ec9ebfbe8bb59cd90a618986277d4", publicUrl: "http://localhost:8787" },
    db: {
      contests: (where: string) => {
        queries.push(where);
        return ids.map((contest_id) => ({ contest_id }));
      },
    },
    log: (m: string) => logs.push(m),
  } as unknown as Ctx;
  return { ctx, logs, queries };
}

function fakeDeps(attestAfterRun: (id: number, runNo: number) => boolean, initiallyAttested: number[] = []) {
  const attested = new Set<number>(initiallyAttested);
  const runs: { args: string[]; cfg: Record<string, unknown> }[] = [];
  const written: Record<string, string> = {};
  const deps: CreAttestDeps = {
    configPath: "/tmp/cfg.json",
    writeConfig: (p, json) => {
      written[p] = json;
    },
    run: async (_bin, args) => {
      runs.push({ args, cfg: JSON.parse(written["/tmp/cfg.json"]!) });
      const ids = (runs.at(-1)!.cfg.contestIds as number[]).slice();
      for (const id of ids) if (attestAfterRun(id, runs.length)) attested.add(id);
      return { code: 1, output: "✗ workflow execution failed: Contest 1: forwarder tx 0x00 mined but DefectAttestations stored nothing" };
    },
    attestedAt: async (id) => (attested.has(id) ? 1n : 0n),
  };
  return { deps, runs };
}

describe("CRE auto-attest", () => {
  it("passes the cre CLI its own variables but none of the gateway's secrets", () => {
    const env = creEnv({
      PATH: "/bin",
      HOME: "/home/g",
      CRE_ETH_PRIVATE_KEY: "ab".repeat(32),
      CRE_TARGET: "staging-settings",
      OPERATOR_PRIVATE_KEY: "11".repeat(32),
      FAUCET_PRIVATE_KEY: "22".repeat(32),
      RUNNER_TOKEN: "x".repeat(32),
      PRIVY_VERIFICATION_KEY: "pem",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/g", CRE_ETH_PRIVATE_KEY: "ab".repeat(32), CRE_TARGET: "staging-settings" });
  });

  it("is opt-in and needs a valid key", () => {
    expect(parseCreAttest({})).toBeNull();
    expect(parseCreAttest({ CRE_ETH_PRIVATE_KEY: KEY })).toBeNull();
    expect(parseCreAttest({ CRE_AUTO_ATTEST: "true" })).toBeNull();
    expect(parseCreAttest({ CRE_AUTO_ATTEST: "true", CRE_ETH_PRIVATE_KEY: "nope" })).toBeNull();
    const on = parseCreAttest({ CRE_AUTO_ATTEST: "true", CRE_ETH_PRIVATE_KEY: KEY, CRE_BIN: "/x/cre" });
    expect(on?.bin).toBe("/x/cre");
    expect(on?.maxAttempts).toBe(6);
    expect(on?.workflowDir.endsWith("workflows/auditor")).toBe(true);
  });

  it("runs the real CLI non-interactively with --broadcast and a generated --config", () => {
    expect(buildCliArgs("/tmp/c.json")).toEqual([
      "workflow", "simulate", "auditor", "--target", "staging-settings", "--broadcast", "--non-interactive", "--trigger-index", "0", "--config", "/tmp/c.json",
    ]);
  });

  it("generates the config for THIS gateway's deployment and only the pending contests", () => {
    const { ctx } = fakeCtx([]);
    const cfg = buildRunConfig(ctx, SETTINGS, [11, 12]);
    expect(cfg).toMatchObject({
      gatewayUrl: "http://localhost:8787",
      arena: "0x9d689302c8cf41df3c2b1ba0e2557dce7d33d472",
      attestations: "0x30618eaa0a4ec9ebfbe8bb59cd90a618986277d4",
      attestationsChain: "ethereum-testnet-sepolia",
      contestIds: [11, 12],
      maxPerRun: 2,
    });
  });

  it("logs only the workflow's lines and masks anything key-shaped", () => {
    const out = ["noise", `2026 [USER LOG] attested on sepolia tx 0x${"cd".repeat(32)}`, `✗ boom ${"ab".repeat(32)}`, "Loading settings..."].join("\n");
    const lines = summarizeOutput(out);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`0x${"cd".repeat(32)}`); // a tx hash (0x prefix) is kept
    expect(lines[1]).toContain("<redacted>");
    expect(lines.join(" ")).not.toContain("ab".repeat(32));
  });

  it("does nothing when no Held/Broken contest is waiting, and asks the DB only for finalized held/broken", async () => {
    const { ctx, queries } = fakeCtx([]);
    const { deps, runs } = fakeDeps(() => true);
    await new CreAttester(ctx, SETTINGS, deps).tick();
    expect(runs).toHaveLength(0);
    expect(queries[0]).toContain("finalized = 1");
    expect(queries[0]).toContain("'held'");
    expect(queries[0]).toContain("'broken'");
    expect(queries[0]).not.toContain("void");
  });

  it("skips contests that are already attested on Sepolia", async () => {
    const { ctx } = fakeCtx([5, 6]);
    const { deps, runs } = fakeDeps(() => true, [5, 6]);
    await new CreAttester(ctx, SETTINGS, deps).tick();
    expect(runs).toHaveLength(0);
  });

  it("runs once for a pending contest, trusts the chain not the exit code, and never reruns it", async () => {
    const { ctx, logs } = fakeCtx([13]);
    const { deps, runs } = fakeDeps(() => true);
    const job = new CreAttester(ctx, SETTINGS, deps);
    await job.tick();
    expect(runs).toHaveLength(1); // exit code was 1 (the simulator's false error) yet it counts as attested
    expect(runs[0]!.cfg.contestIds).toEqual([13]);
    expect(logs.some((l) => l.includes("contest 13 is attested"))).toBe(true);
    await job.tick();
    expect(runs).toHaveLength(1);
  });

  it("repeats within a tick while runs make progress, three contests per run", async () => {
    const { ctx } = fakeCtx([1, 2, 3, 4, 5]);
    // the simulator's cut-off: each run only manages the first contest of its batch
    const { deps, runs } = fakeDeps((id) => id === (runs.at(-1)?.cfg.contestIds as number[])[0]);
    const job = new CreAttester(ctx, SETTINGS, deps);
    await job.tick();
    expect(runs.map((r) => r.cfg.contestIds)).toEqual([[1, 2, 3], [2, 3, 4], [3, 4, 5], [4, 5]]);
  });

  it("stops after a run that attests nothing, and gives up on a contest after maxAttempts", async () => {
    const { ctx, logs } = fakeCtx([9]);
    const { deps, runs } = fakeDeps(() => false);
    const job = new CreAttester(ctx, SETTINGS, deps);
    await job.tick();
    expect(runs).toHaveLength(1); // no spinning
    await job.tick();
    await job.tick();
    expect(runs).toHaveLength(3);
    await job.tick();
    expect(runs).toHaveLength(3); // budget spent
    expect(logs.some((l) => l.includes("giving up on contest 9"))).toBe(true);
  });
});
