import {
  CANARY_INTERVAL_SEC_DEMO,
  CANARY_INTERVAL_SEC_PROD,
  DEFAULT_MODEL,
  HEDERA_RPC_TESTNET,
  MIRROR_NODE_TESTNET,
  X402_FACILITATOR_DEFAULT,
  getArenaDeployment,
  getAttestationsAddress,
  getCertificateAddress,
  getErc8004Addresses,
  parseDeploymentName,
  requireArenaAddress,
  type DeploymentName,
} from "@defect/shared";

export interface GatewayConfig {
  port: number;
  dataDir: string;
  deployment: DeploymentName;
  arena: `0x${string}`;
  arenaDeployBlock: number | null;
  attestations: `0x${string}` | null;
  certificate: `0x${string}` | null;
  /** ERC-8004 identity + reputation registries, or null until deployed. */
  erc8004: { identity: `0x${string}`; reputation: `0x${string}` } | null;
  operatorPrivateKey: `0x${string}`;
  operatorAccountId: string;
  facilitatorUrl: string;
  runnerUrl: string;
  runnerToken: string;
  allowedModels: string[];
  canaryIntervalSec: number;
  webOrigins: string[];
  rpcUrl: string;
  mirrorNodeUrl: string;
  /** Public base URL of this gateway, used as the x402 resource URL. */
  publicUrl: string;
  /** Public base URL of the web app (SITE_URL), used as the ERC-8004 feedback `endpoint`; null when unset or invalid. */
  siteUrl: string | null;
}

/** SITE_URL as a base URL without a trailing slash; null when unset or not an http(s) URL. */
export function parseSiteUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return v.replace(/\/+$/, "");
}

/**
 * Startup warnings about SITE_URL. Feedback endpoints are written on chain for good, so a missing site URL
 * turns feedback posting off and a non-public one is called out.
 */
export function siteUrlWarnings(config: Pick<GatewayConfig, "erc8004" | "siteUrl">, raw: string | undefined): string[] {
  if (!config.erc8004) return [];
  if (config.siteUrl === null) {
    return raw?.trim()
      ? [`WARNING SITE_URL "${raw}" is not an http(s) URL; ERC-8004 feedback will not be posted`]
      : ["WARNING SITE_URL is unset; ERC-8004 feedback will not be posted"];
  }
  const u = new URL(config.siteUrl);
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]") {
    return [`WARNING SITE_URL ${config.siteUrl} is not a public https URL; ERC-8004 feedback endpoints will point at it permanently`];
  }
  return [];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env ${name}. See apps/gateway/.env.example.`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const deployment = parseDeploymentName(env.ARENA_DEPLOYMENT);
  const arena = (env.ARENA_ADDRESS_OVERRIDE as `0x${string}` | undefined) ?? requireArenaAddress(deployment);
  const pk = required(env, "OPERATOR_PRIVATE_KEY");
  const operatorAccountId = required(env, "OPERATOR_ACCOUNT_ID");
  if (!/^0\.0\.\d+$/.test(operatorAccountId)) throw new Error("OPERATOR_ACCOUNT_ID must look like 0.0.12345");
  const runnerToken = required(env, "RUNNER_TOKEN");
  if (runnerToken.length < 32) throw new Error("RUNNER_TOKEN must be at least 32 characters");
  const port = Number(env.GATEWAY_PORT ?? "8787");
  const canaryDefault = deployment === "demo" ? CANARY_INTERVAL_SEC_DEMO : CANARY_INTERVAL_SEC_PROD;
  const canaryIntervalSec = Number(env.CANARY_INTERVAL_SEC ?? canaryDefault);
  if (!Number.isFinite(canaryIntervalSec) || canaryIntervalSec < 10) throw new Error("CANARY_INTERVAL_SEC must be a number ≥ 10");

  return {
    port,
    dataDir: env.GATEWAY_DATA_DIR ?? "./data",
    deployment,
    arena,
    arenaDeployBlock: getArenaDeployment(deployment).block,
    attestations: getAttestationsAddress(),
    // An ARENA_ADDRESS_OVERRIDE points at an arena the recorded certificate doesn't belong to.
    certificate: env.ARENA_ADDRESS_OVERRIDE ? null : getCertificateAddress(deployment),
    // Same for the ERC-8004 feedback: its tag2/endpoint name contests of the recorded arena, not the override.
    erc8004: env.ARENA_ADDRESS_OVERRIDE ? null : getErc8004Addresses(),
    operatorPrivateKey: (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`,
    operatorAccountId,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? X402_FACILITATOR_DEFAULT,
    runnerUrl: (env.RUNNER_URL ?? "http://127.0.0.1:8788").replace(/\/$/, ""),
    runnerToken,
    allowedModels: (env.RUNNER_ALLOWED_MODELS ?? DEFAULT_MODEL)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    canaryIntervalSec,
    webOrigins: (env.WEB_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rpcUrl: env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET,
    mirrorNodeUrl: (env.MIRROR_NODE_URL ?? MIRROR_NODE_TESTNET).replace(/\/$/, ""),
    publicUrl: (env.GATEWAY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    siteUrl: parseSiteUrl(env.SITE_URL),
  };
}
