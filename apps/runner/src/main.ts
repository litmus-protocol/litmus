import { serve } from "@hono/node-server";
import { join } from "node:path";
import { ViemArenaChain } from "./chain";
import { loadConfig } from "./config";
import { FallbackClient, OpenAiCompatibleClient, isZeroGEndpoint, type ModelClient } from "./llm";
import { SecretStore } from "./secret-store";
import { createApp } from "./server";
import { HistoryStore, PackageStore } from "./stores";
import { ModelCatalog } from "@defect/shared";

const config = loadConfig();
const chain = new ViemArenaChain({ arena: config.arena, privateKey: config.privateKey, rpcUrl: config.rpcUrl });

let model: ModelClient = new OpenAiCompatibleClient(config.ogBaseUrl, config.ogApiKey, { zeroGExtras: isZeroGEndpoint(config.ogBaseUrl) });
if (config.fallback) {
  const fb = new OpenAiCompatibleClient(config.fallback.baseUrl, config.fallback.apiKey, { zeroGExtras: false });
  model = new FallbackClient(model, fb, config.fallback.model);
}

const app = createApp({
  token: config.token,
  chain,
  secrets: new SecretStore(join(config.dataDir, "secrets.enc"), config.secretsKey),
  packages: new PackageStore(config.dataDir),
  history: new HistoryStore(config.dataDir),
  model,
  allowedModels: config.allowedModels,
  // Live 0G catalog only when the model endpoint is the 0G Router (a local dev model uses RUNNER_ALLOWED_MODELS).
  catalog: new ModelCatalog({
    baseUrl: isZeroGEndpoint(config.ogBaseUrl) && !/^(0|false|off|no)$/i.test(process.env.OG_CATALOG ?? "") ? config.ogBaseUrl : null,
    fallbackModels: config.allowedModels,
    log: (m) => console.log(`[runner] ${m}`),
  }),
  runDelayMs: config.runDelayMs,
});

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    `[runner] listening on http://${config.host}:${info.port} · runner ${chain.runnerAddress} · arena ${config.arena} · model endpoint ${config.ogBaseUrl}`,
  );
});
