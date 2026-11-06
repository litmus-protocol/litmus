import { describe, expect, it } from "vitest";
import { PHASE, STATUS } from "../src/chain";
import { fromJsonDataUri, type DefectFeedbackFile, type DraftResponse, type WardenSubmission } from "@defect/shared";
import { keccak256, type Address, type Hex } from "viem";
import { postWardenFeedback } from "../src/jobs/agent-feedback";
import { processNextDeposit } from "../src/jobs/deposits";
import { autoClose, finalizeContest, issueCertificate, pollContest } from "../src/jobs/lifecycle";
import { BREAKER, NOW, makeEnv, paymentHeader, postMessage, seedContest, submission, type TestEnv } from "./helpers";

const WARDEN = "0x9000000000000000000000000000000000000009" as Address;
const OTHER = "0x5000000000000000000000000000000000000005" as Address;
const AGENT_ID = 7;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function postDraft(env: TestEnv, body: unknown) {
  return env.app.request("/drafts", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
}

function agentSubmission(overrides: Partial<WardenSubmission> = {}): WardenSubmission {
  const base = submission();
  return { ...base, card: { ...base.card, agentId: AGENT_ID }, warden: WARDEN, ...overrides };
}

function addAgent(env: TestEnv, owner: Address = WARDEN, operators: string[] = []) {
  env.chain.agents.set(AGENT_ID, { owner, wallet: owner, uri: "", operators: new Set(operators) });
}

async function errorOf(res: Response) {
  return (await json<{ error: { code: string; message: string } }>(res)).error;
}

describe("agent link", () => {
  it("accepts a draft when the agent is owned by the warden", async () => {
    const env = makeEnv();
    addAgent(env);
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(201);
  });

  it("rejects an unknown agent id with AGENT_NOT_FOUND", async () => {
    const env = makeEnv();
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("AGENT_NOT_FOUND");
  });

  it("rejects an agent owned by someone else with AGENT_NOT_OWNED", async () => {
    const env = makeEnv();
    addAgent(env, OTHER);
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("AGENT_NOT_OWNED");
  });

  it("compares the owner case-insensitively", async () => {
    const env = makeEnv();
    addAgent(env, WARDEN.toUpperCase().replace("0X", "0x") as Address);
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(201);
  });

  it("rejects an agent that approved the operator with AGENT_BLOCKS_DEFECT", async () => {
    const env = makeEnv();
    addAgent(env, WARDEN, [env.chain.operatorAddress]);
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe("AGENT_BLOCKS_DEFECT");
    expect(err.message).toBe("This agent has approved Defect's operator, so Defect couldn't post its results. Remove that approval and try again.");
  });

  it("rejects with ERC8004_DISABLED when registries are not deployed, but still accepts a draft without an agent", async () => {
    const env = makeEnv();
    env.chain.erc8004 = null;
    env.ctx.settings.erc8004 = null;
    addAgent(env);
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("ERC8004_DISABLED");
    const plain = await postDraft(env, submission());
    expect(plain.status).toBe(201);
  });

  it("returns 503 CHAIN_UNAVAILABLE when the registry read throws", async () => {
    const env = makeEnv();
    addAgent(env);
    env.chain.agentOwner = async () => {
      throw new Error("rpc down");
    };
    const res = await postDraft(env, agentSubmission());
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("CHAIN_UNAVAILABLE");
  });

  describe("confirm", () => {
    function seedChain(env: TestEnv, d: DraftResponse, id = 7) {
      env.chain.contests.set(id, {
        warden: WARDEN,
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

    async function draftWithAgent(env: TestEnv): Promise<DraftResponse> {
      addAgent(env);
      const d = await json<DraftResponse>(await postDraft(env, agentSubmission()));
      seedChain(env, d);
      return d;
    }

    it("stores agent_id when the agent is still owned by the on-chain warden", async () => {
      const env = makeEnv();
      const d = await draftWithAgent(env);
      const res = await confirm(env, d.draftId);
      expect(res.status).toBe(200);
      expect(env.ctx.db.contest(7)!.agent_id).toBe(AGENT_ID);
      expect(env.ctx.db.contest(7)!.agent_feedback_status).toBe("none");
      expect(env.ctx.db.contest(7)!.winner_feedback_status).toBe("none");
    });

    it("stores null and still confirms when the agent was transferred after the draft", async () => {
      const env = makeEnv();
      const d = await draftWithAgent(env);
      env.chain.agents.get(AGENT_ID)!.owner = OTHER;
      const res = await confirm(env, d.draftId);
      expect(res.status).toBe(200);
      expect(env.ctx.db.contest(7)!.agent_id).toBeNull();
      expect(env.logs.some((l) => l.startsWith("contest 7: dropped ERC-8004 link to agent 7 ("))).toBe(true);
    });

    it("stores null when the agent approved the operator after the draft", async () => {
      const env = makeEnv();
      const d = await draftWithAgent(env);
      env.chain.agents.get(AGENT_ID)!.operators.add(env.chain.operatorAddress);
      const res = await confirm(env, d.draftId);
      expect(res.status).toBe(200);
      expect(env.ctx.db.contest(7)!.agent_id).toBeNull();
    });

    it("stores null and still confirms when the registry read throws", async () => {
      const env = makeEnv();
      const d = await draftWithAgent(env);
      env.chain.agentOwner = async () => {
        throw new Error("rpc down");
      };
      const res = await confirm(env, d.draftId);
      expect(res.status).toBe(200);
      expect(env.ctx.db.contest(7)!.agent_id).toBeNull();
      expect(env.logs.some((l) => l.includes("dropped ERC-8004 link to agent 7") && l.includes("rpc down"))).toBe(true);
    });
  });
});

describe("warden feedback", () => {
  const BREAKER_2_ACCOUNT = "0.0.7002";
  const BREAKER_2 = "0x7002000000000000000000000000000000007002" as Address;

  function linked(env: TestEnv, id = 1): void {
    addAgent(env);
    env.ctx.db.run("UPDATE contests SET agent_id = ? WHERE contest_id = ?", [AGENT_ID, id]);
  }

  async function chargedMessage(env: TestEnv, payer?: { account: string; evm: Address }): Promise<void> {
    if (payer) {
      env.accounts.map.set(payer.account, payer.evm);
      env.facilitator.payer = payer.account;
    }
    await postMessage(env, "hello", await paymentHeader(env));
    await processNextDeposit(env.ctx);
  }

  async function closeHeld(env: TestEnv, opts: { finalize?: boolean } = {}): Promise<void> {
    env.clock.now = NOW + 900 + 601;
    await autoClose(env.ctx, env.ctx.db.contest(1)!);
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
    if (opts.finalize === false) return;
    await finalizeContest(env.ctx, env.ctx.db.contest(1)!);
    await issueCertificate(env.ctx, env.ctx.db.contest(1)!);
  }

  async function breakContest(env: TestEnv): Promise<void> {
    const c = env.chain.contests.get(1)!;
    c.status = STATUS.Broken;
    c.winner = BREAKER;
    c.brokenInvariant = 1;
    env.chain.phases.set(1, PHASE.Broken);
    env.chain.events.set(1, [{ name: "Broken", args: { id: 1n, invariantIndex: 1, breaker: BREAKER, payout: 20_000_000n }, txHash: "0xbeef" as Hex, timestamp: NOW }]);
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
  }

  const run = (env: TestEnv) => postWardenFeedback(env.ctx, env.ctx.db.contest(1)!);
  const state = (env: TestEnv) => env.ctx.db.contest(1)!;

  it("posts Held feedback with 2 paying breakers: value 100, tags, endpoint and a hash-bound file", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await chargedMessage(env);
    await chargedMessage(env, { account: BREAKER_2_ACCOUNT, evm: BREAKER_2 });
    await closeHeld(env);
    expect(state(env).certificate_status).toBe("reported");

    await run(env);
    const calls = env.chain.callsOf("giveFeedback");
    expect(calls).toHaveLength(1);
    const f = calls[0]!.args[0] as { agentId: number; value: bigint; valueDecimals: number; tag1: string; tag2: string; endpoint: string; feedbackURI: string; feedbackHash: Hex };
    expect(f).toMatchObject({ agentId: AGENT_ID, value: 100n, valueDecimals: 0, tag1: "defect.held", tag2: "demo:1" });
    expect(f.endpoint).toBe("http://localhost:3000/contests/1");

    const file = fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile;
    expect(file.defect.packageHash).toBe(env.chain.contests.get(1)!.packageHash);
    expect(file.defect).toMatchObject({ status: "held", uniqueBreakers: 2, messageCount: 2, certificateTokenId: 1, attestations: null, brokenInvariant: null, breakTx: null });
    expect(file.defect.invariants[0]).toEqual({ kind: "transfer_limit", text: expect.any(String) });
    expect(file.defect.logHash).toBe(state(env).log_hash);
    expect(file.clientAddress).toBe(`eip155:296:${env.chain.operatorAddress.toLowerCase()}`);
    expect(file).toMatchObject({ value: 100, valueDecimals: 0, tag1: "defect.held", tag2: "demo:1", agentId: AGENT_ID });
    const json = Buffer.from(f.feedbackURI.split(",")[1]!, "base64");
    expect(f.feedbackHash).toBe(keccak256(new Uint8Array(json)));

    expect(state(env)).toMatchObject({ agent_feedback_status: "posted", agent_feedback_tx: env.chain.feedback[0]!.txHash });
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(1);
  });

  it("skips Held feedback when no charged message reached the contract", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await closeHeld(env);
    await run(env);
    expect(state(env).agent_feedback_status).toBe("skipped");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
  });

  it("waits for a Held contest to be finalized and certified", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await chargedMessage(env);
    await closeHeld(env, { finalize: false });
    await run(env);
    expect(state(env).agent_feedback_status).toBe("none");

    await finalizeContest(env.ctx, state(env));
    await run(env); // finalized, but the certificate isn't reported yet
    expect(state(env).agent_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);

    await issueCertificate(env.ctx, state(env));
    await run(env);
    expect(state(env).agent_feedback_status).toBe("posted");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(1);
  });

  it("does not wait for a certificate when none is configured", async () => {
    const env = makeEnv();
    env.ctx.settings.certificate = null;
    seedContest(env);
    linked(env);
    await chargedMessage(env);
    await closeHeld(env);
    await run(env);
    expect(state(env).agent_feedback_status).toBe("posted");
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { feedbackURI: string };
    expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).defect.certificateTokenId).toBeNull();
  });

  it("posts Broken feedback right away, before finalization: value 0 with the broken invariant", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await chargedMessage(env);
    await breakContest(env);
    expect(state(env).finalized).toBe(0);

    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { value: bigint; valueDecimals: number; tag1: string; tag2: string; feedbackURI: string };
    expect(f).toMatchObject({ value: 0n, valueDecimals: 0, tag1: "defect.broken", tag2: "demo:1" });
    const file = fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile;
    expect(file.defect).toMatchObject({
      status: "broken",
      brokenInvariant: 1,
      breakTx: "0xbeef",
      logHash: null,
      certificateTokenId: null,
      finalPool: "20000000",
      uniqueBreakers: 1,
    });
    expect(state(env).agent_feedback_status).toBe("posted");
  });

  it("skips Void and Cancelled contests", async () => {
    for (const status of ["void", "cancelled"]) {
      const env = makeEnv();
      seedContest(env);
      linked(env);
      env.ctx.db.run("UPDATE contests SET status = ? WHERE contest_id = 1", [status]);
      await run(env);
      expect(state(env).agent_feedback_status).toBe("skipped");
      expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    }
  });

  it("skips a contest with no linked agent, and does nothing when registries are not deployed", async () => {
    const env = makeEnv();
    seedContest(env);
    await breakContest(env);
    await run(env);
    expect(state(env).agent_feedback_status).toBe("skipped");

    const off = makeEnv();
    off.ctx.settings.erc8004 = null;
    seedContest(off);
    linked(off);
    await breakContest(off);
    await run(off);
    expect(state(off).agent_feedback_status).toBe("none");
  });

  it("blocks when the owner approved the operator, with no call and no retry", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    env.chain.agents.get(AGENT_ID)!.operators.add(env.chain.operatorAddress);
    await breakContest(env);
    await run(env);
    expect(state(env).agent_feedback_status).toBe("blocked");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    expect(state(env).agent_feedback_status).toBe("blocked");
  });

  it("recovers from a crash after the registry write: an existing entry marks posted with no new call", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await breakContest(env);
    env.chain.feedback.push({ agentId: AGENT_ID, tag1: "defect.broken", tag2: "demo:1", value: 0n, valueDecimals: 0, feedbackURI: "data:application/json;base64,e30=", revoked: false });
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    expect(state(env)).toMatchObject({ agent_feedback_status: "posted", agent_feedback_tx: null });
  });

  it("stays none when giveFeedback throws, never touches the contest, and retries on the next run", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await breakContest(env);
    const before = state(env);
    const give = env.chain.giveFeedback.bind(env.chain);
    env.chain.giveFeedback = async () => {
      throw new Error("rpc down");
    };
    await run(env);
    const after = state(env);
    expect(after.agent_feedback_status).toBe("none");
    expect(env.logs.some((l) => l === "agent feedback 1 failed: rpc down")).toBe(true);
    expect({ ...after, agent_feedback_status: before.agent_feedback_status }).toEqual(before);

    env.chain.giveFeedback = give;
    await run(env);
    expect(state(env).agent_feedback_status).toBe("posted");
  });
});
