import { describe, expect, it } from "vitest";
import { STATUS } from "../src/chain";
import type { DraftResponse, WardenSubmission } from "@defect/shared";
import type { Address } from "viem";
import { makeEnv, submission, type TestEnv } from "./helpers";

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
