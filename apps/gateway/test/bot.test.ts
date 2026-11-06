import { describe, expect, it } from "vitest";
import { loadConfig as loadBotConfig, type HuntOptions, type HuntResult, type RunSummary } from "@defect/breaker-bot";
import type { BotRunView, BotStatus } from "@defect/shared";
import { PHASE } from "../src/chain";
import { parseBot } from "../src/config";
import { BotRunner, type BotSettings } from "../src/services/bot";
import { makeEnv, seedContest, type TestEnv } from "./helpers";

const BOT_ENV = { BOT_HEDERA_ACCOUNT_ID: "0.0.7007", BOT_PRIVATE_KEY: `0x${"22".repeat(32)}`, OG_API_KEY_BOT: "sk-test" };

const settings: BotSettings = { config: loadBotConfig("bot", { ...BOT_ENV, GATEWAY_URL: "http://gateway.test" }), maxAttempts: 5, maxPriceUnits: 500_000n };

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    contestId: 1,
    agent: "TreasuryBot",
    strategy: "mixed",
    startedAt: "",
    endedAt: "",
    attempts: 2,
    charged: 2,
    usdcSpent: "0.1",
    botOg: { calls: 2, totalCost: "0", requestIds: [] },
    targetOgRequestIds: [],
    settlements: [{ txId: "0.0.1@1.2", hashscan: "https://hashscan.io/testnet/transaction/0.0.1-1-2" }],
    outcome: "max_attempts",
    winnings: null,
    claim: null,
    error: null,
    ...over,
  };
}

/** A hunt that logs, then waits until the test settles it. */
function controlledHunt() {
  const calls: HuntOptions[] = [];
  let settle!: (r: HuntResult | Error) => void;
  const fn = (_config: unknown, opts: HuntOptions, log: (line: string) => void) => {
    calls.push(opts);
    log("Discovering paid endpoints");
    return new Promise<HuntResult>((resolve, reject) => {
      settle = (r) => (r instanceof Error ? reject(r) : resolve(r));
    });
  };
  return { fn, calls, settle: (r: HuntResult | Error) => settle(r) };
}

function withBot(env: TestEnv, hunt: ReturnType<typeof controlledHunt>, balance = 1_000_000n): void {
  env.ctx.bot = new BotRunner(settings, hunt.fn, async () => balance);
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const startRun = (env: TestEnv, body: unknown) =>
  env.app.request("/bot/runs", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("breaker bot runs", () => {
  it("reports a disabled bot and refuses to run", async () => {
    const env = makeEnv();
    seedContest(env);
    expect(((await (await env.app.request("/bot")).json()) as BotStatus).enabled).toBe(false);
    const res = await startRun(env, { contestId: 1 });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("BOT_DISABLED");
  });

  it("refuses until the bot holds one message's price", async () => {
    const env = makeEnv();
    seedContest(env);
    const hunt = controlledHunt();
    withBot(env, hunt, 49_999n);
    const res = await startRun(env, { contestId: 1 });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("BOT_NOT_FUNDED");
    expect(hunt.calls).toHaveLength(0);
  });

  it("checks the contest before running", async () => {
    const env = makeEnv();
    seedContest(env, 1, { phase: PHASE.Scheduled });
    withBot(env, controlledHunt());
    expect(await code(await startRun(env, { contestId: 1 }))).toBe("CONTEST_NOT_OPEN");
    expect(await code(await startRun(env, { contestId: 9 }))).toBe("CONTEST_NOT_FOUND");
    expect(await code(await startRun(env, { contestId: "1" }))).toBe("INVALID_CONTEST_ID");
  });

  it("runs one at a time, limited to the contest, and reports the outcome", async () => {
    const env = makeEnv();
    seedContest(env);
    const hunt = controlledHunt();
    withBot(env, hunt);

    const res = await startRun(env, { contestId: 1 });
    expect(res.status).toBe(202);
    const run = (await res.json()) as BotRunView;
    expect(run).toMatchObject({ contestId: 1, status: "running" });
    expect(hunt.calls[0]).toMatchObject({ contestId: 1, maxAttempts: 5, budgetUnits: 1_000_000n, maxPriceUnits: 500_000n, strategy: "mixed" });

    expect(await code(await startRun(env, { contestId: 1 }))).toBe("BOT_BUSY");
    const status = (await (await env.app.request("/bot")).json()) as BotStatus;
    expect(status).toMatchObject({ enabled: true, accountId: "0.0.7007", usdc: "1", maxAttempts: 5 });
    expect(status.active?.lines).toEqual(["Discovering paid endpoints"]);

    hunt.settle({ target: null, summary: summary() });
    await flush();
    const done = (await (await env.app.request(`/bot/runs/${run.runId}`)).json()) as BotRunView;
    expect(done).toMatchObject({ status: "done", outcome: "max_attempts", attempts: 2, charged: 2, usdcSpent: "0.1" });
    expect(done.settlements).toHaveLength(1);
    expect(done.endedAt).not.toBeNull();
    const after = (await (await env.app.request("/bot")).json()) as BotStatus;
    expect(after.active).toBeNull();
    expect(after.latest[1]?.runId).toBe(run.runId);
  });

  it("marks a run failed when the hunt throws or finds nothing, and frees the bot", async () => {
    const env = makeEnv();
    seedContest(env);
    const hunt = controlledHunt();
    withBot(env, hunt);
    const first = (await (await startRun(env, { contestId: 1 })).json()) as BotRunView;
    hunt.settle(new Error("facilitator down"));
    await flush();
    expect(env.ctx.bot.run(first.runId)).toMatchObject({ status: "failed", error: "facilitator down" });

    const second = (await (await startRun(env, { contestId: 1 })).json()) as BotRunView;
    hunt.settle({ target: null, summary: null });
    await flush();
    expect(env.ctx.bot.run(second.runId)).toMatchObject({ status: "failed", error: "The bot found no open endpoint for this contest" });
    expect((await env.app.request("/bot/runs/nope")).status).toBe(404);
  });
});

describe("parseBot", () => {
  it("is off unless the bot key, account and attacker-model key are all set", () => {
    expect(parseBot({}, "http://gw")).toBeNull();
    expect(parseBot({ ...BOT_ENV, OG_API_KEY_BOT: "" }, "http://gw")).toBeNull();
  });

  it("pays the gateway's public URL and reads the run limits", () => {
    const s = parseBot({ ...BOT_ENV, GATEWAY_URL: "http://elsewhere", BOT_RUN_MAX_ATTEMPTS: "3", BOT_RUN_MAX_PRICE: "0.2" }, "https://api.example");
    expect(s?.config.gatewayUrl).toBe("https://api.example");
    expect(s).toMatchObject({ maxAttempts: 3, maxPriceUnits: 200_000n });
    expect(() => parseBot({ ...BOT_ENV, BOT_RUN_MAX_ATTEMPTS: "0" }, "http://gw")).toThrow(/BOT_RUN_MAX_ATTEMPTS/);
  });
});
