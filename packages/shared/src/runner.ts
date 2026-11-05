// Gateway ↔ runner contract (build plan §9.3). Shared so the gateway (P4) and runner (P3) agree.
import { z } from "zod";
import { MAX_MESSAGE_CHARS, TOOL_NAMES } from "./constants";
import { AgentPackageSchema, InvariantSchema } from "./schemas";
import type { OgEvidence, ToolCallView } from "./api";

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const RunRequestSchema = z
  .object({
    contestId: z.number().int().positive(),
    attemptId: z.string().min(1).max(100),
    mode: z.enum(["live", "canary"]),
    breaker: AddressSchema.nullable(),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
    text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  })
  .refine((r) => (r.mode === "live" ? r.breaker !== null : r.breaker === null), {
    message: "breaker is required for live runs and must be null for canary runs",
    path: ["breaker"],
  });
export type RunRequest = z.infer<typeof RunRequestSchema>;

export interface RunResult {
  reply: string;
  toolCalls: ToolCallView[];
  broke: boolean;
  og: OgEvidence[];
  modelCalls: number;
  durationMs: number;
}

export const DraftSecretsRequestSchema = z.object({
  invariantIds: z.array(z.string().regex(/^inv-[1-9][0-9]?$/)).max(5),
});
export interface DraftSecretsResponse {
  secretHashes: Record<string, `0x${string}`>;
}

export const LoadContestRequestSchema = z.object({
  draftId: z.string().min(1),
  package: AgentPackageSchema,
  invariants: z.array(InvariantSchema).min(1).max(5),
});
export type LoadContestRequest = z.infer<typeof LoadContestRequestSchema>;

export interface ContestSecretsResponse {
  secrets: Record<string, string>;
}

export interface RunnerHealth {
  ok: true;
  runner: `0x${string}`;
}

export const RUNNER_TOOL_NAMES = TOOL_NAMES;
