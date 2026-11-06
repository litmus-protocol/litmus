import { MAX_MESSAGE_CHARS, type Invariant, type X402Discovery, type X402Resource } from "@defect/shared";
import type { Ctx } from "../context";
import { contestSummary } from "../views";
import { messageDescription, messageResourceUrl } from "./messages";

/**
 * GET /.well-known/x402. Lists the message endpoint of every contest that is open right now,
 * with the same payment requirements its 402 answers with, so an agent can find a paid endpoint,
 * check the price, and pay it without a human pointing it at a contest.
 */
export async function discovery(ctx: Ctx): Promise<X402Discovery> {
  const items: X402Resource[] = [];
  for (const row of ctx.db.contests("status = 'active' AND loaded = 1")) {
    let state;
    try {
      state = await ctx.state.get(row.contest_id);
    } catch (err) {
      ctx.log(`skipping contest ${row.contest_id} in discovery: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (state.phase !== "open") continue;
    const summary = contestSummary(row, state);
    const rules = (JSON.parse(row.invariants_json) as Invariant[]).map((i) => i.text);
    items.push({
      resource: messageResourceUrl(ctx, row.contest_id),
      type: "http",
      x402Version: 2,
      description: messageDescription(row.contest_id),
      mimeType: "application/json",
      accepts: await ctx.payments.requirements(BigInt(row.message_price)),
      input: {
        method: "POST",
        bodyType: "json",
        bodySchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS } },
        },
      },
      metadata: {
        contestId: row.contest_id,
        agentName: summary.card.name,
        purpose: summary.card.purpose,
        endTime: summary.endTime,
        pool: summary.pool,
        messagePrice: summary.messagePrice,
        rules,
      },
    });
  }
  return { x402Version: 2, items };
}
