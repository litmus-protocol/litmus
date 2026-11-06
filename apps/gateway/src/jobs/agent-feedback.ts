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
      finalPool: row.final_pool ?? "0",
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
  if (!erc) return;
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
    const existing = await ctx.chain.readDefectFeedback(agentId);
    if (existing.some((f) => !f.revoked && f.tag1 === tag1 && f.tag2 === tag2)) return setFeedback(ctx, id, "posted");

    const onchain = await ctx.chain.getContest(id);
    let breakTx: Hex | null = null;
    if (!held) {
      const events = await ctx.chain.contestEvents(id, row.start_time - 3600);
      breakTx = events.find((e) => e.name === "Broken")?.txHash ?? null;
    }
    const file = buildWardenFeedbackFile(ctx, row, {
      messageCount: onchain.messageCount,
      uniqueBreakers,
      breakTx,
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
  if (!erc) return;
  const id = row.contest_id;
  try {
    if (row.status === "active") return;
    if (row.status !== "broken" || !row.winner) return setWinner(ctx, id, "skipped", null);
    if (row.final_pool === null) return;

    const attempt = ctx.db.get<{ agent_id: number; settle_tx: string | null }>(
      `SELECT agent_id, settle_tx FROM attempts WHERE contest_id = ? AND LOWER(breaker) = ? AND agent_id IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      [id, row.winner.toLowerCase()],
    );
    if (!attempt) return setWinner(ctx, id, "skipped", null);
    const agentId = attempt.agent_id;

    if (await ctx.chain.isAgentOperator(ctx.chain.operatorAddress, agentId)) {
      ctx.log(`winner feedback ${id}: agent ${agentId} approved the operator, not posting`);
      return setWinner(ctx, id, "blocked", agentId);
    }

    const tag1: FeedbackTag1 = "defect.bounty";
    const tag2 = feedbackTag2(ctx.settings.deployment, id);
    const existing = await ctx.chain.readDefectFeedback(agentId);
    if (existing.some((f) => !f.revoked && f.tag1 === tag1 && f.tag2 === tag2)) return setWinner(ctx, id, "posted", agentId);

    const value = BigInt(row.final_pool);
    const onchain = await ctx.chain.getContest(id);
    const events = await ctx.chain.contestEvents(id, row.start_time - 3600);
    const file = buildFile(
      ctx,
      row,
      {
        messageCount: onchain.messageCount,
        uniqueBreakers: uniquePayingBreakers(ctx, id),
        breakTx: events.find((e) => e.name === "Broken")?.txHash ?? null,
        logHash: null,
        status: "broken",
        packageHash: onchain.packageHash,
      },
      {
        agentId,
        tag1,
        value: Number(value),
        valueDecimals: 6,
        proofOfPayment: attempt.settle_tx
          ? { fromAddress: row.winner, toAddress: ctx.chain.operatorAddress.toLowerCase(), chainId: String(HEDERA_TESTNET_CHAIN_ID), txHash: attempt.settle_tx }
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
