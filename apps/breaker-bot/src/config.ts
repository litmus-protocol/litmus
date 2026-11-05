import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_MODEL, HEDERA_RPC_TESTNET, MIRROR_NODE_TESTNET, OG_ROUTER_MAINNET } from "@defect/shared";

export type Role = "bot" | "human";

export interface Wallet {
  role: Role;
  accountId: string;
  privateKey: `0x${string}`;
  address: `0x${string}`;
}

export interface BotConfig {
  gatewayUrl: string;
  rpcUrl: string;
  mirrorNodeUrl: string;
  wallet: Wallet;
  og: { baseUrl: string; apiKey: string; model: string };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env ${name}. See apps/breaker-bot/.env.example.`);
  return v;
}

export function loadWallet(role: Role, env: NodeJS.ProcessEnv = process.env): Wallet {
  const idVar = role === "bot" ? "BOT_HEDERA_ACCOUNT_ID" : "BREAKER_HUMAN_ACCOUNT_ID";
  const keyVar = role === "bot" ? "BOT_PRIVATE_KEY" : "BREAKER_HUMAN_PRIVATE_KEY";
  const accountId = required(env, idVar);
  if (!/^0\.0\.\d+$/.test(accountId)) throw new Error(`${idVar} must look like 0.0.12345`);
  const raw = required(env, keyVar);
  const privateKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  return { role, accountId, privateKey, address: privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}` };
}

export function loadConfig(role: Role, env: NodeJS.ProcessEnv = process.env): BotConfig {
  return {
    gatewayUrl: (env.GATEWAY_URL ?? `http://localhost:${env.GATEWAY_PORT ?? "8787"}`).replace(/\/$/, ""),
    rpcUrl: env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET,
    mirrorNodeUrl: env.MIRROR_NODE_URL ?? MIRROR_NODE_TESTNET,
    wallet: loadWallet(role, env),
    og: {
      baseUrl: env.OG_ROUTER_BASE_URL ?? OG_ROUTER_MAINNET,
      apiKey: env.OG_API_KEY_BOT ?? "",
      model: env.BOT_MODEL ?? DEFAULT_MODEL,
    },
  };
}

/** The attacker model is needed only by `attack`; `chat` and `status` work without it. */
export function requireAttackerKey(config: BotConfig): void {
  if (!config.og.apiKey) throw new Error("Missing env OG_API_KEY_BOT (the attacker model's 0G Router key).");
}
