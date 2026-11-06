// Hedera helpers (build plan §10.4): HashScan links and account id → EVM address lookup.
import { MIRROR_NODE_TESTNET } from "./constants";

export const HASHSCAN_TESTNET = "https://hashscan.io/testnet";

/** "0.0.X@secs.nanos" → ".../transaction/0.0.X-secs-nanos". EVM hashes pass through. */
export function hashscanTx(txId: string, base = HASHSCAN_TESTNET): string {
  const loc = txId.startsWith("0x") ? txId : txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return `${base}/transaction/${loc}`;
}

export function hashscanAccount(idOrAddress: string, base = HASHSCAN_TESTNET): string {
  return `${base}/account/${idOrAddress}`;
}

export function hashscanContract(idOrAddress: string, base = HASHSCAN_TESTNET): string {
  return `${base}/contract/${idOrAddress}`;
}

export function shortAddress(address: string, head = 4, tail = 2): string {
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export const ACCOUNT_ID_RE = /^0\.0\.\d+$/;

export class HederaAccountError extends Error {
  constructor(
    readonly code: "ACCOUNT_NOT_FOUND" | "ECDSA_ACCOUNT_REQUIRED" | "UNSUPPORTED_ACCOUNT_KEY" | "MIRROR_NODE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "HederaAccountError";
  }
}

export interface MirrorAccount {
  accountId: string;
  evmAddress: `0x${string}`;
  keyType: string | null;
  /** Hex public key from the mirror node ("key.key"); null for key lists or no key. */
  publicKey: string | null;
  hbarTinybars: bigint;
}

interface MirrorOptions {
  mirrorNodeUrl?: string;
  fetchFn?: typeof fetch;
}

/** "0.0.N" → the account's long-zero EVM address (what contracts see as msg.sender for accounts without an EVM alias). */
export function longZeroAddress(accountId: string): `0x${string}` {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(accountId);
  if (!m) return "0x" as `0x${string}`;
  const hex = (v: string, bytes: number) => BigInt(v).toString(16).padStart(bytes * 2, "0");
  return `0x${hex(m[1]!, 4)}${hex(m[2]!, 8)}${hex(m[3]!, 8)}`;
}

/**
 * Hedera account → the address DefectArena sees as msg.sender, for accounts with a single
 * ECDSA or ED25519 key (the ones a wallet can sign a session message for).
 * ECDSA accounts with an alias map to the alias; others to their long-zero address.
 */
export async function accountIdToSender(accountId: string, opts: MirrorOptions = {}): Promise<MirrorAccount> {
  const acct = await getMirrorAccount(accountId, opts);
  if (acct.keyType !== "ECDSA_SECP256K1" && acct.keyType !== "ED25519") {
    throw new HederaAccountError("UNSUPPORTED_ACCOUNT_KEY", `Account ${accountId} must use a single ECDSA or ED25519 key`);
  }
  return acct;
}

/** Reads an account from the mirror node. `idOrEvm` may be "0.0.x" or a 0x address. */
export async function getMirrorAccount(idOrEvm: string, opts: MirrorOptions = {}): Promise<MirrorAccount> {
  const base = opts.mirrorNodeUrl ?? MIRROR_NODE_TESTNET;
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${base}/api/v1/accounts/${idOrEvm}`);
  if (res.status === 404) throw new HederaAccountError("ACCOUNT_NOT_FOUND", `Hedera account ${idOrEvm} not found`);
  if (!res.ok) throw new HederaAccountError("MIRROR_NODE_ERROR", `Mirror node returned ${res.status} for ${idOrEvm}`);
  const body = (await res.json()) as {
    account: string;
    evm_address: string | null;
    key: { _type: string; key?: string } | null;
    balance?: { balance?: number | string };
  };
  return {
    accountId: body.account,
    evmAddress: (body.evm_address ?? longZeroAddress(body.account)).toLowerCase() as `0x${string}`,
    keyType: body.key?._type ?? null,
    publicKey: body.key?.key ?? null,
    hbarTinybars: BigInt(body.balance?.balance ?? 0),
  };
}

/**
 * Hedera account id → lowercased EVM address of an ECDSA account.
 * Payouts need an EVM address the account itself controls, so non-ECDSA keys are rejected.
 */
export async function accountIdToEvm(accountId: string, opts: MirrorOptions = {}): Promise<`0x${string}`> {
  const acct = await getMirrorAccount(accountId, opts);
  if (acct.keyType !== "ECDSA_SECP256K1" || !/^0x[0-9a-f]{40}$/.test(acct.evmAddress)) {
    throw new HederaAccountError("ECDSA_ACCOUNT_REQUIRED", `Account ${accountId} must use an ECDSA (secp256k1) key`);
  }
  return acct.evmAddress;
}

/** EVM address → Hedera account id ("0.0.x"). */
export async function evmToAccountId(evmAddress: string, opts: MirrorOptions = {}): Promise<string> {
  return (await getMirrorAccount(evmAddress.toLowerCase(), opts)).accountId;
}

/** USDC balance in base units, or null when the account is not associated with the token. */
export async function getTokenBalance(accountId: string, tokenId: string, opts: MirrorOptions = {}): Promise<bigint | null> {
  const base = opts.mirrorNodeUrl ?? MIRROR_NODE_TESTNET;
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(`${base}/api/v1/accounts/${accountId}/tokens?token.id=${tokenId}`);
  if (!res.ok) throw new HederaAccountError("MIRROR_NODE_ERROR", `Mirror node returned ${res.status} for ${accountId} tokens`);
  const body = (await res.json()) as { tokens: { token_id: string; balance: number | string }[] };
  const entry = body.tokens.find((t) => t.token_id === tokenId);
  return entry ? BigInt(entry.balance) : null;
}
