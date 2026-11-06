import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { USDC_TOKEN_ID, X402_NETWORK, hederaSignedMessage, longZeroAddress, type DraftResponse, type MessageResult } from "@defect/shared";
import { hexToBytes, keccak256, toBytes, toHex, type Hex } from "viem";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { privateKeyToAccount } from "viem/accounts";
import { PHASE, STATUS } from "../src/chain";
import { sessionMessage } from "../src/app";
import { processNextDeposit } from "../src/jobs/deposits";
import { evaluateTask, roundPassed, runCanaryRound } from "../src/jobs/canary";
import { autoClose, certificateName, finalizeContest, issueCertificate, pollContest } from "../src/jobs/lifecycle";
import { buildLog } from "../src/records";
import { MirrorAccountResolver } from "../src/accounts";
import { RunnerError } from "../src/runner-client";
import { Db } from "../src/db";
import {
  BREAKER,
  BREAKER_ACCOUNT,
  NOW,
  OPERATOR_ACCOUNT,
  SECRET,
  makeEnv,
  okRun,
  paymentHeader,
  postMessage,
  seedContest,
  submission,
  type TestEnv,
} from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function postDraft(env: TestEnv, body: unknown) {
  return env.app.request("/drafts", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

// ------------------------------------------------------------------ §10.9 test 1: drafts

describe("POST /drafts", () => {
  it("accepts the TreasuryBot fixture and returns what goes on chain", async () => {
    const env = makeEnv();
    const sub = submission();
    const res = await postDraft(env, sub);
    expect(res.status).toBe(201);
    const d = await json<DraftResponse>(res);
    expect(d.invariantsOnchain.map((i) => i.kind)).toEqual([2, 1, 3]);
    expect(d.invariantsOnchain[1]!.secretHash).toBe(keccak256(toBytes(SECRET)));
    expect(d.invariantsOnchain[0]!.maxAmount).toBe("10000000");
    const total = BigInt(d.poolUnits) + BigInt(d.vaultUnits) + BigInt(d.bondUnits);
    expect(d.approveTotalUnits).toBe(total.toString());
    expect(env.ctx.db.get("SELECT 1 AS x FROM drafts WHERE draft_id = ?", [d.draftId])).toBeTruthy();
  });

  const bad: [string, (s: ReturnType<typeof submission>) => unknown][] = [
    ["missing placeholder", (s) => ({ ...s, package: { ...s.package, systemPrompt: s.package.systemPrompt.replace("{{SECRET:inv-2}}", "X") } })],
    ["extra placeholder", (s) => ({ ...s, package: { ...s.package, systemPrompt: `${s.package.systemPrompt} {{OTHER}}` } })],
    ["duplicate ids", (s) => ({ ...s, invariants: [s.invariants[0], { ...s.invariants[2]!, id: s.invariants[0]!.id }, s.invariants[1]] })],
    ["bond 19%", (s) => ({ ...s, bond: ((Number(s.pool) * 19) / 100).toFixed(2) })],
    ["price 0.009", (s) => ({ ...s, messagePrice: "0.009" })],
    ["missing tool", (s) => ({ ...s, package: { ...s.package, tools: s.package.tools.filter((t) => t !== "vault_send") } })],
    ["unknown model", (s) => ({ ...s, package: { ...s.package, model: "gpt-9" } })],
  ];
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, async () => {
      const env = makeEnv();
      const res = await postDraft(env, mutate(submission()));
      expect(res.status).toBe(400);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INVALID_SUBMISSION");
    });
  }
});

// ------------------------------------------------------------------ confirm

describe("POST /drafts/:id/confirm", () => {
  async function draftAndChain(env: TestEnv): Promise<DraftResponse> {
    const d = await json<DraftResponse>(await postDraft(env, submission()));
    seedChainFromDraft(env, d);
    return d;
  }
  function seedChainFromDraft(env: TestEnv, d: DraftResponse, id = 7) {
    env.chain.contests.set(id, {
      warden: "0x9000000000000000000000000000000000000009",
      status: STATUS.Active,
      startTime: d.startTime,
      endTime: d.startTime + 900,
      messageCount: 0,
      brokenInvariant: 0,
      winner: "0x0000000000000000000000000000000000000000",
      messagePrice: BigInt(d.messagePriceUnits),
      initialPool: BigInt(d.poolUnits),
      pool: BigInt(d.poolUnits),
      vault: BigInt(d.vaultUnits),
      bond: BigInt(d.bondUnits),
      escrow: 0n,
      packageHash: d.packageHash,
      canaryHash: d.canaryHash,
      logHash: `0x${"0".repeat(64)}`,
    });
    env.chain.invariants.set(
      id,
      d.invariantsOnchain.map((i) => ({ kind: i.kind, secretHash: i.secretHash, maxAmount: BigInt(i.maxAmount) })),
    );
  }
  const confirm = (env: TestEnv, draftId: string, contestId = 7) =>
    env.app.request(`/drafts/${draftId}/confirm`, { method: "POST", body: JSON.stringify({ contestId }), headers: { "Content-Type": "application/json" } });

  it("registers and loads a contest that matches the chain", async () => {
    const env = makeEnv();
    const d = await draftAndChain(env);
    const res = await confirm(env, d.draftId);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ contestId: 7 });
    expect(env.ctx.db.contest(7)!.loaded).toBe(1);
    expect(env.runner.loads).toEqual([7]);
  });

  it("refuses a contest whose on-chain data differs", async () => {
    const env = makeEnv();
    const d = await draftAndChain(env);
    env.chain.contests.get(7)!.messagePrice = 1n;
    const res = await confirm(env, d.draftId);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("ONCHAIN_MISMATCH");
  });

  it("cancels when the runner can't verify the package", async () => {
    const env = makeEnv();
    const d = await draftAndChain(env);
    env.runner.loadError = new RunnerError(409, "PACKAGE_MISMATCH", "nope");
    const res = await confirm(env, d.draftId);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("PACKAGE_MISMATCH");
    expect(env.chain.callsOf("cancel")).toHaveLength(1);
    expect(env.ctx.db.contest(7)!.status).toBe("cancelled");
  });

  it("answers 503 and keeps the contest for retry when the runner is down", async () => {
    const env = makeEnv();
    const d = await draftAndChain(env);
    env.runner.loadError = new RunnerError(0, "RUNNER_UNREACHABLE", "down");
    const res = await confirm(env, d.draftId);
    expect(res.status).toBe(503);
    expect(env.ctx.db.contest(7)).toMatchObject({ status: "active", loaded: 0 });
    // The poller retries; once the runner is back the contest loads.
    env.runner.loadError = null;
    await pollContest(env.ctx, env.ctx.db.contest(7)!);
    expect(env.ctx.db.contest(7)!.loaded).toBe(1);
  });

  it("rejects a second confirm with a different contest id", async () => {
    const env = makeEnv();
    const d = await draftAndChain(env);
    await confirm(env, d.draftId);
    const res = await confirm(env, d.draftId, 8);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("DRAFT_ALREADY_CONFIRMED");
  });
});

// ------------------------------------------------------------------ §10.9 test 2: paid messages

describe("POST /contests/:id/messages (x402)", () => {
  it("answers 402 with a decodable PAYMENT-REQUIRED header when unpaid", async () => {
    const env = makeEnv();
    seedContest(env);
    const res = await postMessage(env, "hello");
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: X402_NETWORK, asset: USDC_TOKEN_ID, payTo: OPERATOR_ACCOUNT, amount: "50000" });
    expect((pr.accepts[0]!.extra as { feePayer?: string }).feePayer).toBe("0.0.9185802");
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("PAYMENT_REQUIRED");
  });

  it("checks free conditions before asking for payment", async () => {
    const env = makeEnv();
    seedContest(env, 1, { phase: PHASE.Scheduled });
    expect((await postMessage(env, "hello")).status).toBe(409);
    const env2 = makeEnv();
    seedContest(env2);
    expect((await postMessage(env2, "   ")).status).toBe(400);
    expect((await postMessage(env2, "x".repeat(2001))).status).toBe(400);
    expect((await postMessage(env2, "hi", undefined, 99)).status).toBe(404);
  });

  it("rejects an invalid payment with a fresh 402", async () => {
    const env = makeEnv();
    seedContest(env);
    env.facilitator.valid = false;
    const res = await postMessage(env, "hello", await paymentHeader(env));
    expect(res.status).toBe(402);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("PAYMENT_INVALID");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(env.runner.runs).toHaveLength(0);
  });

  it("runs the agent and settles a fast reply", async () => {
    const env = makeEnv();
    seedContest(env);
    env.runner.onRun = async () => okRun("Balance is 15 USDC.");
    const res = await postMessage(env, "What's the balance?", await paymentHeader(env));
    expect(res.status).toBe(200);
    const body = await json<MessageResult>(res);
    expect(body).toMatchObject({ reply: "Balance is 15 USDC.", charged: true, contestBroken: false });
    expect(body.settlement!.txId).toMatch(/^0\.0\.9185802@/);
    expect(body.settlement!.hashscan).toContain("/transaction/0.0.9185802-");
    expect(res.headers.get("X-Defect-Charged")).toBe("true");
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).success).toBe(true);
    expect(env.facilitator.settles).toBe(1);
    const row = env.ctx.db.attempt(body.attemptId)!;
    expect(row).toMatchObject({ outcome: "charged", deposit_status: "pending", breaker: BREAKER, payer_account: BREAKER_ACCOUNT });
    expect(row.signature).toMatch(/^0x/);
    expect(env.runner.runs[0]).toMatchObject({ mode: "live", breaker: BREAKER, history: [] });
  });

  it("delivers a slow reply for free and never settles it", async () => {
    const env = makeEnv();
    seedContest(env);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    env.runner.onRun = async () => {
      clock += 16_000;
      return okRun("late answer");
    };
    const res = await postMessage(env, "hello", await paymentHeader(env));
    expect(res.status).toBe(200);
    const body = await json<MessageResult>(res);
    expect(body).toMatchObject({ charged: false, reply: "late answer", settlement: null });
    expect(res.headers.get("X-Defect-Charged")).toBe("false");
    expect(env.facilitator.settles).toBe(0);
    expect(env.ctx.db.attempt(body.attemptId)!).toMatchObject({ outcome: "free_late", deposit_status: "none" });
  });

  it("answers 502 without settling when the runner fails, and pokes the status poller", async () => {
    const env = makeEnv();
    seedContest(env);
    env.runner.onRun = async () => {
      throw new RunnerError(0, "RUNNER_TIMEOUT", "timeout");
    };
    const res = await postMessage(env, "hello", await paymentHeader(env));
    expect(res.status).toBe(502);
    const body = await json<{ error: { code: string }; attemptId: string }>(res);
    expect(body.error.code).toBe("RUN_FAILED");
    expect(env.facilitator.settles).toBe(0);
    expect(env.ctx.db.attempt(body.attemptId)!.outcome).toBe("free_error");
    expect(env.pokes).toContain(1);
  });

  it("allows one message at a time per session", async () => {
    const env = makeEnv();
    seedContest(env);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    env.runner.onRun = async () => {
      await gate;
      return okRun();
    };
    const first = postMessage(env, "first", await paymentHeader(env));
    await vi.waitFor(() => expect(env.runner.runs).toHaveLength(1));
    const second = await postMessage(env, "second", await paymentHeader(env));
    expect(second.status).toBe(429);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("ATTEMPT_IN_PROGRESS");
    release();
    expect((await first).status).toBe(200);
    expect(env.facilitator.settles).toBe(1);
  });

  it("refuses a replayed payment", async () => {
    const env = makeEnv();
    seedContest(env);
    const header = await paymentHeader(env, 1, "same-signed-tx");
    expect((await postMessage(env, "one", header)).status).toBe(200);
    const again = await postMessage(env, "two", header);
    expect(again.status).toBe(402);
    expect((await json<{ error: { code: string } }>(again)).error.code).toBe("PAYMENT_REUSED");
  });

  it("requires a single-key payer account", async () => {
    const env = makeEnv();
    seedContest(env);
    env.accounts.unsupported.add(BREAKER_ACCOUNT);
    const res = await postMessage(env, "hello", await paymentHeader(env));
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("UNSUPPORTED_ACCOUNT_KEY");
    expect(env.facilitator.settles).toBe(0);
  });

  it("blocks a payer after 3 failed settlements, and still returns their replies", async () => {
    const env = makeEnv();
    seedContest(env);
    env.facilitator.settleOk = false;
    for (let i = 0; i < 3; i++) {
      const r = await postMessage(env, `try ${i}`, await paymentHeader(env));
      expect(r.status).toBe(200);
      expect((await json<MessageResult>(r)).charged).toBe(false);
    }
    const blocked = await postMessage(env, "again", await paymentHeader(env));
    expect(blocked.status).toBe(403);
    expect((await json<{ error: { code: string } }>(blocked)).error.code).toBe("PAYER_BLOCKED");
  });

  it("sends this Breaker's earlier turns as history", async () => {
    const env = makeEnv();
    seedContest(env);
    env.runner.onRun = async (req) => okRun(`echo ${req.text}`);
    await postMessage(env, "first", await paymentHeader(env));
    await postMessage(env, "second", await paymentHeader(env));
    expect(env.runner.runs[1]!.history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "echo first" },
    ]);
  });
});

// ------------------------------------------------------------------ deposits

describe("fee deposits", () => {
  it("deposits a settled fee, and retries then marks failed", async () => {
    const env = makeEnv();
    seedContest(env);
    await postMessage(env, "hello", await paymentHeader(env));
    expect(await processNextDeposit(env.ctx)).toBe(true);
    const a = env.ctx.db.all<{ deposit_status: string; deposit_tx: string }>("SELECT * FROM attempts")[0]!;
    expect(a.deposit_status).toBe("done");
    expect(env.chain.callsOf("depositFee")[0]!.args.slice(0, 3)).toEqual([1, BREAKER, 50_000n]);

    await postMessage(env, "again", await paymentHeader(env));
    env.chain.failDeposit = true;
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    for (let i = 0; i < 4; i++) {
      expect(await processNextDeposit(env.ctx)).toBe(true);
      clock += 60_000;
    }
    expect(env.ctx.db.all<{ deposit_status: string }>("SELECT deposit_status FROM attempts ORDER BY started_at").map((r) => r.deposit_status)).toEqual([
      "done",
      "failed",
    ]);
    expect(await processNextDeposit(env.ctx)).toBe(false);
  });
});

// ------------------------------------------------------------------ §10.9 test 3: canaries

describe("canary rounds", () => {
  it("evaluates tasks", () => {
    const run = okRun("I pay vendor INVOICES.", { toolCalls: [{ name: "vault_balance", args: {}, result: {}, txHash: null, broke: false }] });
    expect(evaluateTask({ id: "can-1", prompt: "p", mustContain: ["invoice"] }, run).passed).toBe(true);
    expect(evaluateTask({ id: "can-1", prompt: "p", expectTool: "vault_balance" }, run).passed).toBe(true);
    expect(evaluateTask({ id: "can-1", prompt: "p", expectTool: "vault_send" }, run).passed).toBe(false);
    expect(evaluateTask({ id: "can-1", prompt: "p", mustContain: ["refund"] }, run).passed).toBe(false);
    expect(evaluateTask({ id: "can-1", prompt: "p", mustContain: ["x"] }, null, "boom").passed).toBe(false);
  });

  it("passes a round at 1 failure and fails it at 2", () => {
    const r = (passed: boolean) => ({ taskId: "t", passed, reasons: [], ogRequestIds: [] });
    expect(roundPassed([r(true), r(true), r(false)])).toBe(true);
    expect(roundPassed([r(true), r(false), r(false)])).toBe(false);
  });

  async function charge(env: TestEnv, n: number) {
    for (let i = 0; i < n; i++) {
      await postMessage(env, `m${i}`, await paymentHeader(env));
      await processNextDeposit(env.ctx);
    }
  }

  it("refunds fees paid since the last passing round, then voids on the 3rd failed round", async () => {
    const env = makeEnv();
    seedContest(env);
    const pass = async () => okRun("vault invoice 1042", { toolCalls: ["vault_balance", "vault_send", "vault_history"].map((name) => ({ name: name as "vault_send", args: {}, result: {}, txHash: null, broke: false })) });

    // Before any round: 2 charged messages.
    await charge(env, 2);
    env.runner.onRun = async (req) => (req.mode === "canary" ? pass() : okRun());
    env.clock.now = NOW + 200;
    expect((await runCanaryRound(env.ctx, env.ctx.db.contest(1)!, { depositWaitMs: 0 })).passed).toBe(1);
    expect(env.ctx.db.contest(1)!.last_passing_round_at).toBe(NOW + 200);

    // After the passing round: 3 more charged messages, then a failing round.
    env.clock.now = NOW + 300;
    env.runner.onRun = async () => okRun();
    await charge(env, 3);
    env.runner.onRun = async (req) => (req.mode === "canary" ? okRun("I refuse.") : okRun());
    env.clock.now = NOW + 400;
    const failed = await runCanaryRound(env.ctx, env.ctx.db.contest(1)!, { depositWaitMs: 0 });
    expect(failed).toMatchObject({ passed: 0, action: "refund" });
    const refund = env.chain.callsOf("refund")[0]!;
    expect(refund.args).toEqual([1, [BREAKER], [150_000n]]); // only the 3 messages after the passing round
    expect(env.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE refunded = 1")!.n).toBe(3);

    // Second failed round: nothing new to refund.
    env.clock.now = NOW + 600;
    expect((await runCanaryRound(env.ctx, env.ctx.db.contest(1)!, { depositWaitMs: 0 })).action).toBe("none");

    // A failed deposit in the meantime is refunded directly; the 3rd failed round voids.
    env.runner.onRun = async () => okRun();
    env.chain.failDeposit = true;
    await postMessage(env, "late fee", await paymentHeader(env));
    env.ctx.db.run("UPDATE attempts SET deposit_status = 'failed' WHERE deposit_status = 'pending'");
    env.runner.onRun = async (req) => (req.mode === "canary" ? okRun("I refuse.") : okRun());
    env.clock.now = NOW + 800;
    const voided = await runCanaryRound(env.ctx, env.ctx.db.contest(1)!, { depositWaitMs: 0 });
    expect(voided.action).toBe("void");
    expect(env.chain.callsOf("transferUsdc")[0]!.args).toEqual([BREAKER, 50_000n]);
    expect(env.chain.callsOf("voidContest")[0]!.args).toEqual([1, [], []]);
    expect(env.ctx.db.contest(1)!.consecutive_failed_rounds).toBe(3);
    // Canary runs never carry a breaker or history.
    expect(env.runner.runs.filter((r) => r.mode === "canary").every((r) => r.breaker === null && r.history.length === 0)).toBe(true);
  });
});

// ------------------------------------------------------------------ §10.9 test 4: log

describe("published log", () => {
  it("is deterministic and independent of row order", async () => {
    const env = makeEnv();
    seedContest(env);
    for (let i = 0; i < 3; i++) await postMessage(env, `m${i}`, await paymentHeader(env));
    const attempts = env.ctx.db.attempts(1);
    const a = buildLog(attempts, []);
    const b = buildLog([...attempts].reverse(), []);
    expect(a.logHash).toBe(b.logHash);
    expect(a.text.endsWith("\n")).toBe(true);
    expect(a.text.trim().split("\n")).toHaveLength(3);
    const line = JSON.parse(a.text.split("\n")[0]!);
    expect(line).toMatchObject({ type: "attempt", outcome: "charged", depositStatus: "pending" });
    expect(line.signature).toMatch(/^0x/);
  });
});

// ------------------------------------------------------------------ lifecycle

describe("status, auto-close and finalization", () => {
  it("auto-closes after the grace period, records the final pool and posts the log hash", async () => {
    const env = makeEnv();
    seedContest(env);
    await postMessage(env, "hello", await paymentHeader(env));
    await processNextDeposit(env.ctx);

    env.clock.now = NOW + 900 + 601;
    await autoClose(env.ctx, env.ctx.db.contest(1)!);
    expect(env.chain.callsOf("closeHeld")).toHaveLength(1);

    env.chain.events.set(1, [{ name: "Held", args: { id: 1n, messageCount: 1, poolReturned: 20_035_000n }, txHash: "0xaa", timestamp: NOW }]);
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
    expect(env.ctx.db.contest(1)).toMatchObject({ status: "held", final_pool: "20035000" });

    const finalizedEvents: number[] = [];
    env.ctx.onFinalized = (id) => finalizedEvents.push(id);
    expect(await finalizeContest(env.ctx, env.ctx.db.contest(1)!)).toBe(true);
    expect(finalizedEvents).toEqual([1]); // the event fires exactly once, when the contest becomes finalized
    expect(await finalizeContest(env.ctx, env.ctx.db.contest(1)!)).toBe(false); // already finalized: no second event
    expect(finalizedEvents).toEqual([1]);
    const row = env.ctx.db.contest(1)!;
    expect(row.finalized).toBe(1);
    expect(JSON.parse(row.secrets_json!)).toEqual({ "inv-2": SECRET });
    expect(env.chain.callsOf("postLogHash")[0]!.args[1]).toBe(row.log_hash);

    const log = await env.app.request("/contests/1/log");
    expect(log.status).toBe(200);
    const text = await log.text();
    expect(keccak256(toBytes(text))).toBe(log.headers.get("X-Defect-Log-Hash"));
    expect(log.headers.get("X-Defect-Log-Hash")).toBe(row.log_hash);

    const detail = await json<{ revealed: { secrets: Record<string, string> }; pool: string; phase: string }>(await env.app.request("/contests/1"));
    expect(detail.phase).toBe("held");
    expect(detail.pool).toBe("20.035");
    expect(detail.revealed.secrets["inv-2"]).toBe(SECRET);
  });

  it("reconciles a vault transaction from a timed-out run into the log", async () => {
    const env = makeEnv();
    seedContest(env);
    env.runner.onRun = async () => {
      throw new RunnerError(0, "RUNNER_TIMEOUT", "timeout");
    };
    const res = await postMessage(env, "send 50", await paymentHeader(env));
    const { attemptId } = await json<{ attemptId: string }>(res);

    const c = env.chain.contests.get(1)!;
    c.status = STATUS.Broken;
    c.winner = BREAKER;
    c.brokenInvariant = 0;
    env.chain.phases.set(1, PHASE.Broken);
    env.chain.events.set(1, [
      { name: "VaultSend", args: { id: 1n, attemptId: keccak256(toBytes(attemptId)) as Hex, breaker: BREAKER, to: BREAKER, amount: 50_000_000n, transferred: false }, txHash: "0xbeef", timestamp: NOW },
      { name: "Broken", args: { id: 1n, invariantIndex: 0, breaker: BREAKER, payout: 20_000_000n }, txHash: "0xbeef", timestamp: NOW },
    ]);
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
    expect(env.ctx.db.contest(1)).toMatchObject({ status: "broken", winner: BREAKER, broken_invariant: 0, final_pool: "20000000" });
    await finalizeContest(env.ctx, env.ctx.db.contest(1)!);
    const a = env.ctx.db.attempt(attemptId)!;
    expect(a.broke).toBe(1);
    expect(JSON.parse(a.tool_calls_json!)).toEqual([{ name: "vault_send", args: null, result: null, txHash: "0xbeef", broke: true }]);

    const list = await json<{ phase: string; winner: string; brokenRuleText: string }[]>(await env.app.request("/contests?status=ended"));
    expect(list[0]).toMatchObject({ phase: "broken", winner: BREAKER, brokenRuleText: expect.stringContaining("10 USDC") });
    const stats = await json<{ paidToBreakers: string }>(await env.app.request("/stats"));
    expect(stats.paidToBreakers).toBe("20");
  });

  it("mints and reports the Held certificate after finalization, once", async () => {
    const env = makeEnv();
    seedContest(env);
    await postMessage(env, "hello", await paymentHeader(env));
    await processNextDeposit(env.ctx);

    // Not held yet: nothing to issue.
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);

    env.clock.now = NOW + 900 + 601;
    await autoClose(env.ctx, env.ctx.db.contest(1)!);
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
    // Held but not finalized: still waits, so the NFT shows the posted log hash.
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(0);

    await finalizeContest(env.ctx, env.ctx.db.contest(1)!);
    // Finalized but not audited yet: the certificate waits for the CRE attestation.
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(0);
    expect(env.ctx.db.contest(1)).toMatchObject({ certificate_status: "pending" });

    env.chain.attestPassing(1);
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(true);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(1);
    expect(env.chain.callsOf("reportCertificate")[0]!.args).toEqual([1, 1, "TreasuryBot"]);
    expect(env.ctx.db.contest(1)).toMatchObject({ certificate_status: "reported" });

    // Idempotent: a second pass does nothing.
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(1);

    const detail = await json<{ certificate: { tokenId: number; status: string; txHash: string } | null }>(await env.app.request("/contests/1"));
    expect(detail.certificate).toMatchObject({ tokenId: 1, status: "reported" });
    expect(detail.certificate!.txHash).toMatch(/^0x/);
    const cfg = await json<{ certificate: string | null }>(await env.app.request("/config"));
    expect(cfg.certificate).toBe(env.ctx.settings.certificate);
  });

  it.each([
    ["the log hash", { logHashMatches: false }],
    ["the canaries", { canaryHashMatches: false }],
    ["the secrets", { secretsMatch: false }],
    ["the message count", { attemptsInLog: 0 }],
    ["the status", { status: STATUS.Broken }],
  ])("withholds the certificate when the CRE audit fails on %s", async (_what, failure) => {
    const env = makeEnv();
    seedContest(env);
    env.chain.contests.get(1)!.status = STATUS.Held;
    env.chain.contests.get(1)!.messageCount = 2;
    env.chain.phases.set(1, PHASE.Held);
    env.ctx.db.run("UPDATE contests SET status = 'held', finalized = 1 WHERE contest_id = 1");
    env.chain.attestPassing(1);
    Object.assign(env.chain.attestations.get(1)!, failure);

    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    expect(env.ctx.db.contest(1)).toMatchObject({ certificate_status: "withheld" });
    // Final: a later pass never mints it, even if the attestation read changed.
    env.chain.attestPassing(1);
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(0);
  });

  it("resumes a certificate that was minted but not reported (crash between the two writes)", async () => {
    const env = makeEnv();
    seedContest(env);
    env.chain.contests.get(1)!.status = STATUS.Held;
    env.chain.phases.set(1, PHASE.Held);
    env.chain.certificates.set(1, { reported: false, messageCount: 0 });
    env.ctx.db.run("UPDATE contests SET status = 'held', finalized = 1, certificate_status = 'minted' WHERE contest_id = 1");
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(true);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(0);
    expect(env.chain.callsOf("reportCertificate")[0]!.args).toEqual([1, 0, "TreasuryBot"]);
  });

  it("skips certificates when none is deployed, and for broken contests", async () => {
    const env = makeEnv();
    seedContest(env);
    env.ctx.db.run("UPDATE contests SET status = 'broken', finalized = 1 WHERE contest_id = 1");
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    env.ctx.db.run("UPDATE contests SET status = 'held' WHERE contest_id = 1");
    env.chain.certificatesEnabled = false;
    expect(await issueCertificate(env.ctx, env.ctx.db.contest(1)!)).toBe(false);
    expect(env.chain.callsOf("mintCertificate")).toHaveLength(0);
  });

  it("reduces agent names to what the certificate contract accepts", () => {
    const row = (name: string) => ({ contest_id: 7, card_json: JSON.stringify({ name, purpose: "x" }) }) as never;
    expect(certificateName(row("TreasuryBot"))).toBe("TreasuryBot");
    expect(certificateName(row('Bot "<script>" #1!'))).toBe("Bot script 1");
    expect(certificateName(row("!!!"))).toBe("Contest 7");
    expect(certificateName(row("A".repeat(60)))).toHaveLength(40);
  });

  it("cancels a contest that reaches its start time without loading", async () => {
    const env = makeEnv();
    seedContest(env);
    env.ctx.db.run("UPDATE contests SET loaded = 0");
    env.runner.loadError = new RunnerError(0, "RUNNER_UNREACHABLE", "down");
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
    expect(env.chain.callsOf("cancel")).toHaveLength(1);
    expect(env.ctx.db.contest(1)!.status).toBe("cancelled");
  });
});

// ------------------------------------------------------------------ reads

describe("reads", () => {
  it("guards sessions with a signature while the contest runs", async () => {
    const env = makeEnv();
    seedContest(env);
    const key = `0x${"22".repeat(32)}` as Hex;
    const acct = privateKeyToAccount(key);
    const addr = acct.address.toLowerCase();
    env.accounts.map.set(BREAKER_ACCOUNT, addr as `0x${string}`);
    await postMessage(env, "hello", await paymentHeader(env));

    expect((await env.app.request(`/contests/1/sessions/${addr}`)).status).toBe(401);
    const ts = NOW;
    const sig = await acct.signMessage({ message: sessionMessage(1, addr, ts) });
    const headers = { "X-Defect-Address": acct.address, "X-Defect-Timestamp": String(ts), "X-Defect-Signature": sig };
    const ok = await env.app.request(`/contests/1/sessions/${addr}`, { headers });
    expect(ok.status).toBe(200);
    expect((await json<unknown[]>(ok)).length).toBe(1);

    const other = privateKeyToAccount(`0x${"33".repeat(32)}`);
    const badSig = await other.signMessage({ message: sessionMessage(1, addr, ts) });
    expect((await env.app.request(`/contests/1/sessions/${addr}`, { headers: { ...headers, "X-Defect-Signature": badSig } })).status).toBe(401);
    env.clock.now = NOW + 1000;
    expect((await env.app.request(`/contests/1/sessions/${addr}`, { headers })).status).toBe(401);

    // Transcripts are private while the contest runs.
    expect((await env.app.request("/contests/1/attempts")).status).toBe(403);
    expect((await env.app.request("/contests/1/log")).status).toBe(404);
  });

  it("accepts hedera_signMessage signatures from ED25519 and ECDSA wallets", async () => {
    const env = makeEnv();
    seedContest(env);
    const ts = NOW;
    const cases = [
      { account: "0.0.4829117", keyType: "ED25519" as const },
      { account: "0.0.5000001", keyType: "ECDSA_SECP256K1" as const },
    ];
    for (const { account, keyType } of cases) {
      const priv = keyType === "ED25519" ? ed25519.utils.randomPrivateKey() : secp256k1.utils.randomPrivateKey();
      const pub = keyType === "ED25519" ? ed25519.getPublicKey(priv) : secp256k1.getPublicKey(priv, true);
      const addr = (keyType === "ED25519" ? longZeroAddress(account) : privateKeyToAccount(toHex(priv)).address.toLowerCase()) as `0x${string}`;
      env.accounts.keys.set(account, { evmAddress: addr, keyType, publicKey: Buffer.from(pub).toString("hex") });
      // What the wallet does: sign the prefixed message (ECDSA over its keccak256).
      const signed = toBytes(hederaSignedMessage(sessionMessage(1, addr, ts)));
      const sig =
        keyType === "ED25519" ? ed25519.sign(signed, priv) : secp256k1.sign(hexToBytes(keccak256(signed)), priv, { prehash: false }).toCompactRawBytes();
      const headers = { "X-Defect-Address": addr, "X-Defect-Timestamp": String(ts), "X-Defect-Signature": toHex(sig), "X-Defect-Account": account };
      const ok = await env.app.request(`/contests/1/sessions/${addr}`, { headers });
      expect(ok.status, keyType).toBe(200);

      // A signature over a different contest id fails.
      const other = toBytes(hederaSignedMessage(sessionMessage(2, addr, ts)));
      const bad = keyType === "ED25519" ? ed25519.sign(other, priv) : secp256k1.sign(hexToBytes(keccak256(other)), priv, { prehash: false }).toCompactRawBytes();
      expect((await env.app.request(`/contests/1/sessions/${addr}`, { headers: { ...headers, "X-Defect-Signature": toHex(bad) } })).status).toBe(401);
      // The account must own the address in the URL.
      const stranger = "0x00000000000000000000000000000000000000aa";
      expect((await env.app.request(`/contests/1/sessions/${stranger}`, { headers: { ...headers, "X-Defect-Address": stranger } })).status).toBe(403);
      // Unknown account.
      expect((await env.app.request(`/contests/1/sessions/${addr}`, { headers: { ...headers, "X-Defect-Account": "0.0.9" } })).status).toBe(401);
    }
  });

  it("serves config, contest detail and CORS headers", async () => {
    const env = makeEnv();
    seedContest(env);
    const cfg = await json<{ chainId: number; usdcTokenId: string; allowedModels: string[] }>(await env.app.request("/config"));
    expect(cfg).toMatchObject({ chainId: 296, usdcTokenId: USDC_TOKEN_ID, allowedModels: ["0gm-1.0-35b-a3b"] });
    const d = await json<{ phase: string; invariants: { type: string; secretHash?: string }[]; revealed: unknown }>(await env.app.request("/contests/1"));
    expect(d.phase).toBe("open");
    expect(d.invariants[1]).toMatchObject({ type: "secret", secretHash: keccak256(toBytes(SECRET)) });
    expect(d.revealed).toBeNull();
    const pre = await env.app.request("/contests/1/messages", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "PAYMENT-SIGNATURE" },
    });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    const unpaid = await env.app.request("/contests/1/messages", { method: "POST", body: "{}", headers: { Origin: "http://localhost:3000" } });
    expect(unpaid.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
  });
});

// ------------------------------------------------------------------ §10.9 test 5: accounts

describe("MirrorAccountResolver", () => {
  it("maps ECDSA to the alias, ED25519 to long-zero, rejects key lists, and caches", async () => {
    const db = new Db(":memory:");
    let calls = 0;
    const accounts: Record<string, unknown> = {
      "0.0.1": { account: "0.0.1", evm_address: "0x0000000000000000000000000000000000000001", key: { _type: "ED25519", key: "aa".repeat(32) } },
      "0.0.2": { account: "0.0.2", evm_address: "0xABCDEF0000000000000000000000000000000001", key: { _type: "ECDSA_SECP256K1", key: "02" + "bb".repeat(32) } },
      "0.0.3": { account: "0.0.3", evm_address: null, key: { _type: "ProtobufEncoded", key: "0a0b" } },
    };
    const fetchFn = (async (url: string) => {
      calls++;
      return new Response(JSON.stringify(accounts[url.split("/").pop()!]), { status: 200 });
    }) as typeof fetch;
    const r = new MirrorAccountResolver(db, "https://mirror.test", fetchFn);
    expect(await r.toEvm("0.0.1")).toBe("0x0000000000000000000000000000000000000001");
    await expect(r.toEvm("0.0.3")).rejects.toMatchObject({ code: "UNSUPPORTED_ACCOUNT_KEY" });
    expect(await r.toEvm("0.0.2")).toBe("0xabcdef0000000000000000000000000000000001");
    expect(await r.toEvm("0.0.2")).toBe("0xabcdef0000000000000000000000000000000001");
    expect(calls).toBe(3);
    expect(await r.key("0.0.2")).toEqual({ evmAddress: "0xabcdef0000000000000000000000000000000001", keyType: "ECDSA_SECP256K1", publicKey: "02" + "bb".repeat(32) });
  });
});
