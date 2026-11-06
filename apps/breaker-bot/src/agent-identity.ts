import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  HEDERA_TESTNET_CHAIN_ID,
  agentRegistryId,
  buildAgentCard,
  getErc8004Addresses,
  hashscanTx,
  identityRegistryAbi,
  toJsonDataUri,
  type Erc8004AgentCard,
} from "@defect/shared";
import type { BotConfig } from "./config";

// ERC-8004 identity for the breaker bot: register once, then send `X-Agent-Id` with every message so the
// gateway links the bot's attempts to its agent id (and its reputation).

// Hedera gas estimates are unreliable, so use a generous fixed limit.
const GAS = 1_500_000n;

export function botAgentCard(
  _config: BotConfig,
  siteUrl: string,
  registration?: { agentId: number; agentRegistry: string },
): Erc8004AgentCard {
  return buildAgentCard({
    name: "Defect Breaker Bot",
    description:
      "An autonomous red-team agent. It pays per message over x402 on Hedera and earns bounties when it breaks an agent's rules in a Defect contest.",
    siteUrl,
    x402Support: true,
    registration,
  });
}

/** The slice of the viem clients that registration needs, so a test can inject fakes. */
export interface AgentClients {
  identity: `0x${string}`;
  walletClient: {
    writeContract(req: { address: `0x${string}`; abi: typeof identityRegistryAbi; functionName: "register" | "setAgentURI"; args: readonly unknown[]; gas: bigint }): Promise<Hex>;
  };
  publicClient: {
    waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted"; logs: Log[] }>;
  };
}

function liveClients(config: BotConfig): AgentClients {
  const addresses = getErc8004Addresses();
  if (!addresses) {
    throw new Error("ERC-8004 registries are not deployed (packages/shared/src/deployments.json has no hederaTestnet.erc8004)");
  }
  const chain = defineChain({
    id: HEDERA_TESTNET_CHAIN_ID,
    name: "Hedera Testnet",
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const account = privateKeyToAccount(config.wallet.privateKey);
  return {
    identity: addresses.identity,
    publicClient: createPublicClient({ chain, transport: http(config.rpcUrl) }) as unknown as AgentClients["publicClient"],
    walletClient: createWalletClient({ chain, account, transport: http(config.rpcUrl) }) as unknown as AgentClients["walletClient"],
  };
}

/**
 * Registers the bot as an ERC-8004 agent. `register(uri)` makes the bot's EVM address the agent wallet.
 * The agent id is only known after registering, so the card is first stored without `registrations`
 * and then updated with the registration via `setAgentURI`.
 */
export async function registerBotAgent(
  config: BotConfig,
  siteUrl: string,
  clients?: AgentClients,
  log: (line: string) => void = console.log,
): Promise<{ agentId: number; txs: Hex[] }> {
  const { identity, walletClient, publicClient } = clients ?? liveClients(config);

  const registerTx = await walletClient.writeContract({
    address: identity,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [toJsonDataUri(botAgentCard(config, siteUrl)).uri],
    gas: GAS,
  });
  const registerReceipt = await publicClient.waitForTransactionReceipt({ hash: registerTx });
  if (registerReceipt.status !== "success") throw new Error(`register reverted (${hashscanTx(registerTx)})`);
  const event = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs: registerReceipt.logs })[0];
  if (!event) throw new Error(`register succeeded but emitted no Registered event (${hashscanTx(registerTx)})`);
  const agentId = Number(event.args.agentId);
  if (!Number.isSafeInteger(agentId)) throw new Error(`Registered agent id ${event.args.agentId} is not a safe integer`);

  const card = botAgentCard(config, siteUrl, { agentId, agentRegistry: agentRegistryId(HEDERA_TESTNET_CHAIN_ID, identity) });
  const updateTx = await walletClient.writeContract({
    address: identity,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: [BigInt(agentId), toJsonDataUri(card).uri],
    gas: GAS,
  });
  const updateReceipt = await publicClient.waitForTransactionReceipt({ hash: updateTx });
  if (updateReceipt.status !== "success") {
    throw new Error(`setAgentURI reverted (${hashscanTx(updateTx)}). The bot is registered as agent ${agentId}; set BOT_AGENT_ID=${agentId}.`);
  }

  log(`BOT_AGENT_ID=${agentId}`);
  log(`register: ${hashscanTx(registerTx)}`);
  log(`setAgentURI: ${hashscanTx(updateTx)}`);
  return { agentId, txs: [registerTx, updateTx] };
}
