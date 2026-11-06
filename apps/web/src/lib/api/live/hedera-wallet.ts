// Chain actions for Hedera wallets connected over WalletConnect. The wallet holds the key, so
// everything is a native Hedera transaction: built and frozen here, then signed (x402) or
// signed-and-executed (contract calls, allowance, association) by the wallet. Results are read
// back from the mirror node. Loaded on demand by the live client.

import {
  AccountAllowanceApproveTransaction,
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  TokenAssociateTransaction,
  TokenId,
  TransactionId,
  TransferTransaction,
  type Transaction,
} from "@hiero-ledger/sdk";
import type { ClientHederaSigner } from "@x402/hedera";
import { HederaJsonRpcMethod, transactionToBase64String } from "@hashgraph/hedera-wallet-connect/dist/lib/shared";
import { bytesToHex, decodeErrorResult, type Abi, type Hex } from "viem";
import { hashscanTx } from "@defect/shared";
import { config } from "../../config";
import { signerFor, walletError } from "../../walletconnect";
import { ApiError } from "../errors";
import type { ConnectedWallet } from "../types";

// Hedera testnet consensus nodes. A frozen transaction names the nodes it may be submitted to.
const TESTNET_NODES = ["0.0.3", "0.0.4", "0.0.5", "0.0.6", "0.0.7", "0.0.8", "0.0.9"];
const MAX_GAS = 15_000_000n;

function pickNodes(n: number): AccountId[] {
  const shuffled = [...TESTNET_NODES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).map((id) => AccountId.fromString(id));
}

const caip = (w: ConnectedWallet) => `hedera:testnet:${w.accountId}`;

// ---------------------------------------------------------------- x402

/**
 * x402 payer backed by the wallet: same TransferTransaction as @x402/hedera's
 * createClientHederaSigner (payer → payTo token transfer, transaction id from the facilitator's
 * fee payer), but signed with `hedera_signTransaction` (sign only, never executed by the wallet).
 * The facilitator adds the fee payer signature and submits it.
 *
 * Frozen for a single node on purpose: hedera_signTransaction returns one signature over one
 * TransactionBody, and DAppSigner copies it into every node's entry, so only a one-node
 * transaction carries signatures that are all valid.
 */
export function x402Signer(w: ConnectedWallet): ClientHederaSigner {
  return {
    accountId: w.accountId,
    async createPartiallySignedTransferTransaction(requirements) {
      const feePayer = (requirements.extra as { feePayer?: unknown } | undefined)?.feePayer;
      if (typeof feePayer !== "string") throw new Error("feePayer is required in paymentRequirements.extra");
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("amount must be greater than zero");
      if (!/^\d+\.\d+\.\d+$/.test(requirements.asset)) throw new Error(`Unsupported x402 asset ${requirements.asset}`);
      const token = TokenId.fromString(requirements.asset);
      const payer = AccountId.fromString(w.accountId);
      const tx = new TransferTransaction()
        .addTokenTransfer(token, payer, -amount)
        .addTokenTransfer(token, AccountId.fromString(requirements.payTo), amount)
        .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
        .setNodeAccountIds(pickNodes(1))
        .freeze();
      const signed = await signOnly(w, tx);
      return Buffer.from(signed.toBytes()).toString("base64");
    },
  };
}

/**
 * Asks the wallet to sign a frozen transaction (`hedera_signTransaction`) and returns it with the
 * wallet's signature added. Never submits. Freeze single-node transactions only (see x402Signer).
 */
export async function signOnly<T extends Transaction>(w: ConnectedWallet, tx: T): Promise<T> {
  const signer = await signerFor(w.accountId);
  try {
    return await signer.signTransaction(tx);
  } catch (e) {
    throw walletError(e, "The wallet didn't sign the transaction.");
  }
}

export { pickNodes, contractIdOf };

// ---------------------------------------------------------------- session auth

/** Signs the session-access message with `hedera_signMessage`; returns the raw signature as hex. */
export async function signSessionMessage(w: ConnectedWallet, message: string): Promise<Hex> {
  const signer = await signerFor(w.accountId);
  try {
    const [sig] = await signer.sign([new TextEncoder().encode(message)]);
    if (!sig) throw new Error("The wallet returned no signature.");
    return bytesToHex(sig.signature);
  } catch (e) {
    throw walletError(e, "The wallet didn't sign the session message.");
  }
}

// ---------------------------------------------------------------- execution

interface MirrorTx {
  result: string;
  transaction_hash: string; // base64
  nonce?: number;
  scheduled?: boolean;
}

interface MirrorContractResult {
  result: string;
  error_message: string | null;
  block_number: number;
  hash: string;
  from: string;
  logs: { address: string; data: string; topics: string[] }[];
}

export interface WalletTxResult {
  txHash: Hex;
  hashscan: string;
  transactionId: string;
  blockNumber: bigint | null;
  logs: { address: Hex; data: Hex; topics: [Hex, ...Hex[]] }[];
  from: string | null;
}

const toMirrorId = (txId: string) => txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mirrorGet<T>(path: string, tries: number): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${config.mirrorNodeUrl}${path}`).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    if (res && res.status !== 404) throw new ApiError("MIRROR_NODE_ERROR", `Mirror node returned ${res.status}.`);
    await sleep(1_000);
  }
  throw new ApiError("TX_NOT_FOUND", "The transaction was sent but hasn't shown up on the mirror node yet. Check HashScan.");
}

/** Freezes `tx` for the wallet's account and asks the wallet to sign and submit it. */
async function signAndExecute(w: ConnectedWallet, tx: Transaction): Promise<string> {
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(w.accountId))).setNodeAccountIds(pickNodes(3)).freeze();
  const signer = await signerFor(w.accountId);
  let res: { transactionId?: string };
  try {
    res = await signer.request<{ transactionId?: string }>({
      method: HederaJsonRpcMethod.SignAndExecuteTransaction,
      params: { signerAccountId: caip(w), transactionList: transactionToBase64String(tx) },
    });
  } catch (e) {
    throw walletError(e);
  }
  return res?.transactionId ?? tx.transactionId!.toString();
}

/** Waits for consensus via the mirror node; throws on a non-SUCCESS result. */
async function settle(txId: string): Promise<{ hashHex: Hex; result: string }> {
  const id = toMirrorId(txId);
  const body = await mirrorGet<{ transactions: MirrorTx[] }>(`/api/v1/transactions/${id}`, 30);
  const t = body.transactions.find((x) => !x.scheduled && (x.nonce ?? 0) === 0) ?? body.transactions[0];
  if (!t) throw new ApiError("TX_NOT_FOUND", "Transaction not found on the mirror node.");
  const hashHex = bytesToHex(Uint8Array.from(atob(t.transaction_hash), (ch) => ch.charCodeAt(0)));
  return { hashHex, result: t.result };
}

function revertError(abi: Abi, contract: MirrorContractResult | null, result: string): ApiError {
  const data = contract?.error_message;
  if (data && /^0x[0-9a-f]{8,}$/i.test(data)) {
    try {
      const { errorName } = decodeErrorResult({ abi, data: data as Hex });
      return new ApiError(errorName, errorName);
    } catch {
      // not one of our errors
    }
  }
  return new ApiError("TX_REVERTED", `The transaction failed on chain (${result}).`);
}

const contractIds = new Map<string, ContractId>();

/** EVM address → ContractId with its entity number (the HAPI form every wallet understands). */
async function contractIdOf(address: `0x${string}`): Promise<ContractId> {
  const key = address.toLowerCase();
  const hit = contractIds.get(key);
  if (hit) return hit;
  const body = await mirrorGet<{ contract_id: string }>(`/api/v1/contracts/${key}`, 1);
  const id = ContractId.fromString(body.contract_id);
  contractIds.set(key, id);
  return id;
}

/** Native ContractCall through the wallet (msg.sender = the account's alias, or its long-zero address). */
export async function executeContract(w: ConnectedWallet, address: `0x${string}`, abi: Abi, data: Hex, gas: bigint): Promise<WalletTxResult> {
  const tx = new ContractExecuteTransaction()
    .setContractId(await contractIdOf(address))
    .setGas(Number(gas > MAX_GAS ? MAX_GAS : gas))
    .setFunctionParameters(Buffer.from(data.slice(2), "hex"));
  const txId = await signAndExecute(w, tx);
  const { hashHex, result } = await settle(txId);
  let contract: MirrorContractResult | null = null;
  try {
    contract = await mirrorGet<MirrorContractResult>(`/api/v1/contracts/results/${toMirrorId(txId)}`, 10);
  } catch {
    // a precheck-level failure has no contract result
  }
  if (result !== "SUCCESS") throw revertError(abi, contract, result);
  return {
    txHash: (contract?.hash?.slice(0, 66) as Hex | undefined) ?? hashHex,
    hashscan: hashscanTx(txId),
    transactionId: txId,
    blockNumber: contract ? BigInt(contract.block_number) : null,
    logs: (contract?.logs ?? []).map((l) => ({ address: l.address as Hex, data: (l.data || "0x") as Hex, topics: l.topics as [Hex, ...Hex[]] })),
    from: contract?.from ?? null,
  };
}

async function executeNative(w: ConnectedWallet, tx: Transaction): Promise<WalletTxResult> {
  const txId = await signAndExecute(w, tx);
  const { hashHex, result } = await settle(txId);
  if (result !== "SUCCESS" && result !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
    throw new ApiError("TX_REVERTED", `The transaction failed on chain (${result}).`);
  }
  return { txHash: hashHex, hashscan: hashscanTx(txId), transactionId: txId, blockNumber: null, logs: [], from: null };
}

/** HTS association (instead of the token facade's associate(), which wallets show as an opaque contract call). */
export function associateToken(w: ConnectedWallet, tokenId: string): Promise<WalletTxResult> {
  return executeNative(w, new TokenAssociateTransaction().setAccountId(AccountId.fromString(w.accountId)).setTokenIds([TokenId.fromString(tokenId)]));
}

/** Plain HTS token transfer from the wallet's account to another account. */
export function transferToken(w: ConnectedWallet, tokenId: string, toAccountId: string, amount: bigint): Promise<WalletTxResult> {
  const token = TokenId.fromString(tokenId);
  const tx = new TransferTransaction()
    .addTokenTransfer(token, AccountId.fromString(w.accountId), -amount)
    .addTokenTransfer(token, AccountId.fromString(toAccountId), amount);
  return executeNative(w, tx);
}

/**
 * HTS allowance for a contract spender. It is the same allowance the ERC-20 facade's
 * allowance()/transferFrom() use, so DefectArena can pull the USDC.
 */
export async function approveToken(w: ConnectedWallet, tokenId: string, spender: `0x${string}`, amount: bigint): Promise<WalletTxResult> {
  const spenderId = AccountId.fromString((await contractIdOf(spender)).toString());
  const tx = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(tokenId), AccountId.fromString(w.accountId), spenderId, amount);
  return executeNative(w, tx);
}
