import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { PHASE, type ArenaChain, type OnchainContest, type OnchainInvariant, type VaultWriteResult } from "../src/chain";
import type { ChatRequest, ChatResponse, ModelClient, ToolCall } from "../src/llm";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "defect-runner-"));
}

export const BREAKER = "0x1111111111111111111111111111111111111111" as Address;
export const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;

/** In-memory ArenaChain that records every write. */
export class FakeChain implements ArenaChain {
  runnerAddress = "0x9999999999999999999999999999999999999999" as Address;
  phaseValue: number = PHASE.Open;
  contest: OnchainContest = {
    status: 1,
    startTime: 0n,
    endTime: 10n ** 12n,
    vault: 50_000_000n,
    packageHash: "0x" as Hex,
    canaryHash: "0x" as Hex,
  };
  invariants: OnchainInvariant[] = [];
  writes: { fn: string; args: unknown }[] = [];
  nextResult: VaultWriteResult = { kind: "mined", txHash: `0x${"ab".repeat(32)}`, transferred: true, amount: 0n, broke: false };
  writeDelayMs = 0;

  async phase(): Promise<number> {
    return this.phaseValue;
  }
  async getContest(): Promise<OnchainContest> {
    return this.contest;
  }
  async getInvariants(): Promise<OnchainInvariant[]> {
    return this.invariants;
  }
  async vaultSend(args: unknown): Promise<VaultWriteResult> {
    this.writes.push({ fn: "vaultSend", args });
    if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
    return this.nextResult;
  }
  async vaultEmergencyWithdraw(args: unknown): Promise<VaultWriteResult> {
    this.writes.push({ fn: "vaultEmergencyWithdraw", args });
    return this.nextResult;
  }
}

export function toolCall(name: string, args: unknown, id = `call_${name}`): ToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

type Step = Partial<ChatResponse> | ((req: ChatRequest, signal: AbortSignal) => Promise<ChatResponse>);

/** Model that replays a script of responses and records the requests it saw. */
export class ScriptedModel implements ModelClient {
  requests: ChatRequest[] = [];
  constructor(private readonly steps: Step[]) {}

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift() ?? { content: "(script exhausted)" };
    if (typeof step === "function") return step(req, signal);
    return { content: step.content ?? null, toolCalls: step.toolCalls ?? [], og: step.og ?? null };
  }
}

/** A model call that only ends when its abort signal fires. */
export function hangUntilAbort(_req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
}
