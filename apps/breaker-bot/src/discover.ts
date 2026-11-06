import { USDC_TOKEN_ID, X402_NETWORK, toBaseUnits, type X402Discovery } from "@defect/shared";
import type { PinnedEndpoint } from "./gateway";

// Picks a paid endpoint from GET /.well-known/x402, so `hunt` needs no contest id from a human.

export interface PickOptions {
  /** Never pay more than this per message (base units). */
  maxPriceUnits: bigint;
  /** Unix seconds. */
  now: number;
  /** Skip contests closing sooner than this; a run needs time for replies and a commit/reveal. */
  minSecondsLeft: number;
  /** Only this contest, when set. */
  contestId?: number;
}

export interface Target extends PinnedEndpoint {
  priceUnits: bigint;
  agentName: string;
  pool: string;
  endTime: number;
  rules: string[];
}

export interface Pick {
  target: Target | null;
  skipped: { contestId: number; reason: string }[];
}

/** The open contest with the largest pool (then the most time left) that this bot can pay for. */
export function pickTarget(discovery: X402Discovery, opts: PickOptions): Pick {
  const skipped: Pick["skipped"] = [];
  const candidates: Target[] = [];
  for (const item of discovery.items ?? []) {
    const contestId = item.metadata?.contestId;
    if (opts.contestId !== undefined && contestId !== opts.contestId) continue;
    const skip = (reason: string) => skipped.push({ contestId, reason });
    if (item.x402Version !== 2 || item.input?.method !== "POST") {
      skip("not an x402 v2 POST endpoint");
      continue;
    }
    const accept = item.accepts.find((a) => a.scheme === "exact" && a.network === X402_NETWORK && a.asset === USDC_TOKEN_ID);
    if (!accept) {
      skip(`no exact USDC payment on ${X402_NETWORK}`);
      continue;
    }
    const priceUnits = BigInt(accept.amount);
    if (priceUnits > opts.maxPriceUnits) {
      skip(`price ${accept.amount} units is above the cap of ${opts.maxPriceUnits}`);
      continue;
    }
    const left = item.metadata.endTime - opts.now;
    if (left < opts.minSecondsLeft) {
      skip(`closes in ${Math.max(0, left)} s`);
      continue;
    }
    candidates.push({
      contestId,
      url: item.resource,
      payTo: accept.payTo,
      priceUnits,
      agentName: item.metadata.agentName,
      pool: item.metadata.pool,
      endTime: item.metadata.endTime,
      rules: item.metadata.rules,
    });
  }
  candidates.sort((a, b) => {
    const pool = toBaseUnits(b.pool) - toBaseUnits(a.pool);
    return pool !== 0n ? (pool > 0n ? 1 : -1) : b.endTime - a.endTime;
  });
  return { target: candidates[0] ?? null, skipped };
}
