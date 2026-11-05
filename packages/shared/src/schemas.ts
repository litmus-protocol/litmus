import { z } from "zod";
import { MAX_CANARIES, MAX_INVARIANTS, MIN_BOND_PERCENT, MIN_CANARIES, MIN_MESSAGE_PRICE, TOOL_NAMES } from "./constants";
import { isDecimalString, toBaseUnits } from "./units";

// Schemas for the Warden submission (build plan §7).

const decimal = z.string().refine(isDecimalString, "Use a plain decimal like 10 or 0.05 (max 6 decimals)");
const positiveDecimal = decimal.refine((v) => !isDecimalString(v) || toBaseUnits(v) > 0n, "Must be greater than 0");

export const ToolNameSchema = z.enum(TOOL_NAMES);

export const AgentCardSchema = z.object({
  name: z.string().trim().min(1).max(40),
  purpose: z.string().trim().min(1).max(280),
});

export const AgentPackageSchema = z.object({
  model: z.string().min(1),
  systemPrompt: z.string().min(1).max(8000),
  tools: z.array(ToolNameSchema).min(1),
  temperature: z.number().min(0).max(1),
});

const invariantId = z.string().regex(/^inv-[1-9][0-9]?$/, "Use ids like inv-1");
const invariantText = z.string().trim().min(1).max(200);

export const InvariantSchema = z.discriminatedUnion("type", [
  z.object({ id: invariantId, text: invariantText, type: z.literal("secret") }),
  z.object({ id: invariantId, text: invariantText, type: z.literal("transfer_limit"), maxAmount: positiveDecimal }),
  z.object({ id: invariantId, text: invariantText, type: z.literal("forbidden_tool"), tool: z.literal("emergency_withdraw") }),
]);

export const CanaryTaskSchema = z.object({
  id: z.string().regex(/^can-[1-9][0-9]?$/, "Use ids like can-1"),
  prompt: z.string().trim().min(1).max(1000),
  mustContain: z.array(z.string().min(1)).optional(),
  expectTool: ToolNameSchema.optional(),
});

export const WardenSubmissionSchema = z.object({
  card: AgentCardSchema,
  package: AgentPackageSchema,
  invariants: z.array(InvariantSchema).min(1).max(MAX_INVARIANTS),
  canaries: z.array(CanaryTaskSchema).min(MIN_CANARIES).max(MAX_CANARIES),
  vaultFunding: positiveDecimal,
  pool: positiveDecimal,
  bond: decimal,
  startTime: z.number().int(),
  messagePrice: decimal,
});

export type AgentCard = z.infer<typeof AgentCardSchema>;
export type AgentPackage = z.infer<typeof AgentPackageSchema>;
export type Invariant = z.infer<typeof InvariantSchema>;
export type CanaryTask = z.infer<typeof CanaryTaskSchema>;
export type WardenSubmission = z.infer<typeof WardenSubmissionSchema>;

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Schema checks plus the cross-field rules of §7.2–§7.5. Returns [] when valid. */
export function validateSubmission(
  input: unknown,
  opts: { allowedModels: string[]; now: number },
): ValidationIssue[] {
  const parsed = WardenSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  }
  const s = parsed.data;
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (!opts.allowedModels.includes(s.package.model)) add("package.model", `Model must be one of: ${opts.allowedModels.join(", ")}`);
  if (new Set(s.package.tools).size !== s.package.tools.length) add("package.tools", "Each tool may be listed once");

  const ids = s.invariants.map((i) => i.id);
  if (new Set(ids).size !== ids.length) add("invariants", "Rule ids must be unique");
  if (s.invariants.filter((i) => i.type === "forbidden_tool").length > 1) add("invariants", "Only one forbidden-tool rule is allowed");
  if (s.invariants.some((i) => i.type === "transfer_limit") && !s.package.tools.includes("vault_send")) {
    add("package.tools", "A transfer limit rule needs the Send money tool");
  }
  if (s.invariants.some((i) => i.type === "forbidden_tool") && !s.package.tools.includes("emergency_withdraw")) {
    add("package.tools", "A forbidden-tool rule needs the Emergency withdraw tool");
  }

  const placeholders = [...s.package.systemPrompt.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1]!);
  const secretIds = s.invariants.filter((i) => i.type === "secret").map((i) => i.id);
  for (const id of secretIds) {
    const count = placeholders.filter((p) => p === `SECRET:${id}`).length;
    if (count !== 1) add("package.systemPrompt", `Instructions must contain {{SECRET:${id}}} exactly once`);
  }
  for (const p of placeholders) {
    const m = /^SECRET:(inv-[1-9][0-9]?)$/.exec(p);
    if (!m || !secretIds.includes(m[1]!)) add("package.systemPrompt", `Unknown placeholder {{${p}}}`);
  }

  const canaryIds = s.canaries.map((c) => c.id);
  if (new Set(canaryIds).size !== canaryIds.length) add("canaries", "Health check ids must be unique");
  s.canaries.forEach((c, i) => {
    if (!c.mustContain?.length && !c.expectTool) add(`canaries.${i}`, "Add a 'must contain' text or an expected tool");
    if (c.expectTool && !s.package.tools.includes(c.expectTool)) add(`canaries.${i}.expectTool`, "Expected tool must be one the agent can use");
  });

  if (toBaseUnits(s.bond) * 100n < toBaseUnits(s.pool) * BigInt(MIN_BOND_PERCENT)) {
    add("bond", `Bond must be at least ${MIN_BOND_PERCENT}% of the prize pool`);
  }
  if (toBaseUnits(s.messagePrice) < toBaseUnits(MIN_MESSAGE_PRICE)) add("messagePrice", `Minimum price is ${MIN_MESSAGE_PRICE} USDC`);
  if (s.startTime < opts.now + 60) add("startTime", "Start at least 1 minute from now");
  if (s.startTime > opts.now + 7 * 86_400) add("startTime", "Start within 7 days");

  return issues;
}
