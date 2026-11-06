import {
  agentRegistryId,
  fromBaseUnits,
  fromJsonDataUri,
  HEDERA_TESTNET_CHAIN_ID,
  parseFeedbackTag2,
  type AgentProfile,
  type AgentRecordEntry,
  type Erc8004AgentCard,
  type FeedbackTag1,
} from "@defect/shared";
import type { Ctx } from "../context";
import { ApiFailure } from "./errors";

const CARD_TIMEOUT_MS = 3000;
const TAG1: readonly string[] = ["defect.held", "defect.broken", "defect.bounty"] satisfies FeedbackTag1[];

const MAX_CARD_BYTES = 64 * 1024;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

/**
 * Keeps only the known card fields, type-checked and length-capped. The card is Warden-controlled and shown on a
 * public page, so nothing else passes through. Null when there is no usable name.
 */
export function sanitizeCard(raw: unknown): Erc8004AgentCard | null {
  if (!isObject(raw)) return null;
  const name = str(raw.name, 100);
  if (name === null) return null;
  const card: Erc8004AgentCard = {
    type: str(raw.type, 64) ?? "",
    name,
    description: str(raw.description, 1000) ?? "",
    services: [],
    active: raw.active === true,
  };
  const image = str(raw.image, 500);
  if (image !== null && (image.startsWith("https://") || image.startsWith("ipfs://"))) card.image = image;
  if (Array.isArray(raw.services)) {
    for (const e of raw.services.slice(0, 10)) {
      if (!isObject(e)) continue;
      const n = str(e.name, 40);
      const endpoint = str(e.endpoint, 500);
      if (n === null || endpoint === null) continue;
      const version = str(e.version, 40);
      card.services.push(version === null ? { name: n, endpoint } : { name: n, endpoint, version });
    }
  }
  if (typeof raw.x402Support === "boolean") card.x402Support = raw.x402Support;
  if (Array.isArray(raw.registrations)) {
    const regs: { agentId: number; agentRegistry: string }[] = [];
    for (const e of raw.registrations.slice(0, 10)) {
      if (!isObject(e) || typeof e.agentId !== "number" || !Number.isSafeInteger(e.agentId)) continue;
      const agentRegistry = str(e.agentRegistry, 120);
      if (agentRegistry !== null) regs.push({ agentId: e.agentId, agentRegistry });
    }
    card.registrations = regs;
  }
  if (Array.isArray(raw.supportedTrust)) {
    card.supportedTrust = raw.supportedTrust.filter((t): t is string => typeof t === "string").slice(0, 10).map((t) => t.slice(0, 40));
  }
  return card;
}

/** Only public https hosts by name: no IP literals, localhost or internal-looking names. (DNS results are not checked.) */
function safeCardUrl(uri: string): URL | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return null;
  if (host === "localhost" || [".localhost", ".local", ".internal"].some((suffix) => host.endsWith(suffix))) return null;
  return u;
}

/** Reads at most MAX_CARD_BYTES; null when the body is larger. */
async function readCapped(res: Response): Promise<string | null> {
  const len = res.headers.get("content-length");
  if (len !== null && Number(len) > MAX_CARD_BYTES) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CARD_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolves to null after `ms`, so a fetch that ignores its abort signal can't hold the request open. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The agent's registration card: decoded from a data: URI, or fetched from an https: URL. Null when unreadable. */
async function readCard(uri: string, fetchFn: typeof fetch): Promise<Erc8004AgentCard | null> {
  try {
    if (uri.startsWith("data:")) return sanitizeCard(fromJsonDataUri(uri));
    const url = safeCardUrl(uri);
    if (!url) return null;
    const load = async (): Promise<unknown> => {
      const res = await fetchFn(url.href, { signal: AbortSignal.timeout(CARD_TIMEOUT_MS), redirect: "error" });
      if (!res.ok || !(res.headers.get("content-type") ?? "").toLowerCase().includes("json")) return null;
      const body = await readCapped(res);
      return body === null ? null : (JSON.parse(body) as unknown);
    };
    return sanitizeCard(await withTimeout(load(), CARD_TIMEOUT_MS));
  } catch {
    return null;
  }
}

function packageHashOf(feedbackURI: string): `0x${string}` | null {
  const file = fromJsonDataUri(feedbackURI);
  if (!isObject(file) || !isObject(file.defect)) return null;
  const h = file.defect.packageHash;
  return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h) ? (h as `0x${string}`) : null;
}

/** Model and pinned provider of a contest in this gateway's database (null when it is not here). */
function inferenceOf(ctx: Ctx, contestId: number): AgentRecordEntry["inference"] {
  const row = ctx.db.contest(contestId);
  if (!row) return null;
  try {
    const pkg = JSON.parse(row.package_json) as { model?: unknown; providerAddress?: unknown };
    if (typeof pkg.model !== "string") return null;
    return { model: pkg.model, providerAddress: typeof pkg.providerAddress === "string" ? (pkg.providerAddress as `0x${string}`) : null };
  } catch {
    return null;
  }
}

/** Public ERC-8004 profile of an agent: its card plus the Defect results posted on its record. */
export async function agentProfile(ctx: Ctx, agentId: number, fetchFn: typeof fetch = fetch): Promise<AgentProfile> {
  const registries = ctx.settings.erc8004;
  const owner = registries ? await ctx.chain.agentOwner(agentId) : null;
  if (!registries || !owner) throw new ApiFailure(404, "AGENT_NOT_FOUND", "No agent with this id");

  const cardUri = await ctx.chain.agentURI(agentId);
  const [card, events, onchain] = await Promise.all([readCard(cardUri, fetchFn), ctx.chain.feedbackEvents(agentId), ctx.chain.readDefectFeedback(agentId)]);
  const revoked = new Set(onchain.filter((f) => f.revoked).map((f) => f.index));

  const record: AgentRecordEntry[] = [];
  for (const e of events) {
    if (revoked.has(e.index) || !TAG1.includes(e.tag1)) continue;
    const tag2 = parseFeedbackTag2(e.tag2);
    if (!tag2) continue;
    record.push({
      tag1: e.tag1 as FeedbackTag1,
      deployment: tag2.deployment,
      contestId: tag2.contestId,
      value: e.valueDecimals === 6 ? fromBaseUnits(e.value) : String(e.value),
      packageHash: packageHashOf(e.feedbackURI),
      inference: tag2.deployment === ctx.settings.deployment ? inferenceOf(ctx, tag2.contestId) : null,
      txHash: e.txHash,
      timestamp: e.timestamp,
    });
  }

  const count = (t: FeedbackTag1) => record.filter((r) => r.tag1 === t).length;
  return {
    agentId,
    registry: agentRegistryId(HEDERA_TESTNET_CHAIN_ID, registries.identity),
    owner,
    cardUri,
    card,
    record,
    counts: { held: count("defect.held"), broken: count("defect.broken"), bounties: count("defect.bounty") },
  };
}
