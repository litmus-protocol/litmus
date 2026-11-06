import {
  MAX_HISTORY_MESSAGES,
  MAX_MODEL_CALLS_PER_RUN,
  RUN_MODEL_BUDGET_MS,
  type AgentPackage,
  type RunRequest,
  type RunResult,
  type ToolCallView,
  type ToolName,
} from "@defect/shared";
import type { Address } from "viem";
import type { ArenaChain } from "./chain";
import type { ChatMessage, ModelClient } from "./llm";
import type { SecretMap } from "./secret-store";
import type { HistoryStore } from "./stores";
import { TOOL_DEFINITIONS, executeTool } from "./tools";

/** Replaces every {{SECRET:<id>}} with that invariant's secret (build plan §9.4 step 3). Nothing else is added. */
export function injectSecrets(systemPrompt: string, secrets: SecretMap): string {
  return systemPrompt.replace(/\{\{SECRET:([^}]+)\}\}/g, (match, id: string) => {
    const s = secrets[id];
    if (!s) throw new Error(`No secret for placeholder ${match}`);
    return s;
  });
}

export interface AgentDeps {
  model: ModelClient;
  chain: ArenaChain;
  history: HistoryStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test-only delay at the start of a run; counts against the model budget (§9.1). */
  runDelayMs?: number;
  /** Overridable for tests. */
  budgetMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The agent loop for one message (build plan §9.4). */
export async function runAgent(req: RunRequest, pkg: AgentPackage, secrets: SecretMap, deps: AgentDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const deadline = start + (deps.budgetMs ?? RUN_MODEL_BUDGET_MS);
  if (deps.runDelayMs) await (deps.sleep ?? defaultSleep)(deps.runDelayMs);

  const messages: ChatMessage[] = [
    { role: "system", content: injectSecrets(pkg.systemPrompt, secrets) },
    ...req.history.slice(-MAX_HISTORY_MESSAGES).map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
    { role: "user", content: req.text },
  ];
  const tools = pkg.tools.map((t) => TOOL_DEFINITIONS[t]);

  const toolCalls: ToolCallView[] = [];
  const og: RunResult["og"] = [];
  let modelCalls = 0;
  let reply = "";
  let lastNonEmpty = "";
  let finished = false;
  let aborted = false;

  while (modelCalls < MAX_MODEL_CALLS_PER_RUN) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      aborted = true;
      break;
    }
    modelCalls++;
    let res;
    try {
      res = await deps.model.chat(
        { model: pkg.model, messages, tools, temperature: pkg.temperature, providerAddress: pkg.providerAddress },
        AbortSignal.timeout(remaining),
      );
    } catch (e) {
      if (isAbort(e) || now() >= deadline) {
        aborted = true;
        break;
      }
      throw e;
    }
    if (res.og) og.push(res.og);
    if (res.content && res.content.trim() !== "") lastNonEmpty = res.content;

    if (res.toolCalls.length === 0) {
      reply = res.content ?? "";
      finished = true;
      break;
    }

    messages.push({ role: "assistant", content: res.content ?? null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      // After the budget runs out, no further tool call is started; started ones always finish (§9.4 step 6).
      if (now() >= deadline) {
        aborted = true;
        break;
      }
      const exec = await executeTool(call.function.name, call.function.arguments, {
        contestId: req.contestId,
        attemptId: req.attemptId,
        mode: req.mode,
        breaker: (req.breaker as Address | null) ?? null,
        allowedTools: pkg.tools,
        chain: deps.chain,
        history: deps.history,
      });
      toolCalls.push({
        name: call.function.name as ToolName,
        args: exec.args,
        result: exec.result,
        txHash: exec.txHash,
        broke: exec.broke,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(exec.result) });
    }
    if (aborted) break;
  }

  if (aborted) reply = "";
  else if (!finished) reply = lastNonEmpty;

  return {
    reply,
    toolCalls,
    broke: toolCalls.some((t) => t.broke),
    og,
    modelCalls,
    durationMs: now() - start,
  };
}

function isAbort(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError" || name === "APIUserAbortError";
}
