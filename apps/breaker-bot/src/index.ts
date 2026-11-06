// Library entry for the gateway's "Run breaker bot" button; the CLI is src/main.ts.
export { hunt, HUNT_MIN_SECONDS_LEFT, type HuntOptions, type HuntResult, type RunFlags } from "./hunt";
export { loadConfig, type BotConfig } from "./config";
export type { RunSummary, Outcome } from "./attack";
