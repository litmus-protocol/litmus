import {
  HEDERA_TESTNET_CHAIN_ID,
  agentRegistryId,
  feedbackTag2,
  toJsonDataUri,
  type DefectFeedbackFile,
  type FeedbackTag1,
} from "@defect/shared";
import type { Hex } from "viem";
import type { Ctx } from "../context";
import type { ContestRow } from "../db";
import { uniquePayingBreakers } from "./lifecycle";

type Facts = {
  /** Pool paid out (Broken: the Broken event's payout) or returned (Held), in USDC base units. */
  finalPool: string;
  messageCount: number;
  uniqueBreakers: number;
  breakTx: Hex | null;
  logHash: Hex | null;
  status: "held" | "broken";
  packageHash: Hex;
};

type Variant = {
  agentId: number;
  tag1: FeedbackTag1;
  value: number;
  valueDecimals: number;
  proofOfPayment?: DefectFeedbackFile["proofOfPayment"];
};

/** The shared body of every Defect feedback file: one contest, one package hash, never a safety claim. */
function buildFile(ctx: Ctx, row: ContestRow, facts: Facts, v: Variant): DefectFeedbackFile {
  const erc = ctx.settings.erc8004;
  if (!erc) throw new Error("No ERC-8004 registries configured");
  if (!ctx.settings.siteUrl) throw new Error("No SITE_URL configured");
  const id = row.contest_id;
  const held = facts.status === "held";
  const invariants = (JSON.parse(row.invariants_json) as { type: string; text: string }[]).map((i) => ({ kind: i.type, text: i.text }));
  return {
    agentRegistry: agentRegistryId(HEDERA_TESTNET_CHAIN_ID, erc.identity),
    agentId: v.agentId,
    clientAddress: `eip155:${HEDERA_TESTNET_CHAIN_ID}:${ctx.chain.operatorAddress.toLowerCase()}`,
    createdAt: new Date(ctx.now() * 1000).toISOString(),
    value: v.value,
    valueDecimals: v.valueDecimals,
    tag1: v.tag1,
    tag2: feedbackTag2(ctx.settings.deployment, id),
    endpoint: `${ctx.settings.siteUrl}/contests/${id}`,
    ...(v.proofOfPayment ? { proofOfPayment: v.proofOfPayment } : {}),
    defect: {
      arena: ctx.settings.arena,
      deployment: ctx.settings.deployment,
      contestId: id,
      status: facts.status,
      packageHash: facts.packageHash,
      logHash: facts.logHash,
      invariants,
      brokenInvariant: held ? null : row.broken_invariant,
      finalPool: facts.finalPool,
      messageCount: facts.messageCount,
      uniqueBreakers: facts.uniqueBreakers,
      breakTx: facts.breakTx,
      certificateTokenId: held && ctx.settings.certificate ? id : null,
      attestations: ctx.settings.attestations ? { chain: "sepolia", address: ctx.settings.attestations, contestId: id } : null,
    },
  };
}

/**
 * The off-chain file behind a Warden feedback entry (ERC-8004 §feedbackURI). It records what happened in
 * one contest against one package hash; it never says the agent is safe.
 */
export function buildWardenFeedbackFile(ctx: Ctx, row: ContestRow, facts: Facts): DefectFeedbackFile {
  if (row.agent_id === null) throw new Error(`contest ${row.contest_id} has no linked agent`);
  const held = facts.status === "held";
  return buildFile(ctx, row, facts, {
    agentId: row.agent_id,
    tag1: held ? "defect.held" : "defect.broken",
    value: held ? 100 : 0,
    valueDecimals: 0,
  });
}

/**
 * The contest's on-chain `Broken` event, or null while the mirror node doesn't show it yet. Feedback files are
 * immutable, so a Broken post waits for this rather than writing a file without its breakTx and payout.
 */
async function brokenEvent(ctx: Ctx, row: ContestRow): Promise<{ txHash: Hex; payout: bigint } | null> {
  const ev = (await ctx.chain.contestEvents(row.contest_id, row.start_time - 3600)).find((e) => e.name === "Broken");
  if (!ev) return null;
  if (typeof ev.args.payout !== "bigint") throw new Error(`Broken event of contest ${row.contest_id} has no payout`);
  return { txHash: ev.txHash, payout: ev.args.payout };
}

/**
 * Crash recovery: the entry is already on chain, so find the tx that posted it (from the registry's NewFeedback
 * log). Null when the log doesn't show it (yet).
 */
async function postedTx(ctx: Ctx, agentId: number, entry: { index: number; tag1: string; tag2: string }): Promise<string | null> {
  const events = await ctx.chain.feedbackEvents(agentId);
  const same = events.filter((e) => e.tag1 === entry.tag1 && e.tag2 === entry.tag2);
  return (same.find((e) => e.index === entry.index) ?? same[0])?.txHash ?? null;
}

function setFeedback(ctx: Ctx, id: number, status: "posted" | "skipped" | "blocked", tx: string | null = null): void {
  ctx.db.run("UPDATE contests SET agent_feedback_status = ?, agent_feedback_tx = ? WHERE contest_id = ?", [status, tx, id]);
}

/**
 * Posts a finished contest's result as ERC-8004 feedback on the Warden's linked agent. Best effort: it never
 * touches contest status, finalization or the certificate, and any error leaves the row at `none` for a retry.
 */
export async function postWardenFeedback(ctx: Ctx, row: ContestRow): Promise<void> {
  if (row.agent_feedback_status !== "none") return;
  const erc = ctx.settings.erc8004;
  // No SITE_URL: the on-chain endpoint would be wrong for good, so nothing is posted (startup logs a warning).
  if (!erc || !ctx.settings.siteUrl) return;
  const id = row.contest_id;
  try {
    if (row.status === "active") return;
    if (row.status === "void" || row.status === "cancelled" || row.agent_id === null) return setFeedback(ctx, id, "skipped");
    const agentId = row.agent_id;

    let uniqueBreakers = 0;
    if (row.status === "held") {
      if (row.finalized !== 1) return;
      if (ctx.settings.certificate !== null && row.certificate_status !== "reported") return;
      uniqueBreakers = uniquePayingBreakers(ctx, id);
      if (uniqueBreakers < 1) return setFeedback(ctx, id, "skipped");
    } else {
      uniqueBreakers = uniquePayingBreakers(ctx, id);
    }

    if (await ctx.chain.isAgentOperator(ctx.chain.operatorAddress, agentId)) {
      ctx.log(`agent feedback ${id}: agent ${agentId} approved the operator, not posting`);
      return setFeedback(ctx, id, "blocked");
    }

    const held = row.status === "held";
    const tag1: FeedbackTag1 = held ? "defect.held" : "defect.broken";
    const tag2 = feedbackTag2(ctx.settings.deployment, id);
    const existing = (await ctx.chain.readDefectFeedback(agentId)).find((f) => !f.revoked && f.tag1 === tag1 && f.tag2 === tag2);
    if (existing) return setFeedback(ctx, id, "posted", await postedTx(ctx, agentId, existing));

    let broken: { txHash: Hex; payout: bigint } | null = null;
    if (!held) {
      broken = await brokenEvent(ctx, row);
      if (!broken) return; // not on the mirror node yet; retry next tick
    }
    const onchain = await ctx.chain.getContest(id);
    const file = buildWardenFeedbackFile(ctx, row, {
      finalPool: broken ? broken.payout.toString() : (row.final_pool ?? "0"),
      messageCount: onchain.messageCount,
      uniqueBreakers,
      breakTx: broken?.txHash ?? null,
      logHash: held ? ((row.log_hash as Hex | null) ?? null) : null,
      status: held ? "held" : "broken",
      packageHash: onchain.packageHash,
    });
    const { uri, hash } = toJsonDataUri(file);
    const tx = await ctx.chain.giveFeedback({
      agentId,
      value: held ? 100n : 0n,
      valueDecimals: 0,
      tag1,
      tag2,
      endpoint: file.endpoint,
      feedbackURI: uri,
      feedbackHash: hash,
    });
    setFeedback(ctx, id, "posted", tx);
    ctx.log(`posted ${tag1} feedback for contest ${id} on agent ${agentId}: ${tx}`);
  } catch (err) {
    ctx.log(`agent feedback ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function setWinner(ctx: Ctx, id: number, status: "posted" | "skipped" | "blocked", agentId: number | null, tx: string | null = null): void {
  ctx.db.run("UPDATE contests SET winner_feedback_status = ?, winner_agent_id = ?, winner_feedback_tx = ? WHERE contest_id = ?", [status, agentId, tx, id]);
}

/**
 * Posts the bounty (USDC base units, 6 decimals) on the winning Breaker's linked agent. Same rules as the Warden
 * post: best effort, never touches the contest, any error leaves the row at `none` for a retry.
 */
export async function postWinnerFeedback(ctx: Ctx, row: ContestRow): Promise<void> {
  if (row.winner_feedback_status !== "none") return;
  const erc = ctx.settings.erc8004;
  if (!erc || !ctx.settings.siteUrl) return;
  const id = row.contest_id;
  try {
    if (row.status === "active") return;
    if (row.status !== "broken" || !row.winner) return setWinner(ctx, id, "skipped", null);

    const winner = row.winner.toLowerCase();
    // A pending attempt may still settle (and become the breaking attempt with the payment proof); wait for it.
    if (ctx.db.get("SELECT 1 AS x FROM attempts WHERE contest_id = ? AND LOWER(breaker) = ? AND outcome = 'pending'", [id, winner])) return;

    // The breaking attempt (broke = 1) is the best source for the agent and the payment proof. A secret-leak break is
    // claimed by reveal, so `broke` may not be set on any attempt; then fall back to the winner's newest linked attempt.
    type A = { agent_id: number | null; settle_tx: string | null };
    const breaking = ctx.db.get<A>(
      "SELECT agent_id, settle_tx FROM attempts WHERE contest_id = ? AND LOWER(breaker) = ? AND broke = 1 ORDER BY started_at DESC, rowid DESC LIMIT 1",
      [id, winner],
    );
    const linked =
      breaking?.agent_id != null
        ? breaking
        : ctx.db.get<A>(
            "SELECT agent_id, settle_tx FROM attempts WHERE contest_id = ? AND LOWER(breaker) = ? AND agent_id IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
            [id, winner],
          );
    if (!linked || linked.agent_id === null) return setWinner(ctx, id, "skipped", null);
    const agentId = linked.agent_id;
    const settleTx = breaking?.settle_tx ?? linked.settle_tx;

    if (await ctx.chain.isAgentOperator(ctx.chain.operatorAddress, agentId)) {
      ctx.log(`winner feedback ${id}: agent ${agentId} approved the operator, not posting`);
      return setWinner(ctx, id, "blocked", agentId);
    }

    const tag1: FeedbackTag1 = "defect.bounty";
    const tag2 = feedbackTag2(ctx.settings.deployment, id);
    const existing = (await ctx.chain.readDefectFeedback(agentId)).find((f) => !f.revoked && f.tag1 === tag1 && f.tag2 === tag2);
    if (existing) return setWinner(ctx, id, "posted", agentId, await postedTx(ctx, agentId, existing));

    // The bounty is what the arena actually paid: the Broken event's payout, not the gateway's pool bookkeeping.
    const broken = await brokenEvent(ctx, row);
    if (!broken) return; // not on the mirror node yet; retry next tick
    const value = broken.payout;
    const onchain = await ctx.chain.getContest(id);
    const file = buildFile(
      ctx,
      row,
      {
        finalPool: value.toString(),
        messageCount: onchain.messageCount,
        uniqueBreakers: uniquePayingBreakers(ctx, id),
        breakTx: broken.txHash,
        logHash: null,
        status: "broken",
        packageHash: onchain.packageHash,
      },
      {
        agentId,
        tag1,
        value: Number(value),
        valueDecimals: 6,
        proofOfPayment: settleTx
          ? { fromAddress: winner, toAddress: ctx.chain.operatorAddress.toLowerCase(), chainId: String(HEDERA_TESTNET_CHAIN_ID), txHash: settleTx }
          : undefined,
      },
    );
    const { uri, hash } = toJsonDataUri(file);
    const tx = await ctx.chain.giveFeedback({
      agentId,
      value,
      valueDecimals: 6,
      tag1,
      tag2,
      endpoint: file.endpoint,
      feedbackURI: uri,
      feedbackHash: hash,
    });
    setWinner(ctx, id, "posted", agentId, tx);
    ctx.log(`posted ${tag1} feedback for contest ${id} on agent ${agentId}: ${tx}`);
  } catch (err) {
    ctx.log(`winner feedback ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
