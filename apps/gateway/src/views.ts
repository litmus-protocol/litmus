import {
  fromBaseUnits,
  hashscanTx,
  type AgentCard,
  type AgentPackage,
  type AttemptView,
  type CanaryRoundView,
  type CanaryTask,
  type ContestDetail,
  type ContestPhase,
  type ContestSummary,
  type Invariant,
  type MessageResult,
  type OgEvidence,
  type PublicInvariant,
  type ToolCallView,
} from "@defect/shared";
import type { AttemptRow, CanaryRoundRow, ContestRow } from "./db";
import { isEnded, type ContestState } from "./context";
import type { OnchainInvariant } from "./chain";

// DB rows + on-chain state → the API shapes in packages/shared/src/api.ts (§10.3).

const ZERO = "0x0000000000000000000000000000000000000000";

function j<T>(s: string | null, fallback: T): T {
  return s ? (JSON.parse(s) as T) : fallback;
}

/** Ended contests have pool zeroed on chain; show the final pool recorded at the end. */
function displayPool(row: ContestRow, s: ContestState): string {
  if (isEnded(s.phase)) return fromBaseUnits(BigInt(row.final_pool ?? row.last_pool ?? s.initialPool.toString()));
  return fromBaseUnits(s.pool);
}

function winner(s: ContestState): `0x${string}` | null {
  return s.phase === "broken" && s.winner !== ZERO ? s.winner : null;
}

export function contestSummary(row: ContestRow, s: ContestState): ContestSummary {
  const invariants = j<Invariant[]>(row.invariants_json, []);
  const broken = s.phase === "broken" ? s.brokenInvariant : null;
  return {
    contestId: row.contest_id,
    card: j<AgentCard>(row.card_json, { name: "", purpose: "" }),
    phase: s.phase,
    startTime: row.start_time,
    endTime: row.end_time,
    messagePrice: fromBaseUnits(BigInt(row.message_price)),
    pool: displayPool(row, s),
    messageCount: s.messageCount,
    ruleCount: invariants.length,
    winner: winner(s),
    brokenInvariant: broken,
    brokenRuleText: broken !== null ? (invariants[broken]?.text ?? null) : null,
  };
}

export function contestDetail(
  row: ContestRow,
  s: ContestState,
  onchainInvariants: OnchainInvariant[],
  stats: { attempts: number; breakers: number; ogRequests: number },
  rounds: CanaryRoundRow[],
): ContestDetail {
  const invariants = j<Invariant[]>(row.invariants_json, []);
  const pkg = j<AgentPackage>(row.package_json, { model: "", systemPrompt: "", tools: [], temperature: 0 });
  const pub: PublicInvariant[] = invariants.map((inv, i) => {
    if (inv.type === "secret") return { id: inv.id, text: inv.text, type: "secret", secretHash: onchainInvariants[i]?.secretHash ?? "0x" };
    if (inv.type === "transfer_limit") return { id: inv.id, text: inv.text, type: "transfer_limit", maxAmount: inv.maxAmount };
    return { id: inv.id, text: inv.text, type: "forbidden_tool", tool: "emergency_withdraw" };
  });
  const last = rounds.at(-1) ?? null;
  const ended = isEnded(s.phase);
  const summary = contestSummary(row, s);
  return {
    contestId: summary.contestId,
    card: summary.card,
    phase: summary.phase,
    startTime: summary.startTime,
    endTime: summary.endTime,
    messagePrice: summary.messagePrice,
    pool: summary.pool,
    messageCount: summary.messageCount,
    winner: summary.winner,
    brokenInvariant: summary.brokenInvariant,
    warden: row.warden as `0x${string}`,
    endedAt: row.ended_at,
    vault: fromBaseUnits(s.vault),
    bond: fromBaseUnits(s.bond),
    escrow: fromBaseUnits(s.escrow),
    invariants: pub,
    tools: pkg.tools,
    model: pkg.model,
    packageHash: s.packageHash,
    canaryHash: s.canaryHash,
    stats,
    canary: {
      rounds: rounds.length,
      consecutiveFailed: row.consecutive_failed_rounds,
      lastRoundAt: last?.started_at ?? null,
      lastRoundPassed: last ? last.passed === 1 : null,
    },
    revealed:
      ended && row.secrets_json !== null
        ? {
            package: pkg,
            canaries: j<CanaryTask[]>(row.canaries_json, []),
            secrets: j<Record<string, string>>(row.secrets_json, {}),
            logHash: (row.log_hash as `0x${string}` | null) ?? null,
          }
        : null,
  };
}

export function messageResult(a: AttemptRow, contestBroken: boolean): MessageResult {
  return {
    attemptId: a.attempt_id,
    reply: a.reply ?? "",
    toolCalls: j<ToolCallView[]>(a.tool_calls_json, []),
    charged: a.outcome === "charged",
    latencyMs: a.latency_ms ?? 0,
    settlement: a.settle_tx ? { txId: a.settle_tx, hashscan: hashscanTx(a.settle_tx) } : null,
    og: j<OgEvidence[]>(a.og_json, []),
    contestBroken,
  };
}

export function attemptView(a: AttemptRow): AttemptView {
  return {
    ...messageResult(a, a.broke === 1),
    contestId: a.contest_id,
    breaker: a.breaker as `0x${string}`,
    text: a.text,
    startedAt: a.started_at,
    outcome: a.outcome,
  };
}

export function canaryRoundView(r: CanaryRoundRow, ended: boolean): CanaryRoundView {
  return {
    round: r.round,
    startedAt: r.started_at,
    failures: r.failures,
    passed: r.passed === 1,
    action: r.action,
    results: ended ? j<{ taskId: string; passed: boolean }[]>(r.results_json, []).map((x) => ({ taskId: x.taskId, passed: x.passed })) : null,
  };
}

export function phaseOf(s: ContestState): ContestPhase {
  return s.phase;
}
