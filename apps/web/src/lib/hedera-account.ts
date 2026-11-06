import { USDC_TOKEN_ID, fromBaseUnits, longZeroAddress } from "@defect/shared";
import { config } from "./config";
import { ApiError } from "./api/errors";
import type { Balances, ConnectedWallet, PrivyWallet } from "./api/types";

export interface MirrorKeyInfo {
  accountId: string;
  /** What DefectArena sees as msg.sender for a native call: the EVM alias, else the long-zero address. */
  address: `0x${string}`;
  keyType: "ED25519" | "ECDSA_SECP256K1";
  publicKey: string;
}

/** Reads a testnet account's sender address and single public key from the mirror node. */
export async function mirrorAccountKey(accountId: string): Promise<MirrorKeyInfo> {
  const res = await fetch(`${config.mirrorNodeUrl}/api/v1/accounts/${accountId}`);
  if (res.status === 404) throw new ApiError("ACCOUNT_NOT_FOUND", `Account ${accountId} isn't on Hedera testnet. Switch the wallet to testnet.`);
  if (!res.ok) throw new ApiError("MIRROR_NODE_ERROR", "Couldn't look up the account on the Hedera mirror node.");
  const body = (await res.json()) as { account: string; evm_address: string | null; key?: { _type?: string; key?: string } | null };
  const keyType = body.key?._type;
  if ((keyType !== "ED25519" && keyType !== "ECDSA_SECP256K1") || !body.key?.key) {
    throw new ApiError("UNSUPPORTED_ACCOUNT_KEY", "This account uses a key list or threshold key; connect an account with a single key.");
  }
  const address = (body.evm_address ?? longZeroAddress(body.account)).toLowerCase() as `0x${string}`;
  return { accountId: body.account, address, keyType, publicKey: body.key.key };
}

/** A WalletConnect-shared account as the app uses it (always real mirror data, in mock mode too). */
export async function resolveHederaAccount(accountId: string, walletName: string): Promise<ConnectedWallet> {
  const k = await mirrorAccountKey(accountId);
  return { kind: "walletconnect", walletName, keyType: k.keyType, accountId: k.accountId, address: k.address };
}

/**
 * A Privy embedded wallet's Hedera account, looked up by its EVM address (the ECDSA alias).
 * No account yet → accountId "". Hollow (created by a transfer, no key yet) → activated false.
 */
export async function resolvePrivyAccount(address: `0x${string}`, label: string): Promise<PrivyWallet> {
  const addr = address.toLowerCase() as `0x${string}`;
  const res = await fetch(`${config.mirrorNodeUrl}/api/v1/accounts/${addr}`);
  if (res.status === 404) return { kind: "privy", label, address: addr, accountId: "", activated: false };
  if (!res.ok) throw new ApiError("MIRROR_NODE_ERROR", "Couldn't look up the account on the Hedera mirror node.");
  const body = (await res.json()) as { account: string; key?: { _type?: string; key?: string } | null };
  if (body.key?.key && body.key._type !== "ECDSA_SECP256K1") throw new ApiError("ECDSA_ACCOUNT_REQUIRED", "This address belongs to an account with a different key type.");
  return { kind: "privy", label, address: addr, accountId: body.account, activated: !!body.key?.key };
}

/** HBAR and USDC straight from the mirror node (used for real wallets in mock data mode, where there is no gateway). */
export async function mirrorBalances(accountId: string): Promise<Balances> {
  const [acct, tokens] = await Promise.all([
    fetch(`${config.mirrorNodeUrl}/api/v1/accounts/${accountId}`).then((r) => (r.ok ? r.json() : null)) as Promise<{ balance?: { balance?: number } } | null>,
    fetch(`${config.mirrorNodeUrl}/api/v1/accounts/${accountId}/tokens?token.id=${USDC_TOKEN_ID}`).then((r) => (r.ok ? r.json() : null)) as Promise<{
      tokens: { token_id: string; balance: number | string }[];
    } | null>,
  ]);
  const usdc = tokens?.tokens.find((t) => t.token_id === USDC_TOKEN_ID);
  return {
    hbar: ((acct?.balance?.balance ?? 0) / 1e8).toFixed(2),
    usdc: fromBaseUnits(BigInt(usdc?.balance ?? 0)),
    usdcAssociated: !!usdc,
    withdrawable: "0",
  };
}
