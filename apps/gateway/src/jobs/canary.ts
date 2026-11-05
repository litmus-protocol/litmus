import {
  CANARY_MAX_CONCURRENCY,
  CANARY_ROUND_FAIL_AT,
  CANARY_VOID_AFTER_ROUNDS,
  GATEWAY_RUN_TIMEOUT_MS,
  MAX_REFUNDS_PER_CALL,
  type CanaryTask,
  type RunResult,
} from "@defect/shared";
import type { Ctx } from "../context";
import type { AttemptRow, CanaryRoundRow, ContestRow } from "../db";
import { canaryRecord, signRecord } from "../records";
import { pendingDeposits } from "./deposits";

export interface TaskResult {
  taskId: string;
  passed: boolean;
  reasons: string[];
  ogRequestIds: string[];
}

/** A task passes if the run succeeded, every mustContain appears (case-insensitive) and expectTool was called (§10.7 step 2). */
export function evaluateTask(task: CanaryTask, run: RunResult | null, error?: string): TaskResult {
  const reasons: string[] = [];
  if (!run) {
    reasons.push(`run failed: ${error ?? "unknown error"}`);
    return { taskId: task.id, passed: false, reasons, ogRequestIds: [] };
  }
  const reply = run.reply.toLowerCase();
  for (const s of task.mustContain ?? []) if (!reply.includes(s.toLowerCase())) reasons.push(`reply lacks "${s}"`);
  if (task.expectTool && !run.toolCalls.some((t) => t.name === task.expectTool)) reasons.push(`did not call ${task.expectTool}`);
  return { taskId: task.id, passed: reasons.length === 0, reasons, ogRequestIds: run.og.map((o) => o.requestId) };
}

/** Round passes when failures < CANARY_ROUND_FAIL_AT (D15: fails at 2 or more). */
export function roundPassed(results: TaskResult[]): boolean {
  return results.filter((r) => !r.passed).length < CANARY_ROUND_FAIL_AT;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Contests whose next round is due: open, not running, and interval elapsed since the last round (or since start). */
export function dueForRound(ctx: Ctx, row: ContestRow, running: Set<number>): boolean {
  if (running.has(row.contest_id)) return false;
  const last = ctx.db.get<{ started_at: number }>("SELECT started_at FROM canary_rounds WHERE contest_id = ? ORDER BY round DESC LIMIT 1", [
    row.contest_id,
  ]);
  const since = last?.started_at ?? row.start_time;
  return ctx.now() - since >= ctx.settings.canaryIntervalSec;
}

/** Runs one canary round for an open contest and applies refunds / void (§10.7). */
export async function runCanaryRound(ctx: Ctx, row: ContestRow, opts: { depositWaitMs?: number } = {}): Promise<CanaryRoundRow> {
  const contestId = row.contest_id;
  const tasks = JSON.parse(row.canaries_json) as CanaryTask[];
  const lastRound = ctx.db.get<{ round: number }>("SELECT MAX(round) AS round FROM canary_rounds WHERE contest_id = ?", [contestId]);
  const round = (lastRound?.round ?? 0) + 1;
  const startedAt = ctx.now();

  const results = await mapLimit(tasks, CANARY_MAX_CONCURRENCY, async (task) => {
    try {
      const run = await ctx.runner.run(
        { contestId, attemptId: `canary-${round}-${task.id}`, mode: "canary", breaker: null, history: [], text: task.prompt },
        GATEWAY_RUN_TIMEOUT_MS,
      );
      return evaluateTask(task, run);
    } catch (err) {
      return evaluateTask(task, null, err instanceof Error ? err.message : String(err));
    }
  });
  const failures = results.filter((r) => !r.passed).length;
  const passed = roundPassed(results);

  let action: "none" | "refund" | "void" = "none";
  let actionTx: string | null = null;
  if (passed) {
    ctx.db.run("UPDATE contests SET consecutive_failed_rounds = 0, last_passing_round_at = ? WHERE contest_id = ?", [startedAt, contestId]);
  } else {
    ctx.db.run("UPDATE contests SET consecutive_failed_rounds = consecutive_failed_rounds + 1 WHERE contest_id = ?", [contestId]);
    const fresh = ctx.db.contest(contestId)!;
    const voiding = fresh.consecutive_failed_rounds >= CANARY_VOID_AFTER_ROUNDS;
    const r = await refundSinceLastPass(ctx, fresh, voiding, opts.depositWaitMs ?? 120_000);
    action = r.action;
    actionTx = r.tx;
  }

  ctx.db.run(
    "INSERT INTO canary_rounds (contest_id, round, started_at, results_json, failures, passed, action, action_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [contestId, round, startedAt, JSON.stringify(results), failures, passed ? 1 : 0, action, actionTx],
  );
  const stored = ctx.db.get<CanaryRoundRow>("SELECT * FROM canary_rounds WHERE contest_id = ? AND round = ?", [contestId, round])!;
  const { recordHash, signature } = await signRecord(canaryRecord(stored), ctx.signer);
  ctx.db.run("UPDATE canary_rounds SET record_hash = ?, signature = ? WHERE id = ?", [recordHash, signature, stored.id]);
  ctx.log(`canary round ${round} for contest ${contestId}: ${passed ? "passed" : "FAILED"} (${failures} of ${tasks.length} failed) → ${action}`);
  if (action === "void") {
    ctx.state.invalidate(contestId);
    ctx.pokeStatus(contestId);
  }
  return { ...stored, record_hash: recordHash, signature };
}

/**
 * §10.7 step 5: wait for pending deposits, refund failed deposits directly from the operator, and refund
 * deposited fees through the contract (escrow, then bond). On the 3rd failed round, void instead.
 */
async function refundSinceLastPass(
  ctx: Ctx,
  row: ContestRow,
  voiding: boolean,
  depositWaitMs: number,
): Promise<{ action: "none" | "refund" | "void"; tx: string | null }> {
  const contestId = row.contest_id;
  const deadline = Date.now() + depositWaitMs;
  while (pendingDeposits(ctx, contestId) > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2_000));

  const since = row.last_passing_round_at ?? row.start_time;
  const due = ctx.db.attempts(contestId, "outcome = 'charged' AND refunded = 0 AND deposit_status IN ('done','failed') AND settled_at > ?", [since]);

  // Fees that never reached the contract go straight back from the operator.
  for (const a of due.filter((x) => x.deposit_status === "failed")) {
    try {
      const tx = await ctx.chain.transferUsdc(a.breaker as `0x${string}`, BigInt(a.amount));
      ctx.db.run("UPDATE attempts SET deposit_status = 'refunded_direct', refunded = 1, refund_tx = ? WHERE attempt_id = ?", [tx, a.attempt_id]);
    } catch (err) {
      ctx.log(`direct refund failed for attempt ${a.attempt_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deposited = due.filter((x) => x.deposit_status === "done");
  const perBreaker = new Map<string, { amount: bigint; attempts: AttemptRow[] }>();
  for (const a of deposited) {
    const e = perBreaker.get(a.breaker) ?? { amount: 0n, attempts: [] };
    e.amount += BigInt(a.amount);
    e.attempts.push(a);
    perBreaker.set(a.breaker, e);
  }
  const entries = [...perBreaker.entries()];
  const batches: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += MAX_REFUNDS_PER_CALL) batches.push(entries.slice(i, i + MAX_REFUNDS_PER_CALL));
  if (voiding && batches.length === 0) batches.push([]);
  if (batches.length === 0) return { action: "none", tx: null };

  let lastTx: string | null = null;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const breakers = batch.map(([b]) => b as `0x${string}`);
    const amounts = batch.map(([, e]) => e.amount);
    const isVoid = voiding && i === batches.length - 1;
    try {
      lastTx = isVoid ? await ctx.chain.voidContest(contestId, breakers, amounts) : await ctx.chain.refund(contestId, breakers, amounts);
      const ids = batch.flatMap(([, e]) => e.attempts.map((a) => a.attempt_id));
      for (const id of ids) ctx.db.run("UPDATE attempts SET refunded = 1, refund_tx = ? WHERE attempt_id = ?", [lastTx, id]);
    } catch (err) {
      ctx.log(`${isVoid ? "voidContest" : "refund"} failed for contest ${contestId}: ${err instanceof Error ? err.message : String(err)}`);
      return { action: voiding ? "void" : "refund", tx: lastTx };
    }
  }
  return { action: voiding ? "void" : "refund", tx: lastTx };
}
