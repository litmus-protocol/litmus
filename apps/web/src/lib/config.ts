// All runtime configuration comes from env vars, so switching from mock data to
// the real backend is a config change only (see apps/web/.env.example).

export type DataMode = "mock" | "live";

const mode = (process.env.NEXT_PUBLIC_DATA_MODE ?? "mock").trim();

export const config = {
  dataMode: (mode === "live" ? "live" : "mock") as DataMode,
  gatewayUrl: (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787").replace(/\/$/, ""),
  hederaRpcUrl: process.env.NEXT_PUBLIC_HEDERA_RPC_URL ?? "https://testnet.hashio.io/api",
  mirrorNodeUrl: (process.env.NEXT_PUBLIC_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, ""),
  /** Reown (WalletConnect) Cloud project id from dashboard.reown.com; empty disables "Connect wallet" in live mode. */
  walletConnectProjectId: (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "").trim(),
  sepoliaRpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
};
