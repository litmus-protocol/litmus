import { keccak256, toBytes, type Hex } from "viem";
import type { Address } from "./api";
import type { DeploymentName } from "./deployments";

// ERC-8004 (agent identity + reputation) helpers shared by the gateway, web app and breaker bot.

export const ERC8004_REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export type FeedbackTag1 = "defect.held" | "defect.broken" | "defect.bounty";

/** CAIP-10 style registry id, e.g. "eip155:296:0xabc…" (address lowercased). */
export function agentRegistryId(chainId: number, identity: Address): string {
  return `eip155:${chainId}:${identity.toLowerCase()}`;
}

export function feedbackTag2(deployment: DeploymentName, contestId: number): string {
  return `${deployment}:${contestId}`;
}

export function parseFeedbackTag2(tag2: string): { deployment: DeploymentName; contestId: number } | null {
  const m = /^(prod|demo):(0|[1-9][0-9]*)$/.exec(tag2);
  if (!m) return null;
  const contestId = Number(m[2]);
  if (!Number.isSafeInteger(contestId)) return null;
  return { deployment: m[1] as DeploymentName, contestId };
}

export interface Erc8004AgentCard {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support?: boolean;
  active: boolean;
  registrations?: { agentId: number; agentRegistry: string }[];
  supportedTrust?: string[];
}

export function buildAgentCard(input: {
  name: string;
  description: string;
  siteUrl: string;
  x402Support?: boolean;
  registration?: { agentId: number; agentRegistry: string };
}): Erc8004AgentCard {
  const card: Erc8004AgentCard = {
    type: ERC8004_REGISTRATION_TYPE,
    name: input.name,
    description: input.description,
    services: [{ name: "web", endpoint: input.siteUrl }],
    active: true,
    supportedTrust: ["reputation"],
  };
  if (input.x402Support !== undefined) card.x402Support = input.x402Support;
  if (input.registration) card.registrations = [input.registration];
  return card;
}

const JSON_DATA_URI_PREFIX = "data:application/json;base64,";

/** Encode a value as a base64 JSON data URI; `hash` is keccak256 of the UTF-8 JSON bytes. */
export function toJsonDataUri(value: unknown): { uri: string; bytes: Uint8Array; hash: Hex } {
  const bytes = toBytes(JSON.stringify(value));
  return { uri: JSON_DATA_URI_PREFIX + Buffer.from(bytes).toString("base64"), bytes, hash: keccak256(bytes) };
}

/** Decode a base64 JSON data URI; null when it is not one or the JSON is invalid. */
export function fromJsonDataUri(uri: string): unknown | null {
  if (!uri.startsWith(JSON_DATA_URI_PREFIX)) return null;
  try {
    return JSON.parse(Buffer.from(uri.slice(JSON_DATA_URI_PREFIX.length), "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Off-chain feedback file referenced by a reputation `giveFeedback` call (feedbackURI + feedbackHash). */
export interface DefectFeedbackFile {
  agentRegistry: string;
  agentId: number;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: FeedbackTag1;
  tag2: string;
  endpoint: string;
  proofOfPayment?: { fromAddress: string; toAddress: string; chainId: string; txHash: string };
  defect: {
    arena: Address;
    deployment: DeploymentName;
    contestId: number;
    status: "held" | "broken";
    packageHash: Hex;
    logHash: Hex | null;
    invariants: { kind: string; text: string }[];
    brokenInvariant: number | null;
    finalPool: string;
    messageCount: number;
    uniqueBreakers: number;
    breakTx: Hex | null;
    certificateTokenId: number | null;
    attestations: { chain: "sepolia"; address: Address; contestId: number } | null;
  };
}
