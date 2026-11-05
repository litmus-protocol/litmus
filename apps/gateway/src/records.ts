import { canonicalJson } from "@defect/shared";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AttemptRow, CanaryRoundRow } from "./db";

// Signed records and the published log (build plan §10.8).

export interface Signer {
  sign(hash: Hex): Promise<Hex>;
}

export function operatorSigner(privateKey: Hex): Signer {
  const account = privateKeyToAccount(privateKey);
  return { sign: (hash) => account.signMessage({ message: { raw: hash } }) };
}

function parse<T>(json: string | null, fallback: T): T {
  return json ? (JSON.parse(json) as T) : fallback;
}

export function attemptRecord(a: AttemptRow): Record<string, unknown> {
  return {
    type: "attempt",
    attemptId: a.attempt_id,
    contestId: a.contest_id,
    breaker: a.breaker,
    payerAccount: a.payer_account,
    text: a.text,
    reply: a.reply,
    toolCalls: parse(a.tool_calls_json, []),
    og: parse(a.og_json, []),
    startedAt: a.started_at,
    latencyMs: a.latency_ms,
    outcome: a.outcome,
    amount: a.amount,
    settleTx: a.settle_tx,
  };
}

export function canaryRecord(r: CanaryRoundRow): Record<string, unknown> {
  return {
    type: "canary_round",
    contestId: r.contest_id,
    round: r.round,
    startedAt: r.started_at,
    results: parse(r.results_json, []),
    failures: r.failures,
    passed: r.passed === 1,
    action: r.action,
  };
}

export async function signRecord(record: Record<string, unknown>, signer: Signer): Promise<{ recordHash: Hex; signature: Hex }> {
  const recordHash = keccak256(toBytes(canonicalJson(record)));
  return { recordHash, signature: await signer.sign(recordHash) };
}

/**
 * The published log (§10.8 step 4): attempt and canary records sorted by time (attempts by startedAt ms,
 * canaries by startedAt × 1000), ties by type (attempt first) then by attemptId / round as strings.
 * Each line is the canonical JSON of the record plus recordHash, signature and (attempts only) depositStatus.
 */
export function buildLog(attempts: AttemptRow[], rounds: CanaryRoundRow[]): { text: string; logHash: Hex } {
  type Line = { t: number; type: string; key: string; json: string };
  const lines: Line[] = [];
  for (const a of attempts) {
    if (a.outcome === "pending") continue;
    lines.push({
      t: a.started_at,
      type: "attempt",
      key: a.attempt_id,
      json: canonicalJson({ ...attemptRecord(a), recordHash: a.record_hash, signature: a.signature, depositStatus: a.deposit_status }),
    });
  }
  for (const r of rounds) {
    lines.push({
      t: r.started_at * 1000,
      type: "canary_round",
      key: String(r.round),
      json: canonicalJson({ ...canaryRecord(r), recordHash: r.record_hash, signature: r.signature }),
    });
  }
  lines.sort((x, y) => x.t - y.t || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const text = lines.map((l) => `${l.json}\n`).join("");
  return { text, logHash: keccak256(toBytes(text)) };
}
