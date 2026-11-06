import { randomUUID } from "node:crypto";
import { fromBaseUnits, type BotRunView, type BotStatus } from "@defect/shared";
import type { BotConfig, HuntOptions, HuntResult } from "@defect/breaker-bot";
import type { Ctx } from "../context";
import { ApiFailure } from "./errors";

// "Run breaker bot" (web app): the shared bot wallet attacks one contest on request. Anyone can fund
// the wallet and press Run; nothing runs in the background. The bot finds the contest's paid endpoint
// through GET /.well-known/x402 and pays each message itself over x402, like the CLI's `hunt`.

export interface BotSettings {
  config: BotConfig;
  /** Paid messages per run, at most. */
  maxAttempts: number;
  /** Never pay more than this per message (base units). */
  maxPriceUnits: bigint;
}

export type HuntFn = (config: BotConfig, opts: HuntOptions, log: (line: string) => void) => Promise<HuntResult>;

/** A contest closing sooner than this is skipped by the run; long enough for a few replies. */
export const BOT_RUN_MIN_SECONDS_LEFT = 60;
const MAX_LINES = 400;
const MAX_KEPT_RUNS = 50;

export class BotRunner {
  private active: BotRunView | null = null;
  private readonly runs = new Map<string, BotRunView>();
  private readonly latest = new Map<number, BotRunView>();

  constructor(
    private readonly settings: BotSettings | null,
    private readonly huntFn: HuntFn,
    /** The bot wallet's USDC balance in base units (mirror node). */
    private readonly usdcBalance: () => Promise<bigint>,
  ) {}

  async status(): Promise<BotStatus> {
    const s = this.settings;
    const units = s ? await this.usdcBalance().catch(() => null) : null;
    return {
      enabled: s !== null,
      accountId: s?.config.wallet.accountId ?? null,
      address: s?.config.wallet.address ?? null,
      agentId: s?.config.agentId ?? null,
      usdc: units === null ? null : fromBaseUnits(units),
      maxAttempts: s?.maxAttempts ?? 0,
      active: this.active,
      latest: Object.fromEntries(this.latest),
    };
  }

  run(runId: string): BotRunView {
    const r = this.runs.get(runId);
    if (!r) throw new ApiFailure(404, "BOT_RUN_NOT_FOUND", "No bot run with this id");
    return r;
  }

  /** Starts a run against one open contest and returns at once; poll GET /bot/runs/:id for its log. */
  async start(ctx: Ctx, contestId: number): Promise<BotRunView> {
    const s = this.settings;
    if (!s) throw new ApiFailure(503, "BOT_DISABLED", "The breaker bot is not set up on this gateway");
    if (this.active) throw new ApiFailure(409, "BOT_BUSY", `The bot is already running on contest #${this.active.contestId}`);
    const row = ctx.db.contest(contestId);
    if (!row || row.loaded !== 1) throw new ApiFailure(404, "CONTEST_NOT_FOUND", "No open contest with this id");
    const state = await ctx.state.get(contestId);
    if (state.phase !== "open") throw new ApiFailure(409, "CONTEST_NOT_OPEN", `Contest is ${state.phase.replace("_", " ")}, not open`);
    const price = BigInt(row.message_price);
    if (price > s.maxPriceUnits) throw new ApiFailure(409, "BOT_PRICE_CAP", `The bot pays at most ${fromBaseUnits(s.maxPriceUnits)} USDC per message`);
    let balance: bigint;
    try {
      balance = await this.usdcBalance();
    } catch {
      throw new ApiFailure(503, "MIRROR_NODE_ERROR", "Couldn't read the bot's USDC balance");
    }
    if (balance < price) {
      throw new ApiFailure(409, "BOT_NOT_FUNDED", `The bot has ${fromBaseUnits(balance)} USDC; send it at least ${fromBaseUnits(price)} USDC first`);
    }

    // A second click can't slip in while the checks above awaited.
    const busy = this.active as BotRunView | null;
    if (busy) throw new ApiFailure(409, "BOT_BUSY", `The bot is already running on contest #${busy.contestId}`);
    const view: BotRunView = {
      runId: randomUUID(),
      contestId,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
      lines: [],
      outcome: null,
      attempts: 0,
      charged: 0,
      usdcSpent: "0",
      settlements: [],
      winnings: null,
      error: null,
    };
    this.active = view;
    this.keep(view);
    const log = (line: string) => {
      view.lines.push(line);
      if (view.lines.length > MAX_LINES) view.lines.splice(0, view.lines.length - MAX_LINES);
    };
    ctx.log(`bot run ${view.runId} started on contest ${contestId} (balance ${fromBaseUnits(balance)} USDC)`);
    void this.huntFn(
      s.config,
      {
        strategy: "mixed",
        budgetUnits: balance,
        maxAttempts: s.maxAttempts,
        maxPriceUnits: s.maxPriceUnits,
        contestId,
        minSecondsLeft: BOT_RUN_MIN_SECONDS_LEFT,
      },
      log,
    )
      .then(({ summary }) => {
        if (!summary) {
          view.status = "failed";
          view.error = "The bot found no open endpoint for this contest";
          return;
        }
        Object.assign(view, {
          status: summary.outcome === "error" || summary.outcome === "claim_failed" ? "failed" : "done",
          outcome: summary.outcome,
          attempts: summary.attempts,
          charged: summary.charged,
          usdcSpent: summary.usdcSpent,
          settlements: summary.settlements,
          winnings: summary.winnings,
          error: summary.error,
        });
      })
      .catch((err: unknown) => {
        view.status = "failed";
        view.error = err instanceof Error ? err.message : String(err);
        log(`Stopped: ${view.error}`);
      })
      .finally(() => {
        view.endedAt = Date.now();
        this.active = null;
        ctx.log(`bot run ${view.runId} ${view.status}: ${view.outcome ?? view.error}`);
      });
    return view;
  }

  private keep(view: BotRunView): void {
    this.runs.set(view.runId, view);
    this.latest.set(view.contestId, view);
    for (const id of this.runs.keys()) {
      if (this.runs.size <= MAX_KEPT_RUNS) break;
      this.runs.delete(id);
    }
  }
}
