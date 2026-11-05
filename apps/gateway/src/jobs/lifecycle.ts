import { REVEAL_GRACE_SECONDS, type ToolCallView } from "@defect/shared";
import { keccak256, toBytes, type Hex } from "viem";
import { STATUS } from "../chain";
import type { Ctx } from "../context";
import type { ContestRow, ContestStatus } from "../db";
import { attemptRecord, buildLog, signRecord } from "../records";
import { cancelContest, loadIntoRunner } from "../services/drafts";
import { pendingDeposits } from "./deposits";

const STATUS_NAME: Record<number, ContestStatus> = {
  [STATUS.Active]: "active",
  [STATUS.Broken]: "broken",
  [STATUS.Held]: "held",
  [STATUS.Void]: "void",
  [STATUS.Cancelled]: "cancelled",
};

/**
 * Status poller (§10.8, every 10 s, or poked after a break): syncs on-chain status into the DB,
 * records the final pool when a contest ends, and retries `load` for unloaded contests (§10.3.2).
 */
export async function pollContest(ctx: Ctx, row: ContestRow): Promise<void> {
  ctx.state.invalidate(row.contest_id);
  const s = await ctx.state.get(row.contest_id);
  const status = STATUS_NAME[s.status] ?? row.status;

  if (status === "active") {
    ctx.db.run("UPDATE contests SET last_pool = ? WHERE contest_id = ?", [s.pool.toString(), row.contest_id]);
    if (row.loaded !== 1) {
      const outcome = await loadIntoRunner(ctx, row);
      if (outcome === "unavailable" && ctx.now() >= row.start_time) {
        ctx.log(`contest ${row.contest_id} reached its start time without loading; cancelling`);
        await cancelContest(ctx, row.contest_id);
      }
    }
    return;
  }

  if (row.status !== status || row.ended_at === null) {
    const finalPool = await finalPoolFromEvents(ctx, row, status).catch(() => null);
    ctx.db.run(
      `UPDATE contests SET status = ?, winner = ?, broken_invariant = ?, ended_at = COALESCE(ended_at, ?),
         final_pool = COALESCE(?, final_pool, last_pool) WHERE contest_id = ?`,
      [
        status,
        status === "broken" ? s.winner : null,
        status === "broken" ? s.brokenInvariant : null,
        ctx.now(),
        finalPool,
        row.contest_id,
      ],
    );
    ctx.log(`contest ${row.contest_id} is now ${status}`);
  }
}

/** Broken → pool paid to the winner; Held → pool returned (from the events, since on-chain pool is zeroed). */
async function finalPoolFromEvents(ctx: Ctx, row: ContestRow, status: ContestStatus): Promise<string | null> {
  if (status !== "broken" && status !== "held") return null;
  const events = await ctx.chain.contestEvents(row.contest_id, row.start_time - 3600);
  const ev = events.find((e) => (status === "broken" ? e.name === "Broken" : e.name === "Held"));
  if (!ev) return null;
  const v = status === "broken" ? ev.args.payout : ev.args.poolReturned;
  return typeof v === "bigint" ? v.toString() : null;
}

/** Auto-close (§10.8, every 60 s): closeHeld for active contests past endTime + REVEAL_GRACE. */
export async function autoClose(ctx: Ctx, row: ContestRow): Promise<void> {
  if (row.status !== "active" || ctx.now() <= row.end_time + REVEAL_GRACE_SECONDS) return;
  try {
    await ctx.chain.closeHeld(row.contest_id);
    ctx.log(`closed contest ${row.contest_id} as held`);
  } catch (err) {
    ctx.log(`closeHeld(${row.contest_id}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  ctx.state.invalidate(row.contest_id);
  ctx.pokeStatus(row.contest_id);
}

/**
 * Finalizer (§10.8, every 30 s) for ended, non-finalized contests: expire stale attempts, wait for deposits,
 * reconcile vault events into attempts, fetch secrets, build the log, post its hash. Returns true when done.
 */
export async function finalizeContest(ctx: Ctx, row: ContestRow): Promise<boolean> {
  if (row.status === "active" || row.finalized === 1) return false;
  const id = row.contest_id;

  ctx.db.expirePendingAttempts(60_000, id);
  if (ctx.db.get("SELECT 1 AS x FROM attempts WHERE contest_id = ? AND outcome = 'pending'", [id])) return false;
  if (pendingDeposits(ctx, id) > 0) return false;

  await reconcileVaultEvents(ctx, row);

  if (row.secrets_json === null) {
    const { secrets } = await ctx.runner.secrets(id);
    ctx.db.run("UPDATE contests SET secrets_json = ? WHERE contest_id = ?", [JSON.stringify(secrets), id]);
  }

  const { logHash } = buildLog(ctx.db.attempts(id), ctx.db.canaryRounds(id));
  const onchain = await ctx.chain.getContest(id);
  if (/^0x0+$/.test(onchain.logHash)) {
    await ctx.chain.postLogHash(id, logHash);
  } else if (onchain.logHash.toLowerCase() !== logHash.toLowerCase()) {
    ctx.log(`WARNING contest ${id}: on-chain logHash ${onchain.logHash} differs from rebuilt ${logHash}`);
  }
  ctx.db.run("UPDATE contests SET log_hash = ?, finalized = 1 WHERE contest_id = ?", [logHash, id]);
  ctx.log(`finalized contest ${id}: logHash ${logHash}`);
  return true;
}

/**
 * §10.8 step 2: a vault transaction can land even when the run timed out and the attempt has no tool calls.
 * Match VaultSend / VaultEmergencyWithdraw events to attempts by keccak256(attemptId) and add what's missing.
 */
export async function reconcileVaultEvents(ctx: Ctx, row: ContestRow): Promise<number> {
  const events = await ctx.chain.contestEvents(row.contest_id, row.start_time - 3600);
  const broke = new Set(events.filter((e) => e.name === "Broken").map((e) => e.txHash.toLowerCase()));
  const attempts = ctx.db.attempts(row.contest_id, "outcome != 'pending'");
  const byHash = new Map(attempts.map((a) => [keccak256(toBytes(a.attempt_id)).toLowerCase(), a]));
  let fixed = 0;
  for (const ev of events) {
    if (ev.name !== "VaultSend" && ev.name !== "VaultEmergencyWithdraw") continue;
    const a = byHash.get(String(ev.args.attemptId).toLowerCase());
    if (!a) continue;
    const calls = a.tool_calls_json ? (JSON.parse(a.tool_calls_json) as ToolCallView[]) : [];
    if (calls.some((c) => c.txHash?.toLowerCase() === ev.txHash.toLowerCase())) continue;
    const didBreak = broke.has(ev.txHash.toLowerCase());
    calls.push({
      name: ev.name === "VaultSend" ? "vault_send" : "emergency_withdraw",
      args: null,
      result: null,
      txHash: ev.txHash as Hex,
      broke: didBreak,
    });
    ctx.db.run("UPDATE attempts SET tool_calls_json = ?, broke = CASE WHEN ? = 1 THEN 1 ELSE broke END WHERE attempt_id = ?", [
      JSON.stringify(calls),
      didBreak ? 1 : 0,
      a.attempt_id,
    ]);
    const updated = ctx.db.attempt(a.attempt_id)!;
    const { recordHash, signature } = await signRecord(attemptRecord(updated), ctx.signer);
    ctx.db.run("UPDATE attempts SET record_hash = ?, signature = ? WHERE attempt_id = ?", [recordHash, signature, a.attempt_id]);
    fixed++;
  }
  return fixed;
}
