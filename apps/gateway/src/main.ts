import { serve } from "@hono/node-server";
import { join } from "node:path";
import { MirrorAccountResolver } from "./accounts";
import { createApp } from "./app";
import { ViemGatewayChain } from "./chain";
import { loadConfig } from "./config";
import { ContestStateCache, type Ctx } from "./context";
import { Db } from "./db";
import { X402Payments } from "./payments";
import { operatorSigner } from "./records";
import { HttpRunnerClient } from "./runner-client";
import { Scheduler } from "./jobs/scheduler";
import { loadIntoRunner } from "./services/drafts";

/** Below this the operator re-approves the arena for USDC (§10.1); 10^15 units = 1e9 USDC (finite: HTS allowances are int64). */
const MIN_ALLOWANCE = 10n ** 12n;
const APPROVE_AMOUNT = 10n ** 15n;

const config = loadConfig();
const log = (msg: string) => console.log(`[gateway] ${new Date().toISOString()} ${msg}`);
const db = new Db(join(config.dataDir, "defect.db"));
const chain = new ViemGatewayChain({
  arena: config.arena,
  privateKey: config.operatorPrivateKey,
  rpcUrl: config.rpcUrl,
  mirrorNodeUrl: config.mirrorNodeUrl,
});
const payments = new X402Payments(config.operatorAccountId, config.facilitatorUrl);

let scheduler: Scheduler | null = null;
const ctx: Ctx = {
  db,
  chain,
  runner: new HttpRunnerClient(config.runnerUrl, config.runnerToken),
  payments,
  accounts: new MirrorAccountResolver(db, config.mirrorNodeUrl),
  signer: operatorSigner(config.operatorPrivateKey),
  state: new ContestStateCache(chain),
  settings: {
    arena: config.arena,
    deployment: config.deployment,
    operatorAccountId: config.operatorAccountId,
    allowedModels: config.allowedModels,
    canaryIntervalSec: config.canaryIntervalSec,
    mirrorNodeUrl: config.mirrorNodeUrl,
    attestations: config.attestations,
    publicUrl: config.publicUrl,
    windowSeconds: 0,
  },
  now: () => Math.floor(Date.now() / 1000),
  log,
  pokeStatus: (id) => scheduler?.poke(id),
};

async function startup(): Promise<void> {
  const expired = db.expirePendingAttempts(null);
  if (expired) log(`marked ${expired} interrupted attempt(s) as free_error`);

  ctx.settings.windowSeconds = await chain.windowSeconds();

  const allowance = await chain.usdcAllowance(chain.operatorAddress, config.arena);
  if (allowance < MIN_ALLOWANCE) {
    const tx = await chain.approveUsdc(config.arena, APPROVE_AMOUNT);
    log(`approved the arena for operator USDC: ${tx}`);
  }

  try {
    await payments.ready();
  } catch (err) {
    log(`WARNING x402 facilitator ${config.facilitatorUrl} unreachable (will retry on first message): ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const row of db.contests("status = 'active'")) {
    const r = await loadIntoRunner(ctx, row, { cancelOnMismatch: false });
    if (r !== "loaded") log(`re-load of contest ${row.contest_id} at startup: ${r}`);
  }
}

await startup();
scheduler = new Scheduler(ctx);
scheduler.start();

const app = createApp(ctx, { webOrigins: config.webOrigins });
serve({ fetch: app.fetch, port: config.port }, (info) => {
  log(
    `listening on http://localhost:${info.port} · ${config.deployment} arena ${config.arena} (window ${ctx.settings.windowSeconds}s) · operator ${chain.operatorAddress} / ${config.operatorAccountId} · runner ${config.runnerUrl} · facilitator ${config.facilitatorUrl}`,
  );
});
