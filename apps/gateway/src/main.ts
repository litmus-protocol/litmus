import { creAttestPreflight } from "./jobs/cre-attest";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { MirrorAccountResolver } from "./accounts";
import { createApp } from "./app";
import { ViemGatewayChain } from "./chain";
import { loadConfig, siteUrlWarnings } from "./config";
import { ContestStateCache, type Ctx } from "./context";
import { Db } from "./db";
import { X402Payments } from "./payments";
import { operatorSigner } from "./records";
import { HttpRunnerClient } from "./runner-client";
import { ViemFaucetChain, type Faucet } from "./faucet";
import { SerialQueue } from "./queue";
import { parseHbar } from "./services/faucet";
import { privyVerifier } from "./privy-auth";
import { ModelCatalog, toBaseUnits } from "@defect/shared";
import { privateKeyToAccount } from "viem/accounts";
import { Scheduler } from "./jobs/scheduler";
import { loadIntoRunner } from "./services/drafts";

/** Below this the operator re-approves the arena for USDC (§10.1); 10^15 units = 1e9 USDC (finite: HTS allowances are int64). */
const MIN_ALLOWANCE = 10n ** 12n;
const APPROVE_AMOUNT = 10n ** 15n;

const config = loadConfig();
const log = (msg: string) => console.log(`[gateway] ${new Date().toISOString()} ${msg}`);
const db = new Db(join(config.dataDir, "defect.db"));
const operatorWrites = new SerialQueue();
const chain = new ViemGatewayChain({
  writes: operatorWrites,
  arena: config.arena,
  certificate: config.certificate,
  attestations: config.attestations,
  sepoliaRpcUrl: config.sepoliaRpcUrl,
  erc8004: config.erc8004,
  privateKey: config.operatorPrivateKey,
  rpcUrl: config.rpcUrl,
  mirrorNodeUrl: config.mirrorNodeUrl,
});
let faucet: Faucet | null = null;
if (config.faucet) {
  const sameKey = privateKeyToAccount(config.faucet.privateKey).address === chain.operatorAddress;
  faucet = {
    chain: new ViemFaucetChain({
      privateKey: config.faucet.privateKey,
      rpcUrl: config.rpcUrl,
      mirrorNodeUrl: config.mirrorNodeUrl,
      // Same key as the operator: one nonce, so one queue.
      writes: sameKey ? operatorWrites : undefined,
    }),
    hbarTinybars: parseHbar(config.faucet.hbar),
    usdcUnits: toBaseUnits(config.faucet.usdc),
    dailyCap: config.faucet.dailyCap,
    perIpDailyCap: config.faucet.perIpDailyCap,
    proxyHops: config.faucet.proxyHops,
    privy: config.faucet.privy ? privyVerifier(config.faucet.privy.appId, config.faucet.privy.verificationKey) : null,
  };
  if (sameKey) log("WARNING FAUCET_PRIVATE_KEY is the operator key: faucet grants spend the operator's HBAR and USDC");
  if (!config.faucet.privy) log("WARNING faucet is open to any address (set PRIVY_APP_ID and PRIVY_VERIFICATION_KEY to require a Privy login)");
  if (config.faucet.proxyHops === 0 && config.faucet.perIpDailyCap > 0) {
    log("faucet: per-IP limit uses the socket address; behind a proxy (Railway) set TRUSTED_PROXY_HOPS=1 or every client shares one IP");
  }
}
const payments = new X402Payments(config.operatorAccountId, config.facilitatorUrl);

let scheduler: Scheduler | null = null;
const ctx: Ctx = {
  db,
  chain,
  runner: new HttpRunnerClient(config.runnerUrl, config.runnerToken),
  payments,
  accounts: new MirrorAccountResolver(db, config.mirrorNodeUrl),
  faucet,
  signer: operatorSigner(config.operatorPrivateKey),
  state: new ContestStateCache(chain),
  catalog: new ModelCatalog({ baseUrl: config.ogCatalogUrl, fallbackModels: config.allowedModels, log }),
  settings: {
    arena: config.arena,
    deployment: config.deployment,
    operatorAccountId: config.operatorAccountId,
    allowedModels: config.allowedModels,
    canaryIntervalSec: config.canaryIntervalSec,
    mirrorNodeUrl: config.mirrorNodeUrl,
    attestations: config.attestations,
    certificate: config.certificate,
    erc8004: config.erc8004,
    siteUrl: config.siteUrl,
    publicUrl: config.publicUrl,
    creAttest: config.creAttest ?? null,
    windowSeconds: 0,
  },
  now: () => Math.floor(Date.now() / 1000),
  log,
  pokeStatus: (id) => scheduler?.poke(id),
  onFinalized: () => scheduler?.attestSoon(),
};

async function startup(): Promise<void> {
  if (process.env.ARENA_ADDRESS_OVERRIDE && config.erc8004 === null) log("ARENA_ADDRESS_OVERRIDE is set: ERC-8004 agent identity is off");
  for (const w of siteUrlWarnings(config, process.env.SITE_URL)) log(w);
  if (config.certificate && !config.attestations) log("WARNING no DefectAttestations configured: Held certificates wait for a passing CRE audit, so none will be minted");
  if (/^(1|true|yes|on)$/i.test(process.env.CRE_AUTO_ATTEST ?? "")) {
    if (!config.creAttest) log("WARNING CRE_AUTO_ATTEST is set but CRE_ETH_PRIVATE_KEY is missing or invalid; auto-attest stays off");
    else {
      const problems = creAttestPreflight(config.creAttest);
      if (problems.length) {
        for (const p of problems) log(`WARNING CRE auto-attest is off: ${p}`);
        ctx.settings.creAttest = null;
      } else log(`CRE auto-attest ON: Held/Broken contests are audited by the CRE auditor (${config.creAttest.bin}) and attested on Sepolia`);
    }
  }
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
    `listening on http://localhost:${info.port} · faucet ${faucet ? `${faucet.chain.address} (${config.faucet!.hbar} HBAR + ${config.faucet!.usdc} USDC, ${config.faucet!.dailyCap}/day)` : "off"} · ${config.deployment} arena ${config.arena} (window ${ctx.settings.windowSeconds}s) · operator ${chain.operatorAddress} / ${config.operatorAccountId} · runner ${config.runnerUrl} · facilitator ${config.facilitatorUrl}`,
  );
});
