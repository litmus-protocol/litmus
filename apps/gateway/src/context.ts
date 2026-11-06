import type { ContestPhase } from "@defect/shared";
import type { AccountResolver } from "./accounts";
import { PHASE, type GatewayChain, type OnchainContest } from "./chain";
import type { Db } from "./db";
import type { Payments } from "./payments";
import type { Signer } from "./records";
import type { RunnerClient } from "./runner-client";

/** Everything routes and background jobs share. Tests build one with fakes. */
export interface Ctx {
  db: Db;
  chain: GatewayChain;
  runner: RunnerClient;
  payments: Payments;
  accounts: AccountResolver;
  signer: Signer;
  state: ContestStateCache;
  settings: {
    arena: `0x${string}`;
    deployment: "prod" | "demo";
    operatorAccountId: string;
    allowedModels: string[];
    canaryIntervalSec: number;
    mirrorNodeUrl: string;
    attestations: `0x${string}` | null;
    certificate: `0x${string}` | null;
    erc8004: { identity: `0x${string}`; reputation: `0x${string}` } | null;
    /** Public base URL of the web app (SITE_URL, no trailing slash); null turns ERC-8004 feedback posting off. */
    siteUrl: string | null;
    publicUrl: string;
    windowSeconds: number;
  };
  /** Unix seconds. Overridable in tests. */
  now(): number;
  log(msg: string): void;
  /** Ask the status poller to look at a contest right away (e.g. after a break). */
  pokeStatus(contestId: number): void;
}

export const PHASE_NAMES: Record<number, ContestPhase> = {
  [PHASE.Scheduled]: "scheduled",
  [PHASE.Open]: "open",
  [PHASE.AwaitingClose]: "awaiting_close",
  [PHASE.Broken]: "broken",
  [PHASE.Held]: "held",
  [PHASE.Void]: "void",
  [PHASE.Cancelled]: "cancelled",
};

export interface ContestState extends OnchainContest {
  phase: ContestPhase;
  fetchedAt: number;
}

/** On-chain contest reads cached for a few seconds (§10.3.3: "cache 5 s"). */
export class ContestStateCache {
  private readonly cache = new Map<number, ContestState>();
  private readonly inflight = new Map<number, Promise<ContestState>>();

  constructor(
    private readonly chain: GatewayChain,
    private readonly maxAgeMs = 5_000,
  ) {}

  async get(contestId: number, maxAgeMs = this.maxAgeMs): Promise<ContestState> {
    const hit = this.cache.get(contestId);
    if (hit && Date.now() - hit.fetchedAt <= maxAgeMs) return hit;
    let p = this.inflight.get(contestId);
    if (!p) {
      p = (async () => {
        const [c, phase] = await Promise.all([this.chain.getContest(contestId), this.chain.phase(contestId)]);
        const s: ContestState = { ...c, phase: PHASE_NAMES[phase] ?? "cancelled", fetchedAt: Date.now() };
        this.cache.set(contestId, s);
        return s;
      })().finally(() => this.inflight.delete(contestId));
      this.inflight.set(contestId, p);
    }
    return p;
  }

  invalidate(contestId: number): void {
    this.cache.delete(contestId);
  }
}

export function isEnded(phase: ContestPhase): boolean {
  return phase === "broken" || phase === "held" || phase === "void" || phase === "cancelled";
}
