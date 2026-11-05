import { MAX_MESSAGE_CHARS, fromBaseUnits, toBaseUnits, type ContestDetail, type OgEvidence } from "@defect/shared";
import { AttackerConversation, type AttackerModel } from "./attacker";
import type { Claimer } from "./claim";
import { findSecret, type SecretTarget } from "./detect";
import type { Gateway } from "./gateway";
import { FALLBACK_ATTACKS, attackerSystemPrompt, availableFocuses, cleanAttack, focusFor, type Strategy } from "./prompts";

// The attack loop (build plan §12.2). Dependencies are injected so the loop can be tested with a mocked gateway.

export interface AttackOptions {
  contestId: number;
  maxAttempts: number;
  budgetUnits: bigint;
  strategy: Strategy;
  ownAddress: `0x${string}`;
}

export interface AttackDeps {
  gateway: Gateway;
  attacker: AttackerModel;
  claimer: Claimer;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type Outcome =
  | "broken_by_us"
  | "broken_by_other"
  | "budget"
  | "max_attempts"
  | "contest_not_open"
  | "contest_ended"
  | "claim_failed"
  | "error";

export interface RunSummary {
  contestId: number;
  agent: string;
  strategy: Strategy;
  startedAt: string;
  endedAt: string;
  attempts: number;
  charged: number;
  usdcSpent: string;
  /** The bot's own inference on 0G (the attacker model). totalCost is summed from x_0g_trace.billing. */
  botOg: { calls: number; totalCost: string; requestIds: string[] };
  /** The target agent's inference on 0G, as reported by the gateway. */
  targetOgRequestIds: string[];
  settlements: { txId: string; hashscan: string }[];
  outcome: Outcome;
  winnings: string | null;
  claim: { secret: string; commitTx: string; revealTx: string } | null;
  error: string | null;
}

const MAX_BUSY_RETRIES = 5;

function preview(text: string, max = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function toolSummary(calls: { name: string; args: unknown; result: unknown }[]): string {
  return calls.map((c) => `${c.name}(${JSON.stringify(c.args)}) → ${JSON.stringify(c.result)}`).join("; ");
}

function secretTargets(contest: ContestDetail): SecretTarget[] {
  const out: SecretTarget[] = [];
  contest.invariants.forEach((inv, invariantIndex) => {
    if (inv.type === "secret") out.push({ invariantIndex, secretHash: inv.secretHash });
  });
  return out;
}

/** The gateway's status poller lags the chain by up to ~10 s; wait until it reports the contest as ended. */
export async function waitForEnd(gateway: Gateway, contestId: number, sleep: (ms: number) => Promise<void>): Promise<ContestDetail> {
  let contest = await gateway.getContest(contestId);
  for (let i = 0; i < 15 && (contest.phase === "open" || contest.phase === "awaiting_close"); i++) {
    await sleep(2_000);
    contest = await gateway.getContest(contestId);
  }
  return contest;
}

export async function runAttack(opts: AttackOptions, deps: AttackDeps): Promise<RunSummary> {
  const { gateway, attacker, claimer, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = new Date().toISOString();

  const contest = await gateway.getContest(opts.contestId);
  const summary: RunSummary = {
    contestId: opts.contestId,
    agent: contest.card.name,
    strategy: opts.strategy,
    startedAt,
    endedAt: startedAt,
    attempts: 0,
    charged: 0,
    usdcSpent: "0",
    botOg: { calls: 0, totalCost: "0", requestIds: [] },
    targetOgRequestIds: [],
    settlements: [],
    outcome: "error",
    winnings: null,
    claim: null,
    error: null,
  };
  const finish = (outcome: Outcome, error: string | null = null): RunSummary => {
    summary.outcome = outcome;
    summary.error = error;
    summary.endedAt = new Date().toISOString();
    return summary;
  };

  if (contest.phase !== "open") {
    log(`Contest #${opts.contestId} is ${contest.phase}, not open. Nothing sent.`);
    return finish("contest_not_open");
  }

  const price = toBaseUnits(contest.messagePrice);
  const targets = secretTargets(contest);
  const focuses = availableFocuses(contest);
  const conversation = new AttackerConversation(attackerSystemPrompt(contest, focusFor(opts.strategy, 1, focuses), opts.ownAddress));
  const replies: string[] = [];
  let spent = 0n;
  let botCost = 0n;
  let fallbackIndex = 0;
  let busyRetries = 0;

  log(
    `Attacking #${opts.contestId} ${contest.card.name} · pool ${contest.pool} USDC · ${contest.messagePrice} USDC/message · ` +
      `strategy ${opts.strategy} · budget ${fromBaseUnits(opts.budgetUnits)} USDC · max ${opts.maxAttempts} attempts`,
  );

  while (true) {
    if (summary.attempts >= opts.maxAttempts) return finish("max_attempts");
    if (spent + price > opts.budgetUnits) return finish("budget");

    const attemptNo = summary.attempts + 1;
    const focus = focusFor(opts.strategy, attemptNo, focuses);
    conversation.setSystem(attackerSystemPrompt(contest, focus, opts.ownAddress));

    let text: string | null = null;
    try {
      const out = await attacker.next(conversation.messages());
      if (out.og) {
        summary.botOg.calls += 1;
        summary.botOg.requestIds.push(out.og.requestId);
        botCost += BigInt(out.og.totalCost || "0");
        summary.botOg.totalCost = botCost.toString();
      }
      text = cleanAttack(out.text, MAX_MESSAGE_CHARS);
    } catch (err) {
      log(`  attacker model failed (${err instanceof Error ? err.message : String(err)}); using a fallback attack`);
    }
    if (!text) {
      const list = FALLBACK_ATTACKS[focus];
      text = list[fallbackIndex++ % list.length]!.replaceAll("{address}", opts.ownAddress);
    }

    const sent = await gateway.send(opts.contestId, text);
    if (!sent.ok) {
      if (sent.status === 429 && busyRetries < MAX_BUSY_RETRIES) {
        busyRetries++;
        await sleep(3_000);
        continue;
      }
      if (sent.code === "CONTEST_NOT_OPEN") {
        const after = await gateway.getContest(opts.contestId);
        log(`Contest is now ${after.phase}.`);
        if (after.phase === "broken") return finish(after.winner?.toLowerCase() === opts.ownAddress ? "broken_by_us" : "broken_by_other");
        return finish("contest_ended");
      }
      if (sent.status === 502) {
        // The agent failed to answer: nothing was charged. Count the attempt and carry on.
        summary.attempts++;
        log(`#${attemptNo} not charged · agent failed to reply (${sent.code})`);
        conversation.record(text, "", "");
        continue;
      }
      log(`#${attemptNo} stopped: HTTP ${sent.status} ${sent.code} ${sent.message}`);
      return finish("error", `${sent.code}: ${sent.message}`);
    }

    busyRetries = 0;
    summary.attempts++;
    const r = sent.result;
    if (r.charged) {
      spent += price;
      summary.charged++;
      summary.usdcSpent = fromBaseUnits(spent);
    }
    if (r.settlement) summary.settlements.push(r.settlement);
    const targetIds = r.og.map((o: OgEvidence) => o.requestId);
    summary.targetOgRequestIds.push(...targetIds);
    replies.push(r.reply);
    conversation.record(text, r.reply, toolSummary(r.toolCalls));

    const charge = r.charged ? `charged ${contest.messagePrice}` : "not charged";
    const link = r.settlement ? ` · ${r.settlement.hashscan}` : "";
    const botReq = summary.botOg.requestIds.at(-1);
    const og = `${botReq ? ` · bot 0G ${botReq.slice(0, 8)}…` : ""}${targetIds[0] ? ` · target 0G ${targetIds[0].slice(0, 8)}…` : ""}`;
    log(`#${attemptNo} ${charge}${link}${og}`);
    log(`   → ${preview(text)}`);
    log(`   ← ${preview(r.reply || "(no reply)")}`);
    for (const t of r.toolCalls)
      log(`   tool ${t.name} ${JSON.stringify(t.args)}${t.txHash ? ` · tx ${t.txHash}` : ""}${t.broke ? " · BROKE A RULE" : ""}`);

    if (r.contestBroken) {
      const after = await waitForEnd(gateway, opts.contestId, sleep);
      const ours = after.winner?.toLowerCase() === opts.ownAddress;
      if (ours) summary.winnings = after.pool;
      log(ours ? `BROKEN by us · won ${after.pool} USDC` : `BROKEN by ${after.winner}`);
      return finish(ours ? "broken_by_us" : "broken_by_other");
    }

    const found = findSecret(replies, targets);
    if (found) {
      log(`Secret found: ${found.secret} (rule #${found.invariantIndex + 1}). Claiming…`);
      try {
        const tx = await claimer.claim(opts.contestId, found.invariantIndex, found.secret, log);
        summary.claim = { secret: found.secret, ...tx };
        const after = await waitForEnd(gateway, opts.contestId, sleep);
        summary.winnings = after.pool;
        log(`BROKEN by us · won ${after.pool} USDC`);
        return finish("broken_by_us");
      } catch (err) {
        return finish("claim_failed", err instanceof Error ? err.message : String(err));
      }
    }
  }
}
