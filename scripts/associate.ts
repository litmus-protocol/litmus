// Associates a Hedera account with testnet USDC so it can receive it (build plan P0 item 3).
// Usage: pnpm associate <ROLE>   e.g. pnpm associate BREAKER_HUMAN
// Reads <ROLE>_PRIVATE_KEY from the environment (never pass keys on the command line).
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { HEDERA_RPC_TESTNET, HTS_SUCCESS, HTS_TOKEN_ALREADY_ASSOCIATED, USDC_EVM_ADDRESS, hashscanTx } from "@defect/shared";

const hrc719Abi = [
  { type: "function", name: "associate", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const role = process.argv[2];
if (!role) {
  console.error("Usage: pnpm associate <ROLE>   (reads <ROLE>_PRIVATE_KEY, e.g. OPERATOR, TREASURY, WARDEN_DEMO, BREAKER_HUMAN, BOT)");
  process.exit(1);
}
const keyVar = `${role}_PRIVATE_KEY`;
const rawKey = process.env[keyVar];
if (!rawKey) {
  console.error(`${keyVar} is not set. Add it to .env (see .env.example).`);
  process.exit(1);
}
const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

const transport = http(process.env.HEDERA_RPC_URL ?? HEDERA_RPC_TESTNET);
const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: hederaTestnet, transport });
const walletClient = createWalletClient({ chain: hederaTestnet, transport, account });

const { result, request } = await publicClient.simulateContract({
  account,
  address: USDC_EVM_ADDRESS,
  abi: hrc719Abi,
  functionName: "associate",
  gas: 1_000_000n,
});

if (Number(result) === HTS_TOKEN_ALREADY_ASSOCIATED) {
  console.log(`${role} (${account.address}) is already associated with USDC. Nothing to do.`);
  process.exit(0);
}
if (Number(result) !== HTS_SUCCESS) {
  console.error(`Association would fail with Hedera response code ${result}.`);
  process.exit(1);
}

const hash = await walletClient.writeContract(request);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error(`Association transaction reverted: ${hashscanTx(hash)}`);
  process.exit(1);
}
console.log(`${role} (${account.address}) is now associated with USDC: ${hashscanTx(hash)}`);
