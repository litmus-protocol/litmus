import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import type { Ctx } from "../context";

/**
 * Auto-attest: whenever a contest ends Held or Broken and is finalized, run the real Chainlink CRE auditor (the `cre` CLI
 * simulator, `cre workflow simulate auditor --broadcast`) so its result is written to DefectAttestations on Sepolia.
 *
 * The CLI is run as a subprocess because that is what executes the CRE workflow. Nothing here re-implements the audit.
 * The auditor's committed config (auditor/config.staging.json) is never touched: each run gets a generated config for THIS
 * gateway's arena and attestations contract, passed with `--config`.
 *
 * The simulator stops a run after ~25 s (one or two contests) and reports a false "stored nothing" error when it does, so
 * success is never judged from the exit code: after each run the attestation is read back from Sepolia, and runs repeat
 * until every pending contest is attested or its retry budget is spent.
 */

export interface CreAttestSettings {
  /** The `cre` executable. */
  bin: string;
  /** Directory holding project.yaml / workflow auditor (workflows/auditor). */
  workflowDir: string;
  hederaRpcUrl: string;
  sepoliaRpcUrl: string;
  gasLimit: string;
  /** Runs allowed per contest before it is left alone until the gateway restarts. */
  maxAttempts: number;
  /** Kill a run that takes longer than this. */
  runTimeoutMs: number;
}

export const AUDITOR_DIR = fileURLToPath(new URL("../../../../workflows/auditor", import.meta.url));

const ATTESTATIONS_ABI = parseAbi([
  "function attestations(uint256 contestId) view returns (uint8 status, bytes32 logHash, bool logHashMatches, bool canaryHashMatches, bool secretsMatch, uint32 messageCount, uint32 attemptsInLog, address winner, uint256 attestedAt)",
]);

/** `CRE_AUTO_ATTEST` opts in; it spends Sepolia ETH from CRE_ETH_PRIVATE_KEY on every attestation. */
export function parseCreAttest(env: NodeJS.ProcessEnv): CreAttestSettings | null {
  if (!/^(1|true|yes|on)$/i.test(env.CRE_AUTO_ATTEST ?? "")) return null;
  const key = env.CRE_ETH_PRIVATE_KEY?.trim();
  if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) return null;
  const defaultBin = join(homedir(), ".cre", "bin", "cre");
  return {
    bin: env.CRE_BIN?.trim() || (existsSync(defaultBin) ? defaultBin : "cre"),
    workflowDir: env.CRE_WORKFLOW_DIR?.trim() || AUDITOR_DIR,
    hederaRpcUrl: env.HEDERA_RPC_URL?.trim() || "https://testnet.hashio.io/api",
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com",
    gasLimit: env.CRE_GAS_LIMIT ?? "1500000",
    maxAttempts: Number(env.CRE_MAX_ATTEMPTS ?? "6") || 6,
    runTimeoutMs: Number(env.CRE_RUN_TIMEOUT_MS ?? "240000") || 240_000,
  };
}

/** Problems that would make every run fail; empty when the CLI and the workflow's dependencies are in place. */
export function creAttestPreflight(s: CreAttestSettings): string[] {
  const problems: string[] = [];
  const binOk = s.bin.includes("/") ? existsSync(s.bin) : true; // a bare name is resolved from PATH at spawn time
  if (!binOk) problems.push(`the cre CLI was not found at ${s.bin} (install it, or set CRE_BIN)`);
  if (!existsSync(join(s.workflowDir, "project.yaml"))) problems.push(`no CRE project at ${s.workflowDir}`);
  if (!existsSync(join(s.workflowDir, "auditor", "node_modules", "@chainlink", "cre-sdk"))) {
    problems.push(`the auditor's dependencies are missing: run "bun install" in ${join(s.workflowDir, "auditor")}`);
  }
  return problems;
}

/** The config one run of the auditor workflow uses: this gateway's deployment, only the pending contests. */
export function buildRunConfig(ctx: Ctx, s: CreAttestSettings, contestIds: number[]): Record<string, unknown> {
  return {
    schedule: "*/15 * * * * *", // the simulator fires its cron trigger on the next tick: keep the wait short
    gatewayUrl: ctx.settings.publicUrl,
    hederaRpcUrl: s.hederaRpcUrl,
    arena: ctx.settings.arena,
    attestationsChain: "ethereum-testnet-sepolia",
    attestations: ctx.settings.attestations,
    gasLimit: s.gasLimit,
    maxPerRun: contestIds.length,
    contestIds,
  };
}

export function buildCliArgs(configPath: string): string[] {
  return ["workflow", "simulate", "auditor", "--target", "staging-settings", "--broadcast", "--non-interactive", "--trigger-index", "0", "--config", configPath];
}

/** Keep log lines useful and safe: only the workflow's own lines and errors, with anything key-shaped masked. */
export function summarizeOutput(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => /USER LOG|✗|attested on|Nothing to audit/.test(l))
    .map((l) => l.replace(/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "<redacted>").trim().slice(0, 220))
    .slice(-8);
}

export interface RunResult {
  code: number | null;
  output: string;
}
export interface CreAttestDeps {
  /** Runs the cre binary. */
  run(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult>;
  /** DefectAttestations.attestations(id).attestedAt on Sepolia (0n = not attested). */
  attestedAt(contestId: number): Promise<bigint>;
  /** Where the generated config is written. */
  configPath: string;
  writeConfig(path: string, json: string): void;
}

export function realDeps(ctx: Ctx, s: CreAttestSettings): CreAttestDeps {
  const client = createPublicClient({ chain: sepolia, transport: http(s.sepoliaRpcUrl) });
  return {
    run: (bin, args, opts) =>
      new Promise((resolve) => {
        let output = "";
        const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
        child.stdout.on("data", (d: Buffer) => (output += d.toString()));
        child.stderr.on("data", (d: Buffer) => (output += d.toString()));
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ code: null, output: `${output}\n✗ failed to start ${bin}: ${e.message}` });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output });
        });
      }),
    attestedAt: async (id) => {
      const attestations = ctx.settings.attestations;
      if (!attestations) throw new Error("no attestations contract configured");
      return (await client.readContract({ address: attestations, abi: ATTESTATIONS_ABI, functionName: "attestations", args: [BigInt(id)] }))[8];
    },
    configPath: join(tmpdir(), "litmus-cre-auditor.config.json"),
    writeConfig: (path, json) => writeFileSync(path, json, { mode: 0o600 }),
  };
}

const MAX_PER_RUN = 3;
const MAX_RUNS_PER_TICK = 4;

export class CreAttester {
  private readonly done = new Set<number>();
  private readonly attempts = new Map<number, number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly s: CreAttestSettings,
    private readonly deps: CreAttestDeps,
  ) {}

  /** Held or Broken contests that are finalized and not yet attested on chain (and still within their retry budget). */
  async pending(): Promise<number[]> {
    if (!this.ctx.settings.attestations) return [];
    const out: number[] = [];
    for (const row of this.ctx.db.contests("finalized = 1 AND status IN ('held','broken')")) {
      const id = row.contest_id;
      if (this.done.has(id)) continue;
      if ((this.attempts.get(id) ?? 0) >= this.s.maxAttempts) continue;
      if ((await this.deps.attestedAt(id)) !== 0n) {
        this.done.add(id);
        continue;
      }
      out.push(id);
    }
    return out;
  }

  /** One scheduler tick: run the auditor while there is work and the last run made progress. */
  async tick(): Promise<void> {
    for (let i = 0; i < MAX_RUNS_PER_TICK; i++) {
      const pending = await this.pending();
      if (pending.length === 0) return;
      const batch = pending.slice(0, MAX_PER_RUN);
      this.ctx.log(`cre auto-attest: running the CRE auditor for contest(s) ${batch.join(", ")}`);

      this.deps.writeConfig(this.deps.configPath, JSON.stringify(buildRunConfig(this.ctx, this.s, batch)));
      const res = await this.deps.run(this.s.bin, buildCliArgs(this.deps.configPath), {
        cwd: this.s.workflowDir,
        env: process.env,
        timeoutMs: this.s.runTimeoutMs,
      });
      for (const line of summarizeOutput(res.output)) this.ctx.log(`cre auto-attest | ${line}`);

      // Judge by the chain, not the exit code (the simulator's cut-off produces a false error even when it succeeded).
      let progressed = false;
      for (const id of batch) {
        this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
        if ((await this.deps.attestedAt(id)) !== 0n) {
          this.done.add(id);
          progressed = true;
          this.ctx.log(`cre auto-attest: contest ${id} is attested on Sepolia`);
        } else if ((this.attempts.get(id) ?? 0) >= this.s.maxAttempts) {
          this.ctx.log(`cre auto-attest: giving up on contest ${id} after ${this.s.maxAttempts} runs (restart the gateway to retry)`);
        }
      }
      if (!progressed) return; // nothing landed this run: wait for the next tick instead of spinning
    }
  }
}
