import { keccak256, toBytes } from "viem";
import type { Ctx } from "../context";
import type { AttemptRow } from "../db";

/** Retry delays after a failed depositFee (§10.6): 5 s, 15 s, 45 s, then `failed`. */
export const DEPOSIT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * Forwards one settled fee to the contract (§10.6). Processes the oldest due deposit; returns false
 * when there was nothing to do. The caller loops; the chain client's queue keeps one operator nonce.
 */
export async function processNextDeposit(ctx: Ctx): Promise<boolean> {
  const a = ctx.db.get<AttemptRow>(
    `SELECT * FROM attempts WHERE deposit_status = 'pending' AND (deposit_next_at IS NULL OR deposit_next_at <= ?)
     ORDER BY settled_at ASC, attempt_id ASC LIMIT 1`,
    [Date.now()],
  );
  if (!a) return false;
  try {
    const tx = await ctx.chain.depositFee(a.contest_id, a.breaker as `0x${string}`, BigInt(a.amount), keccak256(toBytes(a.settle_tx!)));
    ctx.db.run("UPDATE attempts SET deposit_status = 'done', deposit_tx = ? WHERE attempt_id = ?", [tx, a.attempt_id]);
    ctx.state.invalidate(a.contest_id);
  } catch (err) {
    const tries = a.deposit_tries + 1;
    const msg = err instanceof Error ? err.message : String(err);
    if (tries > DEPOSIT_RETRY_DELAYS_MS.length) {
      ctx.db.run("UPDATE attempts SET deposit_status = 'failed', deposit_tries = ? WHERE attempt_id = ?", [tries, a.attempt_id]);
      ctx.log(`ERROR deposit failed for attempt ${a.attempt_id} after ${tries} tries: ${msg}. Retry with: pnpm --filter @defect/gateway deposit:retry ${a.attempt_id}`);
    } else {
      ctx.db.run("UPDATE attempts SET deposit_tries = ?, deposit_next_at = ? WHERE attempt_id = ?", [
        tries,
        Date.now() + DEPOSIT_RETRY_DELAYS_MS[tries - 1]!,
        a.attempt_id,
      ]);
      ctx.log(`deposit for attempt ${a.attempt_id} failed (try ${tries}), retrying: ${msg}`);
    }
  }
  return true;
}

export function pendingDeposits(ctx: Ctx, contestId: number): number {
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE contest_id = ? AND deposit_status = 'pending'", [contestId])!.n;
}
