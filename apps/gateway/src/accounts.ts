import { HederaAccountError, accountIdToSender, type MirrorAccount } from "@defect/shared";
import type { Db } from "./db";

export interface AccountKey {
  evmAddress: `0x${string}`;
  keyType: "ED25519" | "ECDSA_SECP256K1";
  /** Hex public key as the mirror node reports it (raw or DER-encoded). */
  publicKey: string;
}

/**
 * Hedera account id → the EVM address DefectArena sees as msg.sender (§10.4), cached in
 * account_map. ECDSA accounts with an alias map to the alias; ED25519 (and alias-less) accounts
 * to their long-zero address, which is what a native ContractCall from a Hedera wallet uses.
 */
export interface AccountResolver {
  toEvm(accountId: string): Promise<`0x${string}`>;
  /** Current key of a single-key account, for verifying `hedera_signMessage` signatures. Not cached. */
  key(accountId: string): Promise<AccountKey>;
}

export class MirrorAccountResolver implements AccountResolver {
  constructor(
    private readonly db: Db,
    private readonly mirrorNodeUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async toEvm(accountId: string): Promise<`0x${string}`> {
    const hit = this.db.get<{ evm_address: string }>("SELECT evm_address FROM account_map WHERE account_id = ?", [accountId]);
    if (hit) return hit.evm_address as `0x${string}`;
    const { evmAddress: evm } = await this.lookup(accountId);
    this.db.run("INSERT OR REPLACE INTO account_map (account_id, evm_address, fetched_at) VALUES (?, ?, ?)", [accountId, evm, Date.now()]);
    return evm;
  }

  async key(accountId: string): Promise<AccountKey> {
    const acct = await this.lookup(accountId);
    if (!acct.publicKey) throw new HederaAccountError("UNSUPPORTED_ACCOUNT_KEY", `Account ${accountId} has no single public key`);
    return { evmAddress: acct.evmAddress, keyType: acct.keyType as AccountKey["keyType"], publicKey: acct.publicKey };
  }

  private lookup(accountId: string): Promise<MirrorAccount> {
    return accountIdToSender(accountId, { mirrorNodeUrl: this.mirrorNodeUrl, fetchFn: this.fetchFn });
  }
}

export { HederaAccountError };
