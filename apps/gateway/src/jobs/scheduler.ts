import type { Ctx } from "../context";
import { autoClose, finalizeContest, pollContest } from "./lifecycle";
import { dueForRound, runCanaryRound } from "./canary";
import { processNextDeposit } from "./deposits";

/** Background jobs (§10.1): each interval is guarded so a slow run never overlaps itself. */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly busy = new Set<string>();
  private readonly canaryRunning = new Set<number>();

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.every("status", 10_000, () => this.pollAll());
    this.every("deposits", 1_000, () => this.drainDeposits());
    this.every("canary", 10_000, () => this.scheduleCanaries());
    this.every("finalizer", 30_000, () => this.finalizeAll());
    this.every("autoclose", 60_000, () => this.autoCloseAll());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Poll one contest now (after a break, a void, a cancel), then try to finalize it. */
  poke(contestId: number): void {
    setTimeout(() => {
      void this.guard(`poke-${contestId}`, async () => {
        const row = this.ctx.db.contest(contestId);
        if (!row) return;
        await pollContest(this.ctx, row);
        const fresh = this.ctx.db.contest(contestId)!;
        if (fresh.status !== "active") await finalizeContest(this.ctx, fresh);
      });
    }, 1_000);
  }

  private every(name: string, ms: number, fn: () => Promise<void>): void {
    this.timers.push(setInterval(() => void this.guard(name, fn), ms));
  }

  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    try {
      await fn();
    } catch (err) {
      this.ctx.log(`job ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy.delete(name);
    }
  }

  private async pollAll(): Promise<void> {
    for (const row of this.ctx.db.contests("finalized = 0")) {
      try {
        await pollContest(this.ctx, row);
      } catch (err) {
        this.ctx.log(`poll ${row.contest_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async drainDeposits(): Promise<void> {
    while (await processNextDeposit(this.ctx)) {
      // keep going until nothing is due
    }
  }

  private async scheduleCanaries(): Promise<void> {
    for (const row of this.ctx.db.contests("status = 'active' AND loaded = 1")) {
      if (!dueForRound(this.ctx, row, this.canaryRunning)) continue;
      const s = await this.ctx.state.get(row.contest_id).catch(() => null);
      if (s?.phase !== "open") continue;
      this.canaryRunning.add(row.contest_id);
      void runCanaryRound(this.ctx, row)
        .catch((err) => this.ctx.log(`canary round for ${row.contest_id} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.canaryRunning.delete(row.contest_id));
    }
  }

  private async finalizeAll(): Promise<void> {
    for (const row of this.ctx.db.contests("status != 'active' AND finalized = 0")) {
      try {
        await finalizeContest(this.ctx, row);
      } catch (err) {
        this.ctx.log(`finalize ${row.contest_id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async autoCloseAll(): Promise<void> {
    for (const row of this.ctx.db.contests("status = 'active'")) await autoClose(this.ctx, row);
  }
}
