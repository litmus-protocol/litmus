import { DEFAULT_MODEL, HEDERA_RPC_TESTNET, OG_ROUTER_MAINNET, parseDeploymentName, requireArenaAddress } from "@defect/shared";

export interface RunnerConfig {
  port: number;
  host: string;
  token: string;
  dataDir: string;
  secretsKey: string;
  privateKey: `0x${string}`;
  rpcUrl: string;
  arena: `0x${string}`;
  ogBaseUrl: string;
  ogApiKey: string;
  allowedModels: string[];
  fallback: { baseUrl: string; apiKey: string; model: string } | null;
  runDelayMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing env ${name}. See apps/runner/.env.example.`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const token = required(env, "RUNNER_TOKEN");
  if (token.length < 32) throw new Error("RUNNER_TOKEN must be at least 32 characters");
  const secretsKey = required(env, "RUNNER_SECRETS_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(secretsKey)) throw new Error("RUNNER_SECRETS_KEY must be 64 hex characters");
  const pk = required(env, "RUNNER_PRIVATE_KEY");
  const privateKey = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;

  const runDelayMs = Number(env.RUN_DELAY_MS ?? "0");
  if (!Number.isFinite(runDelayMs) || runDelayMs < 0) throw new Error("RUN_DELAY_MS must be a non-negative number");
  if (runDelayMs > 0 && env.NODE_ENV === "production") {
    throw new Error("RUN_DELAY_MS is test-only and must be 0 when NODE_ENV=production");
  }

  const fallback =
    env.LLM_FALLBACK_ENABLED === "true"
      ? {
          baseUrl: required(env, "LLM_FALLBACK_BASE_URL"),
          apiKey: required(env, "LLM_FALLBACK_API_KEY"),
          model: required(env, "LLM_FALLBACK_MODEL"),
        }
      : null;

  const arena = (env.ARENA_ADDRESS_OVERRIDE as `0x${string}` | undefined) ?? requireArenaAddress(parseDeploymentName(env.ARENA_DEPLOYMENT));

  return {
    port: Number(env.RUNNER_PORT ?? "8788"),
    host: env.RUNNER_HOST ?? "127.0.0.1",
    token,
    dataDir: env.RUNNER_DATA_DIR ?? "./data",
    secretsKey,
    privateKey,
    rpcUrl: env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET,
    arena,
    ogBaseUrl: env.OG_ROUTER_BASE_URL ?? OG_ROUTER_MAINNET,
    ogApiKey: required(env, "OG_API_KEY"),
    allowedModels: (env.RUNNER_ALLOWED_MODELS ?? DEFAULT_MODEL)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    fallback,
    runDelayMs,
  };
}
