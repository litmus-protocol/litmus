// Breaker bot CLI (build plan §12.1).
//
//   pnpm --filter @defect/breaker-bot start hunt [--max-price 0.1] [--wait] [--contest <id>] [--max-attempts 30] [--budget 2] [--strategy mixed]
//   pnpm --filter @defect/breaker-bot start attack --contest <id> [--max-attempts 30] [--budget 2] [--strategy mixed]
//   pnpm --filter @defect/breaker-bot start chat --contest <id> [--as bot|human]   (default --as human)
//   pnpm --filter @defect/breaker-bot start register-agent --site <url> [--force]   (one-time ERC-8004 registration)
//   pnpm --filter @defect/breaker-bot start status --contest <id> [--as bot|human] (default --as bot)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { USDC_TOKEN_ID, fromBaseUnits, getTokenBalance, hashscanTx, toBaseUnits, type ContestDetail } from "@defect/shared";
import { runAttack, waitForEnd } from "./attack";
import { RouterAttacker } from "./attacker";
import { assertCanRegister, registerBotAgent } from "./agent-identity";
import { ChainClaimer } from "./claim";
import { pickTarget } from "./discover";
import { loadConfig, requireAttackerKey, type BotConfig, type Role } from "./config";
import { findSecret } from "./detect";
import { HttpGateway } from "./gateway";
import { STRATEGIES, type Strategy } from "./prompts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  start hunt [--max-price 0.1] [--wait] [--contest <id>] [--max-attempts 30] [--budget 2] [--strategy transfer|secret|forbidden|mixed]",
      "  start attack --contest <id> [--max-attempts 30] [--budget 2] [--strategy transfer|secret|forbidden|mixed]",
      "  start chat --contest <id> [--as bot|human]",
      "  start status --contest <id> [--as bot|human]",
      "  start register-agent --site <url> [--force]",
    ].join("\n"),
  );
  process.exit(1);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

function role(value: string | undefined, fallback: Role): Role {
  const r = value ?? fallback;
  if (r !== "bot" && r !== "human") throw new Error("--as must be bot or human");
  return r;
}

function describe(contest: ContestDetail): string {
  const left = contest.phase === "open" ? `${Math.max(0, contest.endTime - Math.floor(Date.now() / 1000))} s left` : contest.phase;
  const rules = contest.invariants.map((i, n) => `  ${n + 1}. [${i.type}] ${i.text}`).join("\n");
  return `#${contest.contestId} ${contest.card.name} · ${contest.phase} · ${left}\n  pool ${contest.pool} USDC · ${contest.messagePrice} USDC/message · ${contest.messageCount} messages\n${rules}`;
}

async function walletLine(config: BotConfig): Promise<string> {
  const units = await getTokenBalance(config.wallet.accountId, USDC_TOKEN_ID, { mirrorNodeUrl: config.mirrorNodeUrl }).catch(() => null);
  const usdc = units === null ? "unknown" : fromBaseUnits(units);
  return `Wallet (${config.wallet.role}) ${config.wallet.accountId} · ${config.wallet.address} · ${usdc} USDC`;
}

interface RunFlags {
  strategy: Strategy;
  budgetUnits: bigint;
  maxAttempts: number;
}

function runFlags(args: string[]): RunFlags {
  const strategy = (flag(args, "strategy") ?? "mixed") as Strategy;
  if (!STRATEGIES.includes(strategy)) throw new Error(`--strategy must be one of ${STRATEGIES.join(", ")}`);
  return {
    strategy,
    budgetUnits: toBaseUnits(flag(args, "budget") ?? "2"),
    maxAttempts: positiveInt(flag(args, "max-attempts"), 30, "max-attempts"),
  };
}

async function attack(args: string[], contestId: number): Promise<void> {
  const run = runFlags(args);
  const config = loadConfig("bot");
  requireAttackerKey(config);
  console.log(await walletLine(config));
  // Spend controls: never pay more than this contest's message price for one message.
  const probe = new HttpGateway(config.gatewayUrl, config.wallet, 0n);
  const priceUnits = toBaseUnits((await probe.getContest(contestId)).messagePrice);
  const gateway = new HttpGateway(config.gatewayUrl, config.wallet, priceUnits, config.agentId);
  await runAndReport(config, gateway, contestId, run);
}

/** Contests closing sooner than this are skipped: a run needs time for replies and a commit/reveal. */
const HUNT_MIN_SECONDS_LEFT = 120;
const HUNT_POLL_MS = 30_000;

/**
 * Finds its own target: reads the gateway's x402 discovery document, picks the open contest with
 * the largest pool it can afford, and attacks it, paying the discovered URL and payee only.
 */
async function hunt(args: string[]): Promise<void> {
  const run = runFlags(args);
  const maxPriceUnits = toBaseUnits(flag(args, "max-price") ?? "0.1");
  const only = flag(args, "contest") === undefined ? undefined : positiveInt(flag(args, "contest"), 0, "contest");
  const wait = args.includes("--wait");

  const config = loadConfig("bot");
  requireAttackerKey(config);
  console.log(await walletLine(config));
  const probe = new HttpGateway(config.gatewayUrl, config.wallet, 0n);
  console.log(`Discovering paid endpoints at ${config.gatewayUrl}/.well-known/x402 (cap ${fromBaseUnits(maxPriceUnits)} USDC/message)`);
  let target = null;
  for (;;) {
    const discovery = await probe.discover();
    const pick = pickTarget(discovery, { maxPriceUnits, now: Math.floor(Date.now() / 1000), minSecondsLeft: HUNT_MIN_SECONDS_LEFT, contestId: only });
    console.log(`  ${discovery.items.length} paid endpoint(s) listed`);
    for (const s of pick.skipped) console.log(`  skip #${s.contestId}: ${s.reason}`);
    target = pick.target;
    if (target || !wait) break;
    console.log(`  nothing to attack yet; looking again in ${HUNT_POLL_MS / 1000} s`);
    await new Promise((res) => setTimeout(res, HUNT_POLL_MS));
  }
  if (!target) {
    console.log("No open contest this bot can pay for. Pass --wait to keep looking.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Target #${target.contestId} ${target.agentName} · pool ${target.pool} USDC · ${fromBaseUnits(target.priceUnits)} USDC/message · ` +
      `closes in ${target.endTime - Math.floor(Date.now() / 1000)} s\n  POST ${target.url} · pays ${target.payTo}\n` +
      target.rules.map((r, n) => `  ${n + 1}. ${r}`).join("\n"),
  );
  const gateway = new HttpGateway(config.gatewayUrl, config.wallet, target.priceUnits, config.agentId, target);
  await runAndReport(config, gateway, target.contestId, run);
}

async function runAndReport(config: BotConfig, gateway: HttpGateway, contestId: number, run: RunFlags): Promise<void> {
  const { arena } = await gateway.getConfig();
  const summary = await runAttack(
    { contestId, maxAttempts: run.maxAttempts, budgetUnits: run.budgetUnits, strategy: run.strategy, ownAddress: config.wallet.address },
    {
      gateway,
      attacker: new RouterAttacker(config.og.baseUrl, config.og.apiKey, config.og.model),
      claimer: new ChainClaimer(config, arena),
      log: (line) => console.log(line),
    },
  );

  const runsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");
  mkdirSync(runsDir, { recursive: true });
  const file = join(runsDir, `${summary.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `\nOutcome: ${summary.outcome}${summary.error ? ` (${summary.error})` : ""} · ${summary.attempts} attempts · ` +
      `${summary.charged} charged · ${summary.usdcSpent} USDC spent · bot 0G calls ${summary.botOg.calls}` +
      `${summary.winnings ? ` · won ${summary.winnings} USDC` : ""}`,
  );
  console.log(`Summary: ${file}`);
  if (summary.outcome === "error" || summary.outcome === "claim_failed") process.exitCode = 1;
}

async function chat(args: string[], contestId: number): Promise<void> {
  const config = loadConfig(role(flag(args, "as"), "human"));
  // X-Agent-Id identifies the bot's ERC-8004 agent, so only the bot wallet sends it.
  const gateway = new HttpGateway(config.gatewayUrl, config.wallet, 10n ** 6n, config.wallet.role === "bot" ? config.agentId : null);
  const claimer = new ChainClaimer(config, (await gateway.getConfig()).arena);
  let contest = await gateway.getContest(contestId);
  console.log(`${await walletLine(config)}\n${describe(contest)}\n`);
  if (contest.phase !== "open") {
    console.log("Chat opens only while the contest is open.");
    return;
  }
  const targets = contest.invariants.flatMap((inv, invariantIndex) =>
    inv.type === "secret" ? [{ invariantIndex, secretHash: inv.secretHash }] : [],
  );
  const replies: string[] = [];
  // Lines are read as a stream, so piped input (a scripted demo) works as well as typing.
  const rl = createInterface({ input: process.stdin, terminal: false });
  console.log(`Each message costs ${contest.messagePrice} USDC (slow replies are free). Empty line to quit.`);
  process.stdout.write("\nyou> ");
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (!text) break;
      if (!process.stdin.isTTY) console.log(text);
      const sent = await gateway.send(contestId, text);
      if (!sent.ok) {
        console.log(`  ✗ HTTP ${sent.status} ${sent.code}: ${sent.message}`);
        if (sent.code === "CONTEST_NOT_OPEN") break;
        continue;
      }
      const r = sent.result;
      console.log(`agent> ${r.reply || "(no reply)"}`);
      for (const t of r.toolCalls) {
        console.log(
          `  tool ${t.name} ${JSON.stringify(t.args)} → ${JSON.stringify(t.result)}${t.txHash ? ` · ${hashscanTx(t.txHash)}` : ""}${t.broke ? " · BROKE A RULE" : ""}`,
        );
      }
      console.log(
        `  ${r.charged ? `charged ${contest.messagePrice} USDC` : "not charged"}${r.settlement ? ` · ${r.settlement.hashscan}` : ""} · ${r.latencyMs} ms${r.og[0] ? ` · 0G ${r.og[0].requestId}` : ""}`,
      );
      if (r.contestBroken) {
        contest = await waitForEnd(gateway, contestId, (ms) => new Promise((res) => setTimeout(res, ms)));
        console.log(`\n*** CONTEST BROKEN *** winner ${contest.winner} · pool ${contest.pool} USDC`);
        break;
      }
      replies.push(r.reply);
      const found = findSecret(replies, targets);
      if (found) {
        console.log(`\nSecret found: ${found.secret}. Claiming the pool…`);
        await claimer.claim(contestId, found.invariantIndex, found.secret, (line) => console.log(line));
        contest = await waitForEnd(gateway, contestId, (ms) => new Promise((res) => setTimeout(res, ms)));
        console.log(`*** CONTEST BROKEN *** winner ${contest.winner} · pool ${contest.pool} USDC`);
        break;
      }
      process.stdout.write("\nyou> ");
    }
  } finally {
    rl.close();
  }
}

async function status(args: string[], contestId: number): Promise<void> {
  const config = loadConfig(role(flag(args, "as"), "bot"));
  const gateway = new HttpGateway(config.gatewayUrl, config.wallet, 1n);
  console.log(await walletLine(config));
  console.log(describe(await gateway.getContest(contestId)));
}

async function registerAgent(args: string[]): Promise<void> {
  const site = flag(args, "site");
  if (!site) throw new Error("register-agent requires --site <url> (the public web app URL for the agent card).");
  try {
    new URL(site);
  } catch {
    throw new Error(`--site must be a full URL (got "${site}")`);
  }
  const config = loadConfig("bot");
  assertCanRegister(config, args.includes("--force"));
  console.log(await walletLine(config));
  await registerBotAgent(config, site);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "register-agent") return registerAgent(args);
  if (command === "hunt") return hunt(args);
  const contestArg = flag(args, "contest");
  if (!command || !contestArg) usage();
  const contestId = positiveInt(contestArg, 0, "contest");
  if (command === "attack") return attack(args, contestId);
  if (command === "chat") return chat(args, contestId);
  if (command === "status") return status(args, contestId);
  usage();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
