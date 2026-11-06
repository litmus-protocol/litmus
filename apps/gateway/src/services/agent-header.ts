import type { Address } from "viem";
import type { Ctx } from "../context";

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { ok: boolean; at: number }>();

/** Links still running; only here so tests can wait for them. Production never awaits it. */
const pending = new Set<Promise<void>>();

/** Parses the optional `X-Agent-Id` header: plain decimal digits only, anything else is ignored. */
export function parseAgentIdHeader(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

/**
 * Records which ERC-8004 agent a Breaker's attempt belongs to, but only when that agent's wallet or owner is the
 * paying Breaker (so a spoofed header links nothing). Best effort: errors are swallowed and never cached.
 */
export async function linkAttemptAgent(ctx: Ctx, attemptId: string, agentId: number, breaker: Address): Promise<void> {
  try {
    if (!ctx.settings.erc8004) return;
    const b = breaker.toLowerCase();
    const key = `${agentId}:${b}`;
    let hit = cache.get(key);
    if (!hit || ctx.now() * 1000 - hit.at > CACHE_MS) {
      const [wallet, owner] = [await ctx.chain.agentWallet(agentId), await ctx.chain.agentOwner(agentId)];
      hit = { ok: wallet?.toLowerCase() === b || owner?.toLowerCase() === b, at: ctx.now() * 1000 };
      cache.set(key, hit);
    }
    if (hit.ok) ctx.db.run("UPDATE attempts SET agent_id = ? WHERE attempt_id = ?", [agentId, attemptId]);
  } catch (err) {
    ctx.log(`agent link ${attemptId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Starts a link without ever affecting the caller. */
export function linkAttemptAgentInBackground(ctx: Ctx, attemptId: string, agentId: number, breaker: Address): void {
  const p = linkAttemptAgent(ctx, attemptId, agentId, breaker).finally(() => pending.delete(p));
  pending.add(p);
}

/** Test hook: resolves once every background link has finished. */
export async function flushAgentLinks(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** Test hook: forget cached wallet/owner checks. */
export function clearAgentLinkCache(): void {
  cache.clear();
}
