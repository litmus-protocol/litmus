import { fromBaseUnits, type BotTurn } from "@defect/shared";
import { runAttack, type RunSummary } from "./attack";
import { RouterAttacker } from "./attacker";
import { ChainClaimer } from "./claim";
import type { BotConfig } from "./config";
import { pickTarget, type Target } from "./discover";
import { HttpGateway } from "./gateway";
import type { Strategy } from "./prompts";

// Discover → pick → attack, shared by the CLI (`hunt`) and the gateway's "Run breaker bot" button.

export interface RunFlags {
  strategy: Strategy;
  budgetUnits: bigint;
  maxAttempts: number;
}

export interface HuntOptions extends RunFlags {
  /** Never pay more than this per message (base units). */
  maxPriceUnits: bigint;
  /** Only this contest, when set. */
  contestId?: number;
  /** Keep looking until a contest opens. */
  wait?: boolean;
  /** Contests closing sooner than this are skipped: a run needs time for replies and a commit/reveal. */
  minSecondsLeft?: number;
  pollMs?: number;
}

export interface HuntResult {
  target: Target | null;
  summary: RunSummary | null;
}

export const HUNT_MIN_SECONDS_LEFT = 120;
const HUNT_POLL_MS = 30_000;

/** Runs the attack loop against one contest, paying through `gateway`. */
export async function attackWith(
  config: BotConfig,
  gateway: HttpGateway,
  contestId: number,
  run: RunFlags,
  log: (line: string) => void,
  onTurn?: (turn: BotTurn) => void,
): Promise<RunSummary> {
  const { arena } = await gateway.getConfig();
  return runAttack(
    { contestId, maxAttempts: run.maxAttempts, budgetUnits: run.budgetUnits, strategy: run.strategy, ownAddress: config.wallet.address },
    {
      gateway,
      attacker: new RouterAttacker(config.og.baseUrl, config.og.apiKey, config.og.model),
      claimer: new ChainClaimer(config, arena),
      log,
      onTurn,
    },
  );
}

/**
 * Finds its own target: reads the gateway's x402 discovery document, picks the open contest with
 * the largest pool it can afford, and attacks it, paying the discovered URL and payee only.
 */
export async function hunt(config: BotConfig, opts: HuntOptions, log: (line: string) => void, onTurn?: (turn: BotTurn) => void): Promise<HuntResult> {
  const probe = new HttpGateway(config.gatewayUrl, config.wallet, 0n);
  log(`Discovering paid endpoints at ${config.gatewayUrl}/.well-known/x402 (cap ${fromBaseUnits(opts.maxPriceUnits)} USDC/message)`);
  let target: Target | null = null;
  for (;;) {
    const discovery = await probe.discover();
    const pick = pickTarget(discovery, {
      maxPriceUnits: opts.maxPriceUnits,
      now: Math.floor(Date.now() / 1000),
      minSecondsLeft: opts.minSecondsLeft ?? HUNT_MIN_SECONDS_LEFT,
      contestId: opts.contestId,
    });
    log(`  ${discovery.items.length} paid endpoint(s) listed`);
    for (const s of pick.skipped) log(`  skip #${s.contestId}: ${s.reason}`);
    target = pick.target;
    if (target || !opts.wait) break;
    const pollMs = opts.pollMs ?? HUNT_POLL_MS;
    log(`  nothing to attack yet; looking again in ${pollMs / 1000} s`);
    await new Promise((res) => setTimeout(res, pollMs));
  }
  if (!target) {
    log("No open contest this bot can pay for.");
    return { target: null, summary: null };
  }
  log(
    `Target #${target.contestId} ${target.agentName} · pool ${target.pool} USDC · ${fromBaseUnits(target.priceUnits)} USDC/message · ` +
      `closes in ${target.endTime - Math.floor(Date.now() / 1000)} s`,
  );
  log(`  POST ${target.url} · pays ${target.payTo}`);
  target.rules.forEach((r, n) => log(`  ${n + 1}. ${r}`));
  const gateway = new HttpGateway(config.gatewayUrl, config.wallet, target.priceUnits, config.agentId, target);
  return { target, summary: await attackWith(config, gateway, target.contestId, opts, log, onTurn) };
}
