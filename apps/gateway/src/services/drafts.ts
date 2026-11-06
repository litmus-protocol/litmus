import { randomUUID } from "node:crypto";
import {
  INVARIANT_KIND,
  hashJson,
  toBaseUnits,
  validateSubmission,
  type DraftResponse,
  type WardenSubmission,
} from "@defect/shared";
import type { Ctx } from "../context";
import type { ContestRow, DraftRow } from "../db";
import { RunnerError } from "../runner-client";
import { ApiFailure } from "./errors";

const ZERO32 = `0x${"0".repeat(64)}` as const;

/** POST /drafts (§10.3.1). */
export async function createDraft(ctx: Ctx, body: unknown): Promise<DraftResponse> {
  const issues = validateSubmission(body, { allowedModels: ctx.settings.allowedModels, now: ctx.now() });
  if (issues.length) throw new ApiFailure(400, "INVALID_SUBMISSION", issues.map((i) => `${i.path || "body"}: ${i.message}`).join("; "));
  const sub = body as WardenSubmission;
  if (sub.card.agentId !== undefined) await checkAgentLink(ctx, sub.card.agentId, sub.warden!);

  const draftId = randomUUID();
  const secretIds = sub.invariants.filter((i) => i.type === "secret").map((i) => i.id);
  let secretHashes: Record<string, `0x${string}`> = {};
  if (secretIds.length) {
    try {
      secretHashes = (await ctx.runner.draftSecrets(draftId, secretIds)).secretHashes;
    } catch (err) {
      throw runnerUnavailable(err);
    }
  }

  const packageHash = hashJson(sub.package);
  const canaryHash = hashJson(sub.canaries);
  ctx.db.run(
    "INSERT INTO drafts (draft_id, submission_json, package_hash, canary_hash, secret_hashes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [draftId, JSON.stringify(sub), packageHash, canaryHash, JSON.stringify(secretHashes), ctx.now()],
  );

  const pool = toBaseUnits(sub.pool);
  const vault = toBaseUnits(sub.vaultFunding);
  const bond = toBaseUnits(sub.bond);
  return {
    draftId,
    packageHash,
    canaryHash,
    invariantsOnchain: sub.invariants.map((inv) => ({
      kind: INVARIANT_KIND[inv.type],
      secretHash: inv.type === "secret" ? secretHashes[inv.id]! : ZERO32,
      maxAmount: inv.type === "transfer_limit" ? toBaseUnits(inv.maxAmount).toString() : "0",
    })),
    startTime: sub.startTime,
    messagePriceUnits: toBaseUnits(sub.messagePrice).toString(),
    poolUnits: pool.toString(),
    vaultUnits: vault.toString(),
    bondUnits: bond.toString(),
    approveTotalUnits: (pool + vault + bond).toString(),
  };
}

const AGENT_BLOCKS_DEFECT_MESSAGE =
  "This agent has approved Defect's operator, so Defect couldn't post its results. Remove that approval and try again.";

/** Draft-time agent checks (nothing is on chain yet, so these may reject the draft). */
async function checkAgentLink(ctx: Ctx, agentId: number, warden: string): Promise<void> {
  if (!ctx.settings.erc8004) throw new ApiFailure(400, "ERC8004_DISABLED", "ERC-8004 agent identity isn't enabled on this deployment");
  try {
    const owner = await ctx.chain.agentOwner(agentId);
    if (!owner) throw new ApiFailure(400, "AGENT_NOT_FOUND", `No ERC-8004 agent with id ${agentId}`);
    if (owner.toLowerCase() !== warden.toLowerCase()) {
      throw new ApiFailure(400, "AGENT_NOT_OWNED", `Agent ${agentId} isn't owned by the connected wallet`);
    }
    if (await ctx.chain.isAgentOperator(ctx.chain.operatorAddress, agentId)) {
      throw new ApiFailure(400, "AGENT_BLOCKS_DEFECT", AGENT_BLOCKS_DEFECT_MESSAGE);
    }
  } catch (err) {
    if (err instanceof ApiFailure) throw err;
    throw new ApiFailure(503, "CHAIN_UNAVAILABLE", `Couldn't read the ERC-8004 registry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Confirm waits at most this long for the registry re-check; past it the link is dropped. */
export const AGENT_LINK_TIMEOUT_MS = 5_000;

/**
 * Confirm-time re-check. Never throws and never holds confirm past AGENT_LINK_TIMEOUT_MS: any mismatch,
 * read error or timeout drops the link (agent_id = null).
 */
async function verifiedAgentLink(ctx: Ctx, contestId: number, agentId: number, warden: string): Promise<number | null> {
  const check = async (): Promise<string | null> => {
    try {
      const owner = await ctx.chain.agentOwner(agentId);
      if (!owner) return "agent not found";
      if (owner.toLowerCase() !== warden.toLowerCase()) return "agent no longer owned by the warden";
      if (await ctx.chain.isAgentOperator(ctx.chain.operatorAddress, agentId)) return "agent approved Defect's operator";
      return null;
    } catch (err) {
      return `registry read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`registry read timed out after ${AGENT_LINK_TIMEOUT_MS} ms`), AGENT_LINK_TIMEOUT_MS);
  });
  const reason = await Promise.race([check(), timeout]).finally(() => clearTimeout(timer));
  if (reason === null) return agentId;
  ctx.log(`contest ${contestId}: dropped ERC-8004 link to agent ${agentId} (${reason})`);
  return null;
}

/** POST /drafts/:draftId/confirm (§10.3.2). */
export async function confirmDraft(ctx: Ctx, draftId: string, body: unknown): Promise<{ contestId: number }> {
  const contestId = (body as { contestId?: unknown } | undefined)?.contestId;
  if (typeof contestId !== "number" || !Number.isInteger(contestId) || contestId <= 0) {
    throw new ApiFailure(400, "INVALID_BODY", "Body must be { contestId: positive integer }");
  }
  const draft = ctx.db.get<DraftRow>("SELECT * FROM drafts WHERE draft_id = ?", [draftId]);
  if (!draft) throw new ApiFailure(404, "DRAFT_NOT_FOUND", "No draft with this id");
  if (draft.contest_id !== null && draft.contest_id !== contestId) {
    throw new ApiFailure(409, "DRAFT_ALREADY_CONFIRMED", `Draft already confirmed as contest ${draft.contest_id}`);
  }
  const existing = ctx.db.contest(contestId);
  if (existing && existing.draft_id !== draftId) throw new ApiFailure(409, "CONTEST_ALREADY_REGISTERED", "This contest id belongs to another draft");

  const sub = JSON.parse(draft.submission_json) as WardenSubmission;
  const secretHashes = JSON.parse(draft.secret_hashes_json) as Record<string, string>;

  let onchain;
  let invs;
  try {
    [onchain, invs] = await Promise.all([ctx.chain.getContest(contestId), ctx.chain.getInvariants(contestId)]);
  } catch (err) {
    throw new ApiFailure(503, "CHAIN_UNAVAILABLE", `Couldn't read contest ${contestId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const mismatch = compareWithChain(sub, draft, secretHashes, onchain, invs);
  if (mismatch) throw new ApiFailure(409, "ONCHAIN_MISMATCH", mismatch);

  if (!existing) {
    const agentId = sub.card.agentId === undefined ? null : await verifiedAgentLink(ctx, contestId, sub.card.agentId, onchain.warden);
    ctx.db.run(
      `INSERT INTO contests (contest_id, draft_id, warden, card_json, package_json, invariants_json, canaries_json,
         start_time, end_time, message_price, status, loaded, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?)`,
      [
        contestId,
        draftId,
        onchain.warden.toLowerCase(),
        JSON.stringify(sub.card),
        JSON.stringify(sub.package),
        JSON.stringify(sub.invariants),
        JSON.stringify(sub.canaries),
        onchain.startTime,
        onchain.endTime,
        onchain.messagePrice.toString(),
        agentId,
      ],
    );
    ctx.db.run("UPDATE drafts SET contest_id = ? WHERE draft_id = ?", [contestId, draftId]);
  }

  const outcome = await loadIntoRunner(ctx, ctx.db.contest(contestId)!);
  if (outcome === "mismatch") throw new ApiFailure(409, "PACKAGE_MISMATCH", "The runner could not verify this agent package; the contest was cancelled");
  if (outcome === "unavailable") throw new ApiFailure(503, "RUNNER_UNAVAILABLE", "The arena runner is unavailable; loading will be retried automatically");
  return { contestId };
}

/**
 * Sends `load` to the runner. 200 → loaded = 1. 409 → cancel on chain (only when `cancelOnMismatch`).
 * Network error / 5xx → leave loaded = 0 for the poller to retry (§10.3.2 step 4).
 */
export async function loadIntoRunner(
  ctx: Ctx,
  row: ContestRow,
  opts: { cancelOnMismatch: boolean } = { cancelOnMismatch: true },
): Promise<"loaded" | "mismatch" | "unavailable"> {
  try {
    await ctx.runner.load(row.contest_id, {
      draftId: row.draft_id,
      package: JSON.parse(row.package_json),
      invariants: JSON.parse(row.invariants_json),
    });
    ctx.db.run("UPDATE contests SET loaded = 1 WHERE contest_id = ?", [row.contest_id]);
    return "loaded";
  } catch (err) {
    if (err instanceof RunnerError && err.status === 409) {
      ctx.log(`runner refused contest ${row.contest_id}: ${err.code} ${err.message}`);
      if (opts.cancelOnMismatch) await cancelContest(ctx, row.contest_id);
      return "mismatch";
    }
    ctx.log(`runner load failed for contest ${row.contest_id}: ${err instanceof Error ? err.message : String(err)}`);
    return "unavailable";
  }
}

export async function cancelContest(ctx: Ctx, contestId: number): Promise<void> {
  try {
    await ctx.chain.cancel(contestId);
  } catch (err) {
    ctx.log(`cancel(${contestId}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  ctx.db.run("UPDATE contests SET status = 'cancelled', ended_at = COALESCE(ended_at, ?) WHERE contest_id = ?", [ctx.now(), contestId]);
  ctx.state.invalidate(contestId);
  ctx.pokeStatus(contestId);
}

function compareWithChain(
  sub: WardenSubmission,
  draft: DraftRow,
  secretHashes: Record<string, string>,
  c: Awaited<ReturnType<Ctx["chain"]["getContest"]>>,
  invs: Awaited<ReturnType<Ctx["chain"]["getInvariants"]>>,
): string | null {
  if (c.status === 0) return "Contest does not exist on chain";
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(c.packageHash, draft.package_hash)) return "packageHash differs";
  if (!eq(c.canaryHash, draft.canary_hash)) return "canaryHash differs";
  if (c.startTime !== sub.startTime) return "startTime differs";
  if (c.messagePrice !== toBaseUnits(sub.messagePrice)) return "messagePrice differs";
  if (c.initialPool !== toBaseUnits(sub.pool)) return "pool differs";
  // vault and bond can only have changed if the contest already broke or closed; compare when still untouched.
  if (c.status === 1 && c.messageCount === 0 && c.vault !== toBaseUnits(sub.vaultFunding)) return "vault differs";
  if (c.status === 1 && c.messageCount === 0 && c.bond !== toBaseUnits(sub.bond)) return "bond differs";
  if (invs.length !== sub.invariants.length) return "invariant count differs";
  for (let i = 0; i < invs.length; i++) {
    const inv = sub.invariants[i]!;
    const oc = invs[i]!;
    if (oc.kind !== INVARIANT_KIND[inv.type]) return `invariant ${i} kind differs`;
    if (inv.type === "secret" && !eq(oc.secretHash, secretHashes[inv.id] ?? "")) return `invariant ${i} secretHash differs`;
    if (inv.type === "transfer_limit" && oc.maxAmount !== toBaseUnits(inv.maxAmount)) return `invariant ${i} maxAmount differs`;
  }
  return null;
}

function runnerUnavailable(err: unknown): ApiFailure {
  const msg = err instanceof Error ? err.message : String(err);
  return new ApiFailure(503, "RUNNER_UNAVAILABLE", `The arena runner is unavailable: ${msg}`);
}
