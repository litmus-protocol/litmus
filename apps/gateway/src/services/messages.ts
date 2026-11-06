import { randomUUID } from "node:crypto";
import {
  CHARGE_LATENCY_LIMIT_MS,
  GATEWAY_RUN_TIMEOUT_MS,
  MAX_MESSAGE_CHARS,
  fromBaseUnits,
  type MessageResult,
  type RunResult,
} from "@defect/shared";
import { HederaAccountError } from "../accounts";
import type { Ctx } from "../context";
import { isUniqueViolation, type AttemptOutcome, type AttemptRow } from "../db";
import { paymentId } from "../payments";
import { attemptRecord, signRecord } from "../records";
import { messageResult } from "../views";
import { linkAttemptAgentInBackground, parseAgentIdHeader } from "./agent-header";
import { ApiFailure } from "./errors";

/** Three settle_failed attempts in one contest block the payer (§10.5 step 4b). */
export const SETTLE_FAILED_BLOCK_AT = 3;

export interface MessageResponse {
  status: 200 | 502;
  body: MessageResult | { error: { code: string; message: string }; attemptId: string };
  headers: Record<string, string>;
}

/** POST /contests/:id/messages (§10.5). Throws ApiFailure for every non-200/502 outcome. */
export async function handleMessage(
  ctx: Ctx,
  contestId: number,
  body: unknown,
  paymentHeader: string | undefined,
  agentIdHeader?: string,
): Promise<MessageResponse> {
  // 1. Free pre-checks: nothing is requested or settled if these fail.
  const row = ctx.db.contest(contestId);
  if (!row || row.loaded !== 1) throw new ApiFailure(404, "CONTEST_NOT_FOUND", "No open contest with this id");
  const state = await ctx.state.get(contestId);
  if (state.phase !== "open") throw new ApiFailure(409, "CONTEST_NOT_OPEN", `Contest is ${state.phase.replace("_", " ")}, not open`);
  const raw = (body as { text?: unknown } | undefined)?.text;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_MESSAGE_CHARS) throw new ApiFailure(400, "INVALID_TEXT", `Text must be 1–${MAX_MESSAGE_CHARS} characters`);

  const price = BigInt(row.message_price);
  const resourceUrl = `${ctx.settings.publicUrl}/contests/${contestId}/messages`;
  const description = `Defect contest #${contestId}: one message`;
  const paymentRequired = async (code: string, message: string, status: 402 = 402) =>
    new ApiFailure(status, code, message, { "PAYMENT-REQUIRED": await ctx.payments.paymentRequiredHeader(price, resourceUrl, description, message) });

  // 2. No payment yet → 402 with the requirements.
  if (!paymentHeader) throw await paymentRequired("PAYMENT_REQUIRED", `Pay ${fromBaseUnits(price)} USDC to send this message.`);

  // 3. Verify (nothing is settled yet).
  const payload = ctx.payments.decode(paymentHeader);
  if (!payload) throw await paymentRequired("PAYMENT_INVALID", "PAYMENT-SIGNATURE is not a valid x402 v2 payment");
  const verified = await ctx.payments.verify(payload, price, resourceUrl, description);
  if (!verified.ok) throw await paymentRequired("PAYMENT_INVALID", verified.reason);

  // 4. Identify the Breaker: the address DefectArena sees as msg.sender for this account
  //    (ECDSA alias, or long-zero for ED25519 accounts connected through WalletConnect).
  let breaker: `0x${string}`;
  try {
    breaker = await ctx.accounts.toEvm(verified.payer);
  } catch (err) {
    if (err instanceof HederaAccountError && err.code === "ECDSA_ACCOUNT_REQUIRED") {
      throw new ApiFailure(400, "ECDSA_ACCOUNT_REQUIRED", "Pay from a Hedera account with an ECDSA key");
    }
    if (err instanceof HederaAccountError && err.code === "UNSUPPORTED_ACCOUNT_KEY") {
      throw new ApiFailure(400, "UNSUPPORTED_ACCOUNT_KEY", "Pay from a Hedera account with a single ECDSA or ED25519 key");
    }
    throw new ApiFailure(503, "MIRROR_NODE_ERROR", `Couldn't look up account ${verified.payer}`);
  }

  // 4b. Blocked payer.
  const failed = ctx.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM attempts WHERE contest_id = ? AND breaker = ? AND outcome = 'settle_failed'",
    [contestId, breaker],
  )!.n;
  if (failed >= SETTLE_FAILED_BLOCK_AT) throw new ApiFailure(403, "PAYER_BLOCKED", "Too many payments from this account failed to settle in this contest");

  // 4c. Replay guard.
  const pid = paymentId(payload);
  if (ctx.db.get("SELECT 1 AS x FROM attempts WHERE payment_id = ?", [pid])) {
    throw await paymentRequired("PAYMENT_REUSED", "This payment was already used");
  }

  // 5–6. One attempt at a time per session, enforced by the partial unique index.
  const attemptId = randomUUID();
  const startedAt = Date.now();
  try {
    ctx.db.run(
      `INSERT INTO attempts (attempt_id, contest_id, breaker, payer_account, text, started_at, outcome, amount, payment_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [attemptId, contestId, breaker, verified.payer, text, startedAt, price.toString(), pid],
    );
  } catch (err) {
    if (isUniqueViolation(err, "payment_id")) throw await paymentRequired("PAYMENT_REUSED", "This payment was already used");
    if (isUniqueViolation(err)) throw new ApiFailure(429, "ATTEMPT_IN_PROGRESS", "Wait for your previous message to finish");
    throw err;
  }
  // Optional ERC-8004 identity: linked only if the agent belongs to this payer, in the background, never affecting the reply.
  const agentId = parseAgentIdHeader(agentIdHeader);
  if (agentId !== null) linkAttemptAgentInBackground(ctx, attemptId, agentId, breaker);
  const history = ctx.db
    .attempts(contestId, "breaker = ? AND attempt_id != ? AND reply IS NOT NULL AND reply != '' AND outcome IN ('charged','free_late','settle_failed')", [
      breaker,
      attemptId,
    ])
    .flatMap((a) => [
      { role: "user" as const, content: a.text },
      { role: "assistant" as const, content: a.reply! },
    ]);

  // 7. Run the agent.
  let result: RunResult | null = null;
  let runError: string | null = null;
  try {
    result = await ctx.runner.run({ contestId, attemptId, mode: "live", breaker, history, text }, GATEWAY_RUN_TIMEOUT_MS);
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = Date.now() - startedAt;

  // 8. Decide whether to charge.
  let outcome: AttemptOutcome;
  let settleTx: string | null = null;
  const headers: Record<string, string> = {};
  if (!result) {
    outcome = "free_error";
  } else if (latencyMs <= CHARGE_LATENCY_LIMIT_MS) {
    const s = await ctx.payments.settle(payload, verified.requirements);
    if (s.ok) {
      outcome = "charged";
      settleTx = s.txId;
      headers["PAYMENT-RESPONSE"] = s.header;
    } else {
      outcome = "settle_failed";
      ctx.log(`settle failed for attempt ${attemptId}: ${s.reason}`);
    }
  } else {
    outcome = "free_late";
  }

  // 9. Store and sign.
  ctx.db.run(
    `UPDATE attempts SET reply = ?, tool_calls_json = ?, og_json = ?, latency_ms = ?, outcome = ?, settle_tx = ?, settled_at = ?,
       deposit_status = ?, deposit_next_at = ?, broke = ? WHERE attempt_id = ?`,
    [
      result?.reply ?? null,
      JSON.stringify(result?.toolCalls ?? []),
      JSON.stringify(result?.og ?? []),
      latencyMs,
      outcome,
      settleTx,
      settleTx ? ctx.now() : null,
      settleTx ? "pending" : "none",
      settleTx ? Date.now() : null,
      result?.broke ? 1 : 0,
      attemptId,
    ],
  );
  const stored = ctx.db.attempt(attemptId)!;
  const { recordHash, signature } = await signRecord(attemptRecord(stored), ctx.signer);
  ctx.db.run("UPDATE attempts SET record_hash = ?, signature = ? WHERE attempt_id = ?", [recordHash, signature, attemptId]);

  // 10. A break (or a timed-out run that may have sent a vault tx) → look at the chain now.
  if (result?.broke || !result) {
    ctx.state.invalidate(contestId);
    ctx.pokeStatus(contestId);
  }

  headers["X-Defect-Charged"] = outcome === "charged" ? "true" : "false";
  const final: AttemptRow = { ...stored, record_hash: recordHash, signature };
  if (!result) {
    return {
      status: 502,
      body: { error: { code: "RUN_FAILED", message: `The agent couldn't reply: ${runError}` }, attemptId },
      headers,
    };
  }
  return { status: 200, body: messageResult(final, result.broke), headers };
}
