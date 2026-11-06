import { parseCreAttest, type CreAttestSettings } from "./jobs/cre-attest";
import { loadConfig as loadBotConfig } from "@defect/breaker-bot";
import type { BotSettings } from "./services/bot";
import {
  CANARY_INTERVAL_SEC_DEMO,
  CANARY_INTERVAL_SEC_PROD,
  DEFAULT_MODEL,
  HEDERA_RPC_TESTNET,
  MIRROR_NODE_TESTNET,
  OG_ROUTER_MAINNET,
  X402_FACILITATOR_DEFAULT,
  toBaseUnits,
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
  /** 0G Router base URL for the live model/provider catalog; null when OG_CATALOG=off. */
  ogCatalogUrl: string | null;
  canaryIntervalSec: number;
  webOrigins: string[];
  rpcUrl: string;
  mirrorNodeUrl: string;
  /** Ethereum Sepolia RPC, for reading CRE attestations before a certificate is minted. */
  sepoliaRpcUrl: string;
  /** Public base URL of this gateway, used as the x402 resource URL. */
  publicUrl: string;
  /** Test-funds faucet; null without FAUCET_PRIVATE_KEY or with FAUCET_ENABLED=false. */
  faucet: {
    privateKey: `0x${string}`;
    hbar: string;
    usdc: string;
    dailyCap: number;
    perIpDailyCap: number;
    proxyHops: number;
    /** Require a Privy login for POST /faucet; null = open to any address. */
    privy: { appId: string; verificationKey: string } | null;
  } | null;
  /** Public base URL of the web app (SITE_URL), used as the ERC-8004 feedback `endpoint`; null when unset or invalid. */
  siteUrl: string | null;
  /** Auto-attest by running the CRE auditor after Held/Broken (jobs/cre-attest.ts); null unless CRE_AUTO_ATTEST is on and CRE_ETH_PRIVATE_KEY is valid. */
  creAttest?: CreAttestSettings | null;
  /** The shared breaker bot the web app can run; null unless BOT_HEDERA_ACCOUNT_ID, BOT_PRIVATE_KEY and OG_API_KEY_BOT are all set. */
  bot: BotSettings | null;
}

/**
 * The web app's breaker bot. It pays this gateway over its public URL, exactly as an outside agent
 * would, so its messages go through x402 discovery, the 402 and the facilitator like anyone else's.
 */
export function parseBot(env: NodeJS.ProcessEnv, publicUrl: string): BotSettings | null {
  if (!env.BOT_HEDERA_ACCOUNT_ID?.trim() || !env.BOT_PRIVATE_KEY?.trim() || !env.OG_API_KEY_BOT?.trim()) return null;
  const maxAttempts = Number(env.BOT_RUN_MAX_ATTEMPTS ?? "5");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 50) throw new Error("BOT_RUN_MAX_ATTEMPTS must be a whole number from 1 to 50");
  const maxPrice = env.BOT_RUN_MAX_PRICE ?? "0.5";
  if (!/^\d+(\.\d{1,6})?$/.test(maxPrice)) throw new Error("BOT_RUN_MAX_PRICE must be a decimal USDC amount");
  return { config: loadBotConfig("bot", { ...env, GATEWAY_URL: publicUrl }), maxAttempts, maxPriceUnits: toBaseUnits(maxPrice) };
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
  // The faucet never falls back to the operator key: a public faucet must not be able to spend the
  // operator's gas. Unset FAUCET_ENABLED = on when it has a key of its own.
  const faucetKey = env.FAUCET_PRIVATE_KEY?.trim() ?? "";
  const faucetSwitch = env.FAUCET_ENABLED?.trim() ?? "";
  if (/^(1|true|yes|on)$/i.test(faucetSwitch) && !faucetKey) throw new Error("FAUCET_ENABLED is on but FAUCET_PRIVATE_KEY is not set (use a separate funded account, not the operator)");
  const faucetEnabled = faucetKey.length > 0 && !/^(0|false|no|off)$/i.test(faucetSwitch);
  const faucetHbar = env.FAUCET_HBAR ?? "5";
  const faucetUsdc = env.FAUCET_USDC ?? "1";
  const faucetCap = Number(env.FAUCET_DAILY_CAP ?? "100");
  if (!/^\d+(\.\d{1,8})?$/.test(faucetHbar)) throw new Error("FAUCET_HBAR must be a decimal HBAR amount");
  if (!/^\d+(\.\d{1,6})?$/.test(faucetUsdc)) throw new Error("FAUCET_USDC must be a decimal USDC amount");
  if (!Number.isInteger(faucetCap) || faucetCap < 0) throw new Error("FAUCET_DAILY_CAP must be a whole number");
  const faucetPerIp = Number(env.FAUCET_PER_IP_DAILY ?? "3");
  if (!Number.isInteger(faucetPerIp) || faucetPerIp < 0) throw new Error("FAUCET_PER_IP_DAILY must be a whole number");
  const proxyHops = Number(env.TRUSTED_PROXY_HOPS ?? "0");
  if (!Number.isInteger(proxyHops) || proxyHops < 0) throw new Error("TRUSTED_PROXY_HOPS must be a whole number");
  const privyAppId = env.PRIVY_APP_ID?.trim() ?? "";
  const privyKey = env.PRIVY_VERIFICATION_KEY?.trim() ?? "";
  if (!privyAppId !== !privyKey) throw new Error("Set both PRIVY_APP_ID and PRIVY_VERIFICATION_KEY (the faucet then requires a Privy login), or neither");
  const publicUrl = (env.GATEWAY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
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
    ogCatalogUrl: /^(0|false|off|no)$/i.test(env.OG_CATALOG ?? "") ? null : (env.OG_ROUTER_BASE_URL ?? OG_ROUTER_MAINNET).replace(/\/$/, ""),
    canaryIntervalSec,
    webOrigins: (env.WEB_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rpcUrl: env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET,
    mirrorNodeUrl: (env.MIRROR_NODE_URL ?? MIRROR_NODE_TESTNET).replace(/\/$/, ""),
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com",
    publicUrl,
    faucet: faucetEnabled
      ? {
          privateKey: (faucetKey.startsWith("0x") ? faucetKey : `0x${faucetKey}`) as `0x${string}`,
          hbar: faucetHbar,
          usdc: faucetUsdc,
          dailyCap: faucetCap,
          perIpDailyCap: faucetPerIp,
          proxyHops,
          privy: privyAppId ? { appId: privyAppId, verificationKey: privyKey } : null,
        }
      : null,
    siteUrl: parseSiteUrl(env.SITE_URL),
    creAttest: parseCreAttest(env),
    bot: parseBot(env, publicUrl),
  };
}
