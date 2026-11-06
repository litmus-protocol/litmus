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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
    if (uri.startsWith("data:")) {
      const v = fromJsonDataUri(uri);
      return isObject(v) ? (v as unknown as Erc8004AgentCard) : null;
    }
    if (!uri.startsWith("https:")) return null;
    const load = async (): Promise<unknown> => {
      const res = await fetchFn(uri, { signal: AbortSignal.timeout(CARD_TIMEOUT_MS) });
      if (!res.ok) return null;
      return JSON.parse(await res.text()) as unknown;
    };
    const v = await withTimeout(load(), CARD_TIMEOUT_MS);
    return isObject(v) ? (v as unknown as Erc8004AgentCard) : null;
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
