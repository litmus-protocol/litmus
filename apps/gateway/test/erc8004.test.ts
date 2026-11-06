import { beforeEach, describe, expect, it } from "vitest";
import { PHASE, STATUS } from "../src/chain";
import { buildAgentCard, fromJsonDataUri, toJsonDataUri, type AgentProfile, type ContestDetail, type DefectFeedbackFile, type DraftResponse, type WardenSubmission } from "@defect/shared";
import { keccak256, type Address, type Hex } from "viem";
import { postWardenFeedback, postWinnerFeedback } from "../src/jobs/agent-feedback";
import { agentProfile } from "../src/services/agents";
import { AGENT_LINK_TIMEOUT_MS } from "../src/services/drafts";
import { clearAgentLinkCache, flushAgentLinks, linkAttemptAgent, parseAgentIdHeader } from "../src/services/agent-header";
import { processNextDeposit } from "../src/jobs/deposits";
import { autoClose, finalizeContest, issueCertificate, pollContest } from "../src/jobs/lifecycle";
import { BREAKER, FAKE_IDENTITY_REGISTRY, NOW, makeEnv, paymentHeader, postMessage, seedContest, submission, type TestEnv } from "./helpers";

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

    it("stores null and confirms within the timeout when the registry read hangs", async () => {
      const env = makeEnv();
      const d = await draftWithAgent(env);
      env.chain.agentOwner = () => new Promise<Address | null>(() => {});
      const t0 = Date.now();
      const res = await confirm(env, d.draftId);
      expect(Date.now() - t0).toBeLessThan(AGENT_LINK_TIMEOUT_MS + 2000);
      expect(res.status).toBe(200);
      expect(env.ctx.db.contest(7)!.agent_id).toBeNull();
      expect(env.logs.some((l) => l.includes("dropped ERC-8004 link to agent 7") && l.includes("timed out"))).toBe(true);
    }, AGENT_LINK_TIMEOUT_MS + 5000);
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
    env.chain.attestPassing(1);
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

    env.chain.attestPassing(1);
    await issueCertificate(env.ctx, state(env));
    await run(env);
    expect(state(env).agent_feedback_status).toBe("posted");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(1);
  });

  it("skips Held feedback when the CRE audit failed and the certificate was withheld", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await chargedMessage(env);
    await closeHeld(env, { finalize: false });
    await finalizeContest(env.ctx, state(env));
    env.chain.attestPassing(1);
    env.chain.attestations.get(1)!.secretsMatch = false;
    await issueCertificate(env.ctx, state(env));
    expect(state(env).certificate_status).toBe("withheld");

    await run(env);
    expect(state(env).agent_feedback_status).toBe("skipped");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
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

  it("recovers from a crash after the registry write: an existing entry marks posted with its tx and no new call", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await breakContest(env);
    const tx = `0x${"c".repeat(64)}` as Hex;
    env.chain.feedback.push({ agentId: AGENT_ID, tag1: "defect.held", tag2: "demo:1", value: 100n, valueDecimals: 0, feedbackURI: "data:application/json;base64,e30=", revoked: false, txHash: `0x${"d".repeat(64)}` as Hex });
    env.chain.feedback.push({ agentId: AGENT_ID, tag1: "defect.broken", tag2: "demo:1", value: 0n, valueDecimals: 0, feedbackURI: "data:application/json;base64,e30=", revoked: false, txHash: tx });
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    expect(state(env)).toMatchObject({ agent_feedback_status: "posted", agent_feedback_tx: tx });
  });

  it("recovery stores a null tx when the registry log doesn't show the entry yet", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await breakContest(env);
    env.chain.feedback.push({ agentId: AGENT_ID, tag1: "defect.broken", tag2: "demo:1", value: 0n, valueDecimals: 0, feedbackURI: "data:application/json;base64,e30=", revoked: false });
    env.chain.feedbackEvents = async () => [];
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    expect(state(env)).toMatchObject({ agent_feedback_status: "posted", agent_feedback_tx: null });
  });

  it("waits for the Broken event before posting, then posts with its tx", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await breakContest(env);
    const events = env.chain.events.get(1)!;
    env.chain.events.set(1, []);
    await run(env);
    expect(state(env).agent_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);

    env.chain.events.set(1, events);
    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { feedbackURI: string };
    expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).defect).toMatchObject({ breakTx: "0xbeef", finalPool: "20000000" });
    expect(state(env).agent_feedback_status).toBe("posted");
  });

  it("stays none and logs when the contest events can't be read", async () => {
    const env = makeEnv();
    seedContest(env);
    linked(env);
    await breakContest(env);
    env.chain.contestEvents = async () => {
      throw new Error("mirror down");
    };
    await run(env);
    expect(state(env).agent_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    expect(env.logs).toContain("agent feedback 1 failed: mirror down");
  });

  it("posts nothing while SITE_URL is unset, and uses SITE_URL for the endpoint once set", async () => {
    const env = makeEnv();
    env.ctx.settings.siteUrl = null;
    seedContest(env);
    linked(env);
    await breakContest(env);
    await run(env);
    expect(state(env).agent_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);

    env.ctx.settings.siteUrl = "https://defect.example";
    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { endpoint: string; feedbackURI: string };
    expect(f.endpoint).toBe("https://defect.example/contests/1");
    expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).endpoint).toBe("https://defect.example/contests/1");
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

describe("breaker agent", () => {
  const BREAKER_AGENT = 9;

  beforeEach(() => clearAgentLinkCache());

  function breakerAgent(env: TestEnv, owner: Address = BREAKER, wallet: Address = owner): void {
    env.chain.agents.set(BREAKER_AGENT, { owner, wallet, uri: "", operators: new Set() });
  }

  async function paidMessage(env: TestEnv, agentHeader?: string): Promise<Response> {
    const res = await env.app.request("/contests/1/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": await paymentHeader(env), ...(agentHeader === undefined ? {} : { "X-Agent-Id": agentHeader }) },
    });
    await flushAgentLinks();
    return res;
  }

  const attemptAgent = (env: TestEnv) => env.ctx.db.get<{ agent_id: number | null }>("SELECT agent_id FROM attempts WHERE contest_id = 1")!.agent_id;

  async function breakContest(env: TestEnv): Promise<void> {
    const c = env.chain.contests.get(1)!;
    c.status = STATUS.Broken;
    c.winner = BREAKER;
    c.brokenInvariant = 1;
    env.chain.phases.set(1, PHASE.Broken);
    env.chain.events.set(1, [{ name: "Broken", args: { id: 1n, invariantIndex: 1, breaker: BREAKER, payout: 1_035_000n }, txHash: "0xbeef" as Hex, timestamp: NOW }]);
    await pollContest(env.ctx, env.ctx.db.contest(1)!);
    env.ctx.db.run("UPDATE contests SET final_pool = '1035000' WHERE contest_id = 1");
  }

  const run = (env: TestEnv) => postWinnerFeedback(env.ctx, env.ctx.db.contest(1)!);
  const state = (env: TestEnv) => env.ctx.db.contest(1)!;

  it("parses X-Agent-Id strictly", () => {
    expect(parseAgentIdHeader("12")).toBe(12);
    expect(parseAgentIdHeader("0")).toBe(0);
    for (const bad of ["abc", "-1", "1e3", "", " 1", "1234567890123456", undefined]) expect(parseAgentIdHeader(bad)).toBeNull();
  });

  it("links an attempt to the agent when its wallet is the payer", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    expect((await paidMessage(env, String(BREAKER_AGENT))).status).toBe(200);
    expect(attemptAgent(env)).toBe(BREAKER_AGENT);
  });

  it("links when the payer owns the agent but the wallet is another address", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env, BREAKER, OTHER);
    await paidMessage(env, String(BREAKER_AGENT));
    expect(attemptAgent(env)).toBe(BREAKER_AGENT);
  });

  it("links nothing for someone else's agent, a garbage header or a missing agent, and the message still works", async () => {
    for (const header of [String(BREAKER_AGENT), "banana", "404", undefined]) {
      const env = makeEnv();
      seedContest(env);
      breakerAgent(env, OTHER);
      const res = await paidMessage(env, header);
      expect(res.status).toBe(200);
      expect(attemptAgent(env)).toBeNull();
      clearAgentLinkCache();
    }
  });

  it("never fails the message when the registry errors", async () => {
    const env = makeEnv();
    seedContest(env);
    env.chain.agentWallet = async () => {
      throw new Error("rpc down");
    };
    expect((await paidMessage(env, "9")).status).toBe(200);
    expect(attemptAgent(env)).toBeNull();
    expect(env.logs.some((l) => l.includes("failed: rpc down"))).toBe(true);
  });

  it("posts the bounty on the winner's agent with the payment proof", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await processNextDeposit(env.ctx);
    await breakContest(env);
    const settleTx = env.ctx.db.get<{ settle_tx: string }>("SELECT settle_tx FROM attempts WHERE contest_id = 1")!.settle_tx;
    expect(settleTx).toBeTruthy();

    await run(env);
    const calls = env.chain.callsOf("giveFeedback");
    expect(calls).toHaveLength(1);
    const f = calls[0]!.args[0] as { agentId: number; value: bigint; valueDecimals: number; tag1: string; tag2: string; feedbackURI: string };
    expect(f).toMatchObject({ agentId: BREAKER_AGENT, value: 1_035_000n, valueDecimals: 6, tag1: "defect.bounty", tag2: "demo:1" });
    const file = fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile;
    expect(file.proofOfPayment).toEqual({ fromAddress: BREAKER, toAddress: env.chain.operatorAddress.toLowerCase(), chainId: "296", txHash: settleTx });
    expect(file.defect).toMatchObject({ status: "broken", brokenInvariant: 1, breakTx: "0xbeef", finalPool: "1035000", logHash: null });
    expect(file).toMatchObject({ agentId: BREAKER_AGENT, value: 1_035_000, valueDecimals: 6, tag1: "defect.bounty" });
    expect(state(env)).toMatchObject({ winner_feedback_status: "posted", winner_agent_id: BREAKER_AGENT, winner_feedback_tx: env.chain.feedback[0]!.txHash });

    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(1);
  });

  describe("winner attempt selection", () => {
    const OTHER_AGENT = 10;
    type Row = { attempt_id: string; settle_tx: string | null };
    const rows = (env: TestEnv) => env.ctx.db.all<Row>("SELECT attempt_id, settle_tx FROM attempts WHERE contest_id = 1 ORDER BY started_at");
    const posted = (env: TestEnv) => env.chain.callsOf("giveFeedback")[0]!.args[0] as { agentId: number; feedbackURI: string };

    async function twoMessages(env: TestEnv, first: string | undefined, second: string | undefined): Promise<[Row, Row]> {
      await paidMessage(env, first);
      await paidMessage(env, second);
      env.ctx.db.run("UPDATE attempts SET started_at = 1000 WHERE attempt_id = ?", [rows(env)[0]!.attempt_id]);
      env.ctx.db.run("UPDATE attempts SET started_at = 2000 WHERE attempt_id = ?", [rows(env)[1]!.attempt_id]);
      const [a, b] = rows(env);
      expect(a!.settle_tx).toBeTruthy();
      expect(b!.settle_tx).toBeTruthy();
      expect(a!.settle_tx).not.toBe(b!.settle_tx);
      return [a!, b!];
    }

    it("an unlinked breaking attempt: agent from the older linked attempt, proof from the breaking attempt", async () => {
      const env = makeEnv();
      seedContest(env);
      breakerAgent(env);
      const [older, breaking] = await twoMessages(env, String(BREAKER_AGENT), undefined);
      env.ctx.db.run("UPDATE attempts SET broke = 1 WHERE attempt_id = ?", [breaking.attempt_id]);
      await breakContest(env);
      await run(env);
      const f = posted(env);
      expect(f.agentId).toBe(BREAKER_AGENT);
      const file = fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile;
      expect(file.proofOfPayment!.txHash).toBe(breaking.settle_tx);
      expect(file.proofOfPayment!.txHash).not.toBe(older.settle_tx);
      expect(state(env)).toMatchObject({ winner_feedback_status: "posted", winner_agent_id: BREAKER_AGENT });
    });

    it("a linked breaking attempt wins over a newer attempt linked to a different agent", async () => {
      const env = makeEnv();
      seedContest(env);
      breakerAgent(env);
      env.chain.agents.set(OTHER_AGENT, { owner: BREAKER, wallet: BREAKER, uri: "", operators: new Set() });
      const [breaking] = await twoMessages(env, String(BREAKER_AGENT), String(OTHER_AGENT));
      env.ctx.db.run("UPDATE attempts SET broke = 1 WHERE attempt_id = ?", [breaking.attempt_id]);
      await breakContest(env);
      await run(env);
      const f = posted(env);
      expect(f.agentId).toBe(BREAKER_AGENT);
      expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).proofOfPayment!.txHash).toBe(breaking.settle_tx);
      expect(state(env).winner_agent_id).toBe(BREAKER_AGENT);
    });

    it("with no breaking attempt (secret reveal), the newest linked attempt is used", async () => {
      const env = makeEnv();
      seedContest(env);
      breakerAgent(env);
      env.chain.agents.set(OTHER_AGENT, { owner: BREAKER, wallet: BREAKER, uri: "", operators: new Set() });
      const [, newest] = await twoMessages(env, String(BREAKER_AGENT), String(OTHER_AGENT));
      await breakContest(env);
      await run(env);
      const f = posted(env);
      expect(f.agentId).toBe(OTHER_AGENT);
      expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).proofOfPayment!.txHash).toBe(newest.settle_tx);
    });
  });

  it("lowercases both proofOfPayment addresses", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    const mixed = "0xAbCdEf0000000000000000000000000000000001";
    env.ctx.db.run("UPDATE attempts SET breaker = ?", [mixed]);
    await breakContest(env);
    env.ctx.db.run("UPDATE contests SET winner = ? WHERE contest_id = 1", [mixed]);
    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { feedbackURI: string };
    const proof = (fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).proofOfPayment!;
    expect(proof.fromAddress).toBe(mixed.toLowerCase());
    expect(proof.toAddress).toBe(env.chain.operatorAddress.toLowerCase());
    expect(proof.toAddress).toBe(proof.toAddress.toLowerCase());
  });

  it("leaves an active contest at none", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await run(env);
    expect(state(env)).toMatchObject({ status: "active", winner_feedback_status: "none" });
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
  });

  describe("link cache", () => {
    const MIXED = "0xAbCdEf0000000000000000000000000000000002" as Address;

    function counted(env: TestEnv) {
      const reads = { wallet: 0, owner: 0 };
      const wallet = env.chain.agentWallet.bind(env.chain);
      const owner = env.chain.agentOwner.bind(env.chain);
      env.chain.agentWallet = async (id: number) => (reads.wallet++, wallet(id));
      env.chain.agentOwner = async (id: number) => (reads.owner++, owner(id));
      return reads;
    }

    async function attemptId(env: TestEnv): Promise<string> {
      await paidMessage(env);
      return env.ctx.db.get<{ attempt_id: string }>("SELECT attempt_id FROM attempts WHERE contest_id = 1")!.attempt_id;
    }

    it("reads the registry once within 10 minutes, case-insensitively in the payer address, and again after the TTL", async () => {
      const env = makeEnv();
      seedContest(env);
      breakerAgent(env, MIXED);
      const id = await attemptId(env);
      const reads = counted(env);

      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, MIXED);
      expect(reads).toEqual({ wallet: 1, owner: 1 });
      expect(attemptAgent(env)).toBe(BREAKER_AGENT);

      env.ctx.db.run("UPDATE attempts SET agent_id = NULL");
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, MIXED);
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, MIXED.toLowerCase() as Address);
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, MIXED.toUpperCase().replace("0X", "0x") as Address);
      expect(reads).toEqual({ wallet: 1, owner: 1 });
      expect(attemptAgent(env)).toBe(BREAKER_AGENT); // the cached "ok" still links

      env.clock.now += 599;
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, MIXED);
      expect(reads).toEqual({ wallet: 1, owner: 1 });

      env.clock.now += 2;
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, MIXED);
      expect(reads).toEqual({ wallet: 2, owner: 2 });
    });

    it("caches a negative result too, but never caches a thrown read", async () => {
      const env = makeEnv();
      seedContest(env);
      breakerAgent(env, OTHER);
      const id = await attemptId(env);
      const reads = counted(env);

      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, BREAKER);
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, BREAKER);
      expect(reads.wallet).toBe(1);
      expect(attemptAgent(env)).toBeNull();

      // A failing read is logged and retried on the next call; once the registry recovers the link goes through.
      clearAgentLinkCache();
      env.chain.agentWallet = async () => {
        reads.wallet++;
        throw new Error("rpc down");
      };
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, BREAKER);
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, BREAKER);
      expect(reads.wallet).toBe(3);
      expect(env.logs.filter((l) => l.includes("failed: rpc down"))).toHaveLength(2);

      env.chain.agents.get(BREAKER_AGENT)!.owner = BREAKER;
      env.chain.agentWallet = async () => BREAKER;
      await linkAttemptAgent(env.ctx, id, BREAKER_AGENT, BREAKER);
      expect(attemptAgent(env)).toBe(BREAKER_AGENT);
    });
  });

  it("omits proofOfPayment when the winning attempt has no settlement", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    env.ctx.db.run("UPDATE attempts SET settle_tx = NULL");
    await breakContest(env);
    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { feedbackURI: string };
    expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).proofOfPayment).toBeUndefined();
    expect(state(env).winner_feedback_status).toBe("posted");
  });

  it("skips a broken contest whose winner has no linked attempt", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env); // no header
    await breakContest(env);
    await run(env);
    expect(state(env)).toMatchObject({ winner_feedback_status: "skipped", winner_agent_id: null });
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
  });

  it("skips a contest that was not broken", async () => {
    const env = makeEnv();
    seedContest(env);
    env.ctx.db.run("UPDATE contests SET status = 'held' WHERE contest_id = 1");
    await run(env);
    expect(state(env).winner_feedback_status).toBe("skipped");
  });

  it("waits for the Broken event, and does nothing when registries are not deployed", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await breakContest(env);
    const events = env.chain.events.get(1)!;
    env.chain.events.set(1, []);
    await run(env);
    expect(state(env).winner_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);

    env.chain.events.set(1, events);
    env.ctx.settings.erc8004 = null;
    await run(env);
    expect(state(env).winner_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
  });

  it("takes the bounty from the Broken event's payout, not the stored final pool", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await breakContest(env);
    env.ctx.db.run("UPDATE contests SET final_pool = '999' WHERE contest_id = 1");
    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { value: bigint; feedbackURI: string };
    expect(f.value).toBe(1_035_000n);
    const file = fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile;
    expect(file).toMatchObject({ value: 1_035_000, valueDecimals: 6 });
    expect(file.defect).toMatchObject({ finalPool: "1035000", breakTx: "0xbeef" });
  });

  it("waits while the winner has a pending attempt, then posts with the payment proof once it settles", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await breakContest(env);
    const settleTx = env.ctx.db.get<{ settle_tx: string }>("SELECT settle_tx FROM attempts WHERE contest_id = 1")!.settle_tx;
    env.ctx.db.run("UPDATE attempts SET outcome = 'pending', settle_tx = NULL");
    await run(env);
    expect(state(env).winner_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);

    env.ctx.db.run("UPDATE attempts SET outcome = 'charged', settle_tx = ?", [settleTx]);
    await run(env);
    const f = env.chain.callsOf("giveFeedback")[0]!.args[0] as { feedbackURI: string };
    expect((fromJsonDataUri(f.feedbackURI) as DefectFeedbackFile).proofOfPayment?.txHash).toBe(settleTx);
    expect(state(env).winner_feedback_status).toBe("posted");
  });

  it("posts no bounty while SITE_URL is unset", async () => {
    const env = makeEnv();
    env.ctx.settings.siteUrl = null;
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await breakContest(env);
    await run(env);
    expect(state(env).winner_feedback_status).toBe("none");
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
  });

  it("blocks when the winner's agent approved the operator, with no call", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    env.chain.agents.get(BREAKER_AGENT)!.operators.add(env.chain.operatorAddress);
    await breakContest(env);
    await run(env);
    expect(state(env)).toMatchObject({ winner_feedback_status: "blocked", winner_agent_id: BREAKER_AGENT });
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
  });

  it("recovers from a crash after the registry write: an existing bounty entry marks posted with its tx and no new call", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await breakContest(env);
    const tx = `0x${"e".repeat(64)}` as Hex;
    env.chain.feedback.push({ agentId: BREAKER_AGENT, tag1: "defect.bounty", tag2: "demo:1", value: 1n, valueDecimals: 6, feedbackURI: "data:application/json;base64,e30=", revoked: false, txHash: tx });
    await run(env);
    expect(env.chain.callsOf("giveFeedback")).toHaveLength(0);
    expect(state(env)).toMatchObject({ winner_feedback_status: "posted", winner_feedback_tx: tx });
  });

  it("stays none when giveFeedback throws and retries on the next run", async () => {
    const env = makeEnv();
    seedContest(env);
    breakerAgent(env);
    await paidMessage(env, String(BREAKER_AGENT));
    await breakContest(env);
    const give = env.chain.giveFeedback.bind(env.chain);
    env.chain.giveFeedback = async () => {
      throw new Error("rpc down");
    };
    await run(env);
    expect(state(env).winner_feedback_status).toBe("none");
    expect(env.logs.some((l) => l === "winner feedback 1 failed: rpc down")).toBe(true);
    env.chain.giveFeedback = give;
    await run(env);
    expect(state(env).winner_feedback_status).toBe("posted");
  });
});

describe("agent reads", () => {
  const HASH_A = `0x${"a".repeat(64)}` as Hex;
  const HASH_B = `0x${"b".repeat(64)}` as Hex;
  const TX_1 = `0x${"1".repeat(64)}` as Hex;
  const TX_2 = `0x${"2".repeat(64)}` as Hex;
  const REGISTRY = `eip155:296:${FAKE_IDENTITY_REGISTRY.toLowerCase()}`;

  function feedbackFile(packageHash: Hex): string {
    return toJsonDataUri({ defect: { packageHash } }).uri;
  }

  function seedAgent(env: TestEnv, uri?: string): void {
    const card = buildAgentCard({ name: "Treasury Bot", description: "Moves funds", siteUrl: "https://example.com" });
    env.chain.agents.set(AGENT_ID, { owner: WARDEN, wallet: WARDEN, uri: uri ?? toJsonDataUri(card).uri, operators: new Set() });
  }

  function addFeedback(env: TestEnv, f: { tag1: string; tag2: string; value?: bigint; valueDecimals?: number; packageHash?: Hex; feedbackURI?: string; revoked?: boolean; txHash?: Hex; timestamp?: number }): void {
    env.chain.feedback.push({
      agentId: AGENT_ID,
      tag1: f.tag1,
      tag2: f.tag2,
      value: f.value ?? 100n,
      valueDecimals: f.valueDecimals ?? 0,
      feedbackURI: f.feedbackURI ?? feedbackFile(f.packageHash ?? HASH_A),
      revoked: f.revoked ?? false,
      ...(f.txHash ? { txHash: f.txHash } : {}),
      ...(f.timestamp ? { timestamp: f.timestamp } : {}),
    });
  }

  it("shows the agent on a linked contest and null on an unlinked one", async () => {
    const env = makeEnv();
    seedContest(env);
    const unlinked = await json<ContestDetail>(await env.app.request("/contests/1"));
    expect(unlinked.agent).toBeNull();
    expect(unlinked.winnerAgent).toBeNull();

    env.ctx.db.run("UPDATE contests SET agent_id = ?, agent_feedback_status = 'posted', agent_feedback_tx = ? WHERE contest_id = 1", [AGENT_ID, TX_1]);
    const linked = await json<ContestDetail>(await env.app.request("/contests/1"));
    expect(linked.agent).toEqual({ agentId: AGENT_ID, registry: REGISTRY, feedback: "posted", feedbackTx: TX_1 });
    expect(linked.winnerAgent).toBeNull();
  });

  it("shows the winner's agent, and hides the agent when registries are not configured", async () => {
    const env = makeEnv();
    seedContest(env);
    env.ctx.db.run(
      "UPDATE contests SET agent_id = ?, winner_agent_id = 9, winner_feedback_status = 'posted', winner_feedback_tx = ? WHERE contest_id = 1",
      [AGENT_ID, TX_2],
    );
    const d = await json<ContestDetail>(await env.app.request("/contests/1"));
    expect(d.winnerAgent).toEqual({ agentId: 9, feedback: "posted", feedbackTx: TX_2 });
    expect(d.agent).toMatchObject({ agentId: AGENT_ID, feedback: "none", feedbackTx: null });

    env.ctx.settings.erc8004 = null;
    const off = await json<ContestDetail>(await env.app.request("/contests/1"));
    expect(off.agent).toBeNull();
  });

  it("returns the decoded card and the record across deployments with counts", async () => {
    const env = makeEnv();
    seedAgent(env);
    addFeedback(env, { tag1: "defect.held", tag2: "prod:3", packageHash: HASH_A, txHash: TX_1, timestamp: NOW });
    addFeedback(env, { tag1: "defect.broken", tag2: "demo:5", value: 0n, packageHash: HASH_B, txHash: TX_2, timestamp: NOW + 5 });
    const res = await env.app.request(`/agents/${AGENT_ID}`);
    expect(res.status).toBe(200);
    const p = await json<AgentProfile>(res);
    expect(p).toMatchObject({ agentId: AGENT_ID, registry: REGISTRY, owner: WARDEN, counts: { held: 1, broken: 1, bounties: 0 } });
    expect(p.card).toMatchObject({ name: "Treasury Bot", description: "Moves funds" });
    expect(p.cardUri).toBe(env.chain.agents.get(AGENT_ID)!.uri);
    expect(p.record).toEqual([
      // inference: only for this gateway's deployment (demo) and only when the contest is in its database (it is not here)
      { tag1: "defect.held", deployment: "prod", contestId: 3, value: "100", packageHash: HASH_A, inference: null, txHash: TX_1, timestamp: NOW },
      { tag1: "defect.broken", deployment: "demo", contestId: 5, value: "0", packageHash: HASH_B, inference: null, txHash: TX_2, timestamp: NOW + 5 },
    ]);
  });

  it("formats bounty values as USDC, counts bounties, and gives a null packageHash for an unreadable file", async () => {
    const env = makeEnv();
    seedAgent(env);
    addFeedback(env, { tag1: "defect.bounty", tag2: "demo:2", value: 1_035_000n, valueDecimals: 6, feedbackURI: "https://example.com/not-decoded.json" });
    const p = await json<AgentProfile>(await env.app.request(`/agents/${AGENT_ID}`));
    expect(p.record).toHaveLength(1);
    expect(p.record[0]).toMatchObject({ tag1: "defect.bounty", value: "1.035", packageHash: null });
    expect(p.counts).toEqual({ held: 0, broken: 0, bounties: 1 });
  });

  it("leaves out revoked entries, foreign tags and unparseable tag2 values", async () => {
    const env = makeEnv();
    seedAgent(env);
    addFeedback(env, { tag1: "defect.held", tag2: "prod:3" });
    addFeedback(env, { tag1: "defect.broken", tag2: "demo:5", value: 0n, revoked: true });
    addFeedback(env, { tag1: "other.tag", tag2: "demo:6" });
    addFeedback(env, { tag1: "defect.held", tag2: "garbage" });
    const p = await json<AgentProfile>(await env.app.request(`/agents/${AGENT_ID}`));
    expect(p.record.map((r) => `${r.tag1}/${r.deployment}:${r.contestId}`)).toEqual(["defect.held/prod:3"]);
    expect(p.counts).toEqual({ held: 1, broken: 0, bounties: 0 });
  });

  it("gives card null for an undecodable data URI", async () => {
    const env = makeEnv();
    seedAgent(env, "data:application/json;base64,bm90IGpzb24=");
    const p = await json<AgentProfile>(await env.app.request(`/agents/${AGENT_ID}`));
    expect(p.card).toBeNull();
    expect(p.record).toEqual([]);
  });

  it("reads an https: card with the injected fetch", async () => {
    const env = makeEnv();
    seedAgent(env, "https://example.com/card.json");
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ name: "Remote" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const p = await agentProfile(env.ctx, AGENT_ID, fetchFn);
    expect(calls).toEqual(["https://example.com/card.json"]);
    expect(p.card).toMatchObject({ name: "Remote" });
  });

  describe("card hardening", () => {
    const json = (body: string, headers: Record<string, string> = { "Content-Type": "application/json" }) => new Response(body, { status: 200, headers });

    function spyFetch(make: () => Response) {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return make();
      }) as typeof fetch;
      return { calls, fetchFn };
    }

    it.each(["https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/x", "https://2130706433/x", "https://localhost/x", "https://foo.localhost/x", "https://db.internal/x", "https://printer.local/x", "http://example.com/x"])(
      "never fetches %s",
      async (uri) => {
        const env = makeEnv();
        seedAgent(env, uri);
        const { calls, fetchFn } = spyFetch(() => json('{"name":"x"}'));
        const p = await agentProfile(env.ctx, AGENT_ID, fetchFn);
        expect(calls).toHaveLength(0);
        expect(p.card).toBeNull();
      },
    );

    it("refuses redirects", async () => {
      const env = makeEnv();
      seedAgent(env, "https://example.com/card.json");
      const { calls, fetchFn } = spyFetch(() => json('{"name":"x"}'));
      await agentProfile(env.ctx, AGENT_ID, fetchFn);
      expect(calls[0]!.init).toMatchObject({ redirect: "error" });
      expect(calls[0]!.init!.signal).toBeDefined();
    });

    it("gives card null for an oversized body, by content-length or by streamed size", async () => {
      const env = makeEnv();
      seedAgent(env, "https://example.com/card.json");
      const big = JSON.stringify({ name: "x", description: "y".repeat(70 * 1024) });
      expect((await agentProfile(env.ctx, AGENT_ID, spyFetch(() => json(big)).fetchFn)).card).toBeNull();
      const lying = () => json('{"name":"x"}', { "Content-Type": "application/json", "Content-Length": String(70 * 1024) });
      expect((await agentProfile(env.ctx, AGENT_ID, spyFetch(lying).fetchFn)).card).toBeNull();
    });

    it("gives card null for a non-JSON content type", async () => {
      const env = makeEnv();
      seedAgent(env, "https://example.com/card.json");
      const p = await agentProfile(env.ctx, AGENT_ID, spyFetch(() => json('{"name":"x"}', { "Content-Type": "text/html" })).fetchFn);
      expect(p.card).toBeNull();
    });
  });

  describe("card sanitizing", () => {
    async function cardOf(env: TestEnv, raw: unknown) {
      seedAgent(env, toJsonDataUri(raw).uri);
      return (await json<AgentProfile>(await env.app.request(`/agents/${AGENT_ID}`))).card;
    }

    it("drops unknown fields and keeps the known ones", async () => {
      const env = makeEnv();
      const card = await cardOf(env, {
        ...buildAgentCard({ name: "Bot", description: "d", siteUrl: "https://example.com", x402Support: true, registration: { agentId: 7, agentRegistry: REGISTRY } }),
        image: "ipfs://bafy/img.png",
        evil: "<script>",
        services: [{ name: "web", endpoint: "https://example.com", extra: 1 }, { name: 5 }, "nope"],
      });
      expect(card).toEqual({
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: "Bot",
        description: "d",
        image: "ipfs://bafy/img.png",
        services: [{ name: "web", endpoint: "https://example.com" }],
        x402Support: true,
        active: true,
        registrations: [{ agentId: 7, agentRegistry: REGISTRY }],
        supportedTrust: ["reputation"],
      });
      expect(card).not.toHaveProperty("evil");
    });

    it("truncates an oversized description and caps list sizes", async () => {
      const env = makeEnv();
      const card = await cardOf(env, {
        name: "n".repeat(500),
        description: "d".repeat(5000),
        services: Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, endpoint: "https://e.example" })),
        supportedTrust: Array.from({ length: 30 }, () => "t".repeat(100)),
      });
      expect(card!.name).toHaveLength(100);
      expect(card!.description).toHaveLength(1000);
      expect(card!.services).toHaveLength(10);
      expect(card!.supportedTrust).toHaveLength(10);
      expect(card!.supportedTrust![0]).toHaveLength(40);
    });

    it("drops image URLs that are not https or ipfs", async () => {
      const env = makeEnv();
      expect(await cardOf(env, { name: "a", image: "javascript:alert(1)" })).not.toHaveProperty("image");
      expect(await cardOf(env, { name: "a", image: "data:image/svg+xml;base64,AAAA" })).not.toHaveProperty("image");
      expect(await cardOf(env, { name: "a", image: "https://example.com/i.png" })).toHaveProperty("image", "https://example.com/i.png");
    });

    it("gives card null when the name is missing or not a string", async () => {
      const env = makeEnv();
      expect(await cardOf(env, { description: "no name" })).toBeNull();
      expect(await cardOf(env, { name: 42 })).toBeNull();
    });

    it("sanitizes https cards too", async () => {
      const env = makeEnv();
      seedAgent(env, "https://example.com/card.json");
      const res = new Response(JSON.stringify({ name: "R", image: "javascript:alert(1)", evil: 1 }), { headers: { "Content-Type": "application/json" } });
      const p = await agentProfile(env.ctx, AGENT_ID, (async () => res) as typeof fetch);
      expect(p.card).not.toHaveProperty("image");
      expect(p.card).not.toHaveProperty("evil");
    });
  });

  it("answers card null within the timeout when an https: card fetch hangs (Review Focus 5)", async () => {
    const env = makeEnv();
    seedAgent(env, "https://example.com/hang.json");
    const fetchFn = (() => new Promise<Response>(() => {})) as typeof fetch;
    const t0 = Date.now();
    const p = await agentProfile(env.ctx, AGENT_ID, fetchFn);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(p.card).toBeNull();
    expect(p.agentId).toBe(AGENT_ID);
  }, 8000);

  it("gives card null when an https: card is not JSON, errors, or the URI is another scheme", async () => {
    const env = makeEnv();
    seedAgent(env, "https://example.com/page.html");
    expect((await agentProfile(env.ctx, AGENT_ID, (async () => new Response("<html>", { status: 200 })) as typeof fetch)).card).toBeNull();
    expect((await agentProfile(env.ctx, AGENT_ID, (async () => new Response("{}", { status: 500 })) as typeof fetch)).card).toBeNull();
    expect((await agentProfile(env.ctx, AGENT_ID, (async () => { throw new Error("dns"); }) as typeof fetch)).card).toBeNull();
    seedAgent(env, "ipfs://bafy/card.json");
    let called = false;
    const p = await agentProfile(env.ctx, AGENT_ID, (async () => { called = true; return new Response("{}"); }) as typeof fetch);
    expect(p.card).toBeNull();
    expect(called).toBe(false);
  });

  it("answers 404 AGENT_NOT_FOUND for an unknown agent and 400 for a malformed id", async () => {
    const env = makeEnv();
    const missing = await env.app.request("/agents/999");
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("AGENT_NOT_FOUND");
    const bad = await env.app.request("/agents/x1");
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("INVALID_AGENT_ID");
    expect((await env.app.request("/agents/1234567890123456")).status).toBe(400);
  });

  it("answers 404 when registries are not configured (Review Focus 2)", async () => {
    const env = makeEnv();
    seedAgent(env);
    env.ctx.settings.erc8004 = null;
    const res = await env.app.request(`/agents/${AGENT_ID}`);
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("AGENT_NOT_FOUND");
  });
});
