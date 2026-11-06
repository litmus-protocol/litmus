import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import {
  INVARIANT_KIND,
  USDC_TOKEN_ID,
  X402_NETWORK,
  hashJson,
  secretHash,
  toBaseUnits,
  treasuryBotSubmission,
  withStartTime,
  type ContestSecretsResponse,
  type DraftSecretsResponse,
  type LoadContestRequest,
  type RunRequest,
  type RunResult,
  type RunnerHealth,
  type WardenSubmission,
} from "@defect/shared";
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HederaAccountError, type AccountKey, type AccountResolver } from "../src/accounts";
import { createApp } from "../src/app";
import { PHASE, STATUS, type ArenaEvent, type GatewayChain, type GiveFeedbackInput, type OnchainContest, type OnchainInvariant } from "../src/chain";
import { ContestStateCache, type Ctx } from "../src/context";
import { Db } from "../src/db";
import type { FaucetAccountInfo, FaucetChain } from "../src/faucet";
import { X402Payments } from "../src/payments";
import { operatorSigner } from "../src/records";
import { RunnerError, type RunnerClient } from "../src/runner-client";

export const OPERATOR_KEY = `0x${"11".repeat(32)}` as Hex;
export const OPERATOR_ACCOUNT = "0.0.5000";
export const FEE_PAYER = "0.0.9185802";
export const BREAKER_ACCOUNT = "0.0.7001";
export const BREAKER = "0x7001000000000000000000000000000000007001" as Address;
export const SECRET = "DFT-AAAAAAAAAAAAAAAAAAAAAAAAAA";
export const NOW = 1_800_000_000;
export const FAKE_IDENTITY_REGISTRY = "0x000000000000000000000000000000000008004a" as Address;
export const FAKE_REPUTATION_REGISTRY = "0x000000000000000000000000000000000008004b" as Address;

export class FakeChain implements GatewayChain {
  operatorAddress = privateKeyToAccount(OPERATOR_KEY).address;
  contests = new Map<number, OnchainContest>();
  invariants = new Map<number, OnchainInvariant[]>();
  phases = new Map<number, number>();
  events = new Map<number, ArenaEvent[]>();
  calls: { fn: string; args: unknown[] }[] = [];
  failDeposit = false;
  private n = 0;

  private tx(fn: string, args: unknown[]): Hex {
    this.calls.push({ fn, args });
    return `0x${(++this.n).toString(16).padStart(64, "0")}` as Hex;
  }
  callsOf(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }
  async phase(id: number) {
    return this.phases.get(id) ?? PHASE.Open;
  }
  async getContest(id: number) {
    const c = this.contests.get(id);
    if (!c) return { ...emptyContest(), status: 0 };
    return { ...c };
  }
  async getInvariants(id: number) {
    return this.invariants.get(id) ?? [];
  }
  async windowSeconds() {
    return 900;
  }
  async usdcAllowance() {
    return 10n ** 15n;
  }
  async approveUsdc(spender: Address, amount: bigint) {
    return this.tx("approveUsdc", [spender, amount]);
  }
  async transferUsdc(to: Address, amount: bigint) {
    return this.tx("transferUsdc", [to, amount]);
  }
  async depositFee(id: number, breaker: Address, amount: bigint, ref: Hex) {
    if (this.failDeposit) throw new Error("deposit boom");
    const c = this.contests.get(id)!;
    c.pool += (amount * 7000n) / 10000n;
    c.escrow += amount - (amount * 7000n) / 10000n - (amount * 2000n) / 10000n;
    c.messageCount++;
    return this.tx("depositFee", [id, breaker, amount, ref]);
  }
  async refund(id: number, breakers: Address[], amounts: bigint[]) {
    return this.tx("refund", [id, breakers, amounts]);
  }
  async voidContest(id: number, breakers: Address[], amounts: bigint[]) {
    this.contests.get(id)!.status = STATUS.Void;
    this.phases.set(id, PHASE.Void);
    return this.tx("voidContest", [id, breakers, amounts]);
  }
  async cancel(id: number) {
    const c = this.contests.get(id);
    if (c) c.status = STATUS.Cancelled;
    this.phases.set(id, PHASE.Cancelled);
    return this.tx("cancel", [id]);
  }
  async closeHeld(id: number) {
    this.contests.get(id)!.status = STATUS.Held;
    this.phases.set(id, PHASE.Held);
    return this.tx("closeHeld", [id]);
  }
  async postLogHash(id: number, h: Hex) {
    this.contests.get(id)!.logHash = h;
    return this.tx("postLogHash", [id, h]);
  }
  async contestEvents(id: number) {
    return this.events.get(id) ?? [];
  }
  /** Certificates by contest id; set `certificatesEnabled = false` to model "no DefectCertificate deployed". */
  certificatesEnabled = true;
  certificates = new Map<number, { reported: boolean; messageCount: number; uniqueBreakers?: number; agentName?: string }>();
  async certificateState(id: number) {
    if (!this.certificatesEnabled) return null;
    const c = this.certificates.get(id);
    return { minted: !!c, reported: c?.reported ?? false, messageCount: c?.messageCount ?? 0 };
  }
  async mintCertificate(id: number) {
    const c = this.contests.get(id)!;
    if (c.status !== STATUS.Held) throw new Error("NotHeld");
    if (this.certificates.has(id)) throw new Error("AlreadyMinted");
    this.certificates.set(id, { reported: false, messageCount: c.messageCount });
    return this.tx("mintCertificate", [id]);
  }
  async reportCertificate(id: number, uniqueBreakers: number, agentName: string) {
    const c = this.certificates.get(id);
    if (!c) throw new Error("NotMinted");
    if (c.reported) throw new Error("AlreadyReported");
    Object.assign(c, { reported: true, uniqueBreakers, agentName });
    return this.tx("reportCertificate", [id, uniqueBreakers, agentName]);
  }

  /** In-memory ERC-8004 registries; set `erc8004 = null` to model "registries not deployed". */
  erc8004: { identity: Address; reputation: Address } | null = { identity: FAKE_IDENTITY_REGISTRY, reputation: FAKE_REPUTATION_REGISTRY };
  agents = new Map<number, { owner: Address; wallet: Address; uri: string; operators: Set<string> }>();
  feedback: {
    agentId: number;
    tag1: string;
    tag2: string;
    value: bigint;
    valueDecimals: number;
    feedbackURI: string;
    revoked: boolean;
    txHash?: Hex;
    timestamp?: number;
  }[] = [];
  async agentOwner(agentId: number) {
    if (!this.erc8004) return null;
    return this.agents.get(agentId)?.owner ?? null;
  }
  async agentWallet(agentId: number) {
    if (!this.erc8004) return null;
    const w = this.agents.get(agentId)?.wallet;
    return !w || w.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : w;
  }
  async isAgentOperator(spender: Address, agentId: number) {
    const a = this.agents.get(agentId);
    if (!this.erc8004 || !a) return false;
    const s = spender.toLowerCase();
    return a.owner.toLowerCase() === s || [...a.operators].some((o) => o.toLowerCase() === s);
  }
  async agentURI(agentId: number) {
    if (!this.erc8004) throw new Error("No ERC-8004 registries configured");
    const a = this.agents.get(agentId);
    if (!a) throw new Error("ERC721NonexistentToken");
    return a.uri;
  }
  /** 1-based, per agent, like the real registry's feedbackIndex. */
  async readDefectFeedback(agentId: number) {
    if (!this.erc8004) return [];
    return this.feedback
      .filter((f) => f.agentId === agentId)
      .map((f, i) => ({ index: i + 1, tag1: f.tag1, tag2: f.tag2, revoked: f.revoked }));
  }
  async giveFeedback(f: GiveFeedbackInput) {
    if (!this.erc8004) throw new Error("No ERC-8004 registries configured");
    // Throws before recording: a rejected self-feedback call does not appear in callsOf("giveFeedback").
    const a = this.agents.get(f.agentId);
    const op = this.operatorAddress.toLowerCase();
    if (a && (a.owner.toLowerCase() === op || [...a.operators].some((o) => o.toLowerCase() === op))) {
      throw new Error("Self-feedback not allowed");
    }
    const txHash = this.tx("giveFeedback", [f]);
    this.feedback.push({
      agentId: f.agentId,
      tag1: f.tag1,
      tag2: f.tag2,
      value: f.value,
      valueDecimals: f.valueDecimals,
      feedbackURI: f.feedbackURI,
      revoked: false,
      txHash,
      timestamp: NOW,
    });
    return txHash;
  }
  async feedbackEvents(agentId: number) {
    if (!this.erc8004) return [];
    return this.feedback
      .filter((f) => f.agentId === agentId)
      .map((f, i) => ({
        index: i + 1,
        tag1: f.tag1,
        tag2: f.tag2,
        value: f.value,
        valueDecimals: f.valueDecimals,
        feedbackURI: f.feedbackURI,
        txHash: f.txHash ?? (`0x${"0".repeat(63)}1` as Hex),
        timestamp: f.timestamp ?? NOW,
      }));
  }
}

export function emptyContest(): OnchainContest {
  const z32 = `0x${"0".repeat(64)}` as Hex;
  return {
    warden: "0x9000000000000000000000000000000000000009",
    status: STATUS.Active,
    startTime: NOW - 60,
    endTime: NOW + 900,
    messageCount: 0,
    brokenInvariant: 0,
    winner: "0x0000000000000000000000000000000000000000",
    messagePrice: 50_000n,
    initialPool: 20_000_000n,
    pool: 20_000_000n,
    vault: 15_000_000n,
    bond: 4_000_000n,
    escrow: 0n,
    packageHash: z32,
    canaryHash: z32,
    logHash: z32,
  };
}

export type RunHandler = (req: RunRequest) => Promise<RunResult>;

export function okRun(reply = "Done.", extra: Partial<RunResult> = {}): RunResult {
  return {
    reply,
    toolCalls: [],
    broke: false,
    og: [{ requestId: "req-1", provider: "0xprov", totalCost: "100", teeVerified: true }],
    modelCalls: 1,
    durationMs: 10,
    ...extra,
  };
}

export class FakeRunner implements RunnerClient {
  onRun: RunHandler = async () => okRun();
  loadError: RunnerError | null = null;
  loads: number[] = [];
  runs: RunRequest[] = [];
  async draftSecrets(_draftId: string, ids: string[]): Promise<DraftSecretsResponse> {
    return { secretHashes: Object.fromEntries(ids.map((id) => [id, secretHash(SECRET)])) };
  }
  async load(contestId: number, _body: LoadContestRequest): Promise<void> {
    if (this.loadError) throw this.loadError;
    this.loads.push(contestId);
  }
  async run(req: RunRequest): Promise<RunResult> {
    this.runs.push(req);
    return this.onRun(req);
  }
  async secrets(): Promise<ContestSecretsResponse> {
    return { secrets: { "inv-2": SECRET } };
  }
  async health(): Promise<RunnerHealth> {
    return { ok: true, runner: "0x6a60d7b8c6ebfa648aa993e2e4b6205e0e6ca866" };
  }
}

export class FakeFacilitator implements FacilitatorClient {
  valid = true;
  settleOk = true;
  payer = BREAKER_ACCOUNT;
  settles = 0;
  verifies = 0;
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifies++;
    return this.valid ? { isValid: true, payer: this.payer } : { isValid: false, invalidReason: "invalid_signature", invalidMessage: "bad signature" };
  }
  async settle(): Promise<SettleResponse> {
    this.settles++;
    return this.settleOk
      ? { success: true, transaction: `${FEE_PAYER}@1762412999.${String(this.settles).padStart(9, "0")}`, network: X402_NETWORK as `${string}:${string}`, payer: this.payer }
      : { success: false, errorReason: "insufficient_funds", transaction: "", network: X402_NETWORK as `${string}:${string}` };
  }
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: X402_NETWORK as `${string}:${string}`, extra: { feePayer: FEE_PAYER } }],
      extensions: [],
      signers: {},
    };
  }
}

export class FakeAccounts implements AccountResolver {
  map = new Map<string, Address>([[BREAKER_ACCOUNT, BREAKER]]);
  keys = new Map<string, AccountKey>();
  unsupported = new Set<string>();
  async toEvm(accountId: string): Promise<Address> {
    if (this.unsupported.has(accountId)) throw new HederaAccountError("UNSUPPORTED_ACCOUNT_KEY", "key list");
    const evm = this.map.get(accountId);
    if (!evm) throw new HederaAccountError("ACCOUNT_NOT_FOUND", "nope");
    return evm;
  }
  async key(accountId: string): Promise<AccountKey> {
    const k = this.keys.get(accountId);
    if (!k) throw new HederaAccountError("ACCOUNT_NOT_FOUND", "nope");
    return k;
  }
}

export class FakeFaucetChain implements FaucetChain {
  address = "0xfa00000000000000000000000000000000000fa0" as Address;
  accounts = new Map<string, FaucetAccountInfo>();
  hbar = 1_000n * 100_000_000n;
  usdc = 100_000_000n;
  sent: { asset: "hbar" | "usdc"; to: Address; amount: bigint }[] = [];
  fail = false;
  private n = 0;
  async account(address: Address) {
    return this.accounts.get(address.toLowerCase()) ?? null;
  }
  async hbarBalance() {
    return this.hbar;
  }
  async usdcBalance() {
    return this.usdc;
  }
  async sendHbar(to: Address, tinybars: bigint) {
    if (this.fail) throw new Error("relay down");
    this.sent.push({ asset: "hbar", to, amount: tinybars });
    this.hbar -= tinybars;
    return `0x${"f".repeat(60)}${(++this.n).toString(16).padStart(4, "0")}` as Hex;
  }
  async sendUsdc(to: Address, units: bigint) {
    if (this.fail) throw new Error("relay down");
    this.sent.push({ asset: "usdc", to, amount: units });
    this.usdc -= units;
    return `0x${"e".repeat(60)}${(++this.n).toString(16).padStart(4, "0")}` as Hex;
  }
}

export interface TestEnv {
  ctx: Ctx;
  chain: FakeChain;
  runner: FakeRunner;
  facilitator: FakeFacilitator;
  accounts: FakeAccounts;
  faucet: FakeFaucetChain;
  app: ReturnType<typeof createApp>;
  clock: { now: number };
  logs: string[];
  pokes: number[];
}

export function makeEnv(): TestEnv {
  const db = new Db(":memory:");
  const chain = new FakeChain();
  const runner = new FakeRunner();
  const facilitator = new FakeFacilitator();
  const accounts = new FakeAccounts();
  const faucet = new FakeFaucetChain();
  const clock = { now: NOW };
  const logs: string[] = [];
  const pokes: number[] = [];
  const ctx: Ctx = {
    db,
    chain,
    runner,
    payments: new X402Payments(OPERATOR_ACCOUNT, facilitator),
    accounts,
    faucet: { chain: faucet, hbarTinybars: 500_000_000n, usdcUnits: 1_000_000n, dailyCap: 5 },
    signer: operatorSigner(OPERATOR_KEY),
    state: new ContestStateCache(chain, 0),
    settings: {
      arena: "0xd03b5ee5f1b69be9b2b3b0eb8ac0f11c594fcf33",
      deployment: "demo",
      operatorAccountId: OPERATOR_ACCOUNT,
      allowedModels: ["0gm-1.0-35b-a3b"],
      canaryIntervalSec: 180,
      mirrorNodeUrl: "https://mirror.test",
      attestations: null,
      certificate: "0xf8767161e02bac16178e1e2061ce9f14e24bc0ab",
      erc8004: { identity: FAKE_IDENTITY_REGISTRY, reputation: FAKE_REPUTATION_REGISTRY },
      siteUrl: "http://localhost:3000",
      publicUrl: "http://gateway.test",
      windowSeconds: 900,
    },
    now: () => clock.now,
    log: (m) => logs.push(m),
    pokeStatus: (id) => pokes.push(id),
  };
  return { ctx, chain, runner, facilitator, accounts, faucet, app: createApp(ctx, { webOrigins: ["http://localhost:3000"] }), clock, logs, pokes };
}

export function submission(overrides: Partial<WardenSubmission> = {}): WardenSubmission {
  return { ...withStartTime(treasuryBotSubmission, NOW), ...overrides };
}

/** Puts a loaded, open TreasuryBot contest into both the DB and the fake chain. */
export function seedContest(env: TestEnv, id = 1, opts: { phase?: number } = {}): void {
  const sub = submission({ startTime: NOW - 60 });
  const draftId = `draft-${id}`;
  env.ctx.db.run(
    "INSERT INTO drafts (draft_id, submission_json, package_hash, canary_hash, secret_hashes_json, created_at, contest_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [draftId, JSON.stringify(sub), hashJson(sub.package), hashJson(sub.canaries), JSON.stringify({ "inv-2": secretHash(SECRET) }), NOW, id],
  );
  env.ctx.db.run(
    `INSERT INTO contests (contest_id, draft_id, warden, card_json, package_json, invariants_json, canaries_json, start_time, end_time, message_price, status, loaded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`,
    [
      id,
      draftId,
      "0x9000000000000000000000000000000000000009",
      JSON.stringify(sub.card),
      JSON.stringify(sub.package),
      JSON.stringify(sub.invariants),
      JSON.stringify(sub.canaries),
      NOW - 60,
      NOW + 900,
      toBaseUnits(sub.messagePrice).toString(),
    ],
  );
  env.chain.contests.set(id, {
    ...emptyContest(),
    messagePrice: toBaseUnits(sub.messagePrice),
    initialPool: toBaseUnits(sub.pool),
    pool: toBaseUnits(sub.pool),
    vault: toBaseUnits(sub.vaultFunding),
    bond: toBaseUnits(sub.bond),
    packageHash: hashJson(sub.package),
    canaryHash: hashJson(sub.canaries),
  });
  env.chain.invariants.set(
    id,
    sub.invariants.map((inv) => ({
      kind: INVARIANT_KIND[inv.type],
      secretHash: inv.type === "secret" ? secretHash(SECRET) : (`0x${"0".repeat(64)}` as Hex),
      maxAmount: inv.type === "transfer_limit" ? toBaseUnits(inv.maxAmount) : 0n,
    })),
  );
  env.chain.phases.set(id, opts.phase ?? PHASE.Open);
}

/** Builds a PAYMENT-SIGNATURE header that matches the gateway's own 402 requirements. */
export async function paymentHeader(env: TestEnv, contestId = 1, tx = randomBytes(24).toString("base64")): Promise<string> {
  const res = await env.app.request(`/contests/${contestId}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { "Content-Type": "application/json" } });
  const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
  const accepted = pr.accepts[0]!;
  return encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted, payload: { transaction: tx } });
}

export function postMessage(env: TestEnv, text: string, header?: string, contestId = 1) {
  return env.app.request(`/contests/${contestId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
    headers: { "Content-Type": "application/json", ...(header ? { "PAYMENT-SIGNATURE": header } : {}) },
  });
}

export { USDC_TOKEN_ID };
