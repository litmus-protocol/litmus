import OpenAI from "openai";
import type { OgEvidence } from "@defect/shared";

/** OpenAI-style chat message, the subset the agent loop uses. */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  /** Present only when the call went through the 0G Router and it returned x_0g_trace. */
  og: OgEvidence | null;
}

export interface ModelClient {
  chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}

interface ZeroGTrace {
  request_id?: string;
  provider?: string;
  billing?: { total_cost?: string };
  tee_verified?: boolean | null;
}

/** Reads 0G's per-call evidence; returns null for non-0G endpoints (e.g. a local Ollama model). */
export function parseOgTrace(raw: unknown): OgEvidence | null {
  const trace = (raw as { x_0g_trace?: ZeroGTrace } | null)?.x_0g_trace;
  if (!trace || typeof trace.request_id !== "string") return null;
  return {
    requestId: trace.request_id,
    provider: trace.provider ?? "",
    totalCost: trace.billing?.total_cost ?? "0",
    teeVerified: typeof trace.tee_verified === "boolean" ? trace.tee_verified : null,
  };
}

/**
 * The 0G Compute Router is OpenAI-compatible (build plan §9.4). Any OpenAI-compatible endpoint works here,
 * which is how the runner is developed against a local model before a 0G key exists.
 */
export class OpenAiCompatibleClient implements ModelClient {
  private readonly client: OpenAI;

  constructor(
    baseURL: string,
    apiKey: string,
    private readonly opts: { zeroGExtras: boolean } = { zeroGExtras: true },
  ) {
    this.client = new OpenAI({ baseURL, apiKey, maxRetries: 0 });
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
    };
    if (req.tools.length > 0) body.tools = req.tools;
    if (this.opts.zeroGExtras) body.verify_tee = true;
    const res = await this.client.chat.completions.create(body as never, {
      signal,
      headers: this.opts.zeroGExtras ? { "X-0G-Provider-Sort": "latency" } : undefined,
    });
    const choice = (res as unknown as { choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[] }).choices[0];
    const message = choice?.message ?? { content: null };
    return {
      content: message.content ?? null,
      // reasoning_content (thinking models) is deliberately ignored.
      toolCalls: (message.tool_calls ?? []).filter((t) => t.type === "function"),
      og: parseOgTrace(res),
    };
  }
}

/** 0G-only request extras (verify_tee, routing header) go only to 0G Router hosts. */
export function isZeroGEndpoint(url: string): boolean {
  return /0g\.ai|integratenetwork\.work/.test(url);
}

/** HTTP status of an OpenAI SDK error, if any. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * 0G first; the fallback (non-0G) model is used only after 0G answers 402, 429 or 503 (build plan §9.4).
 * Fallback calls carry no og evidence.
 */
export class FallbackClient implements ModelClient {
  constructor(
    private readonly primary: ModelClient,
    private readonly fallback: ModelClient,
    private readonly fallbackModel: string,
  ) {}

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
    try {
      return await this.primary.chat(req, signal);
    } catch (err) {
      const status = statusOf(err);
      if (status !== 402 && status !== 429 && status !== 503) throw err;
      const res = await this.fallback.chat({ ...req, model: this.fallbackModel }, signal);
      return { ...res, og: null };
    }
  }
}
