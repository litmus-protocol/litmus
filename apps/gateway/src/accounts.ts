import { HederaAccountError, accountIdToEvm } from "@defect/shared";
import type { Db } from "./db";

/** Hedera account id → EVM address of an ECDSA account, cached in account_map (§10.4). */
export interface AccountResolver {
  toEvm(accountId: string): Promise<`0x${string}`>;
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
    const evm = await accountIdToEvm(accountId, { mirrorNodeUrl: this.mirrorNodeUrl, fetchFn: this.fetchFn });
    this.db.run("INSERT OR REPLACE INTO account_map (account_id, evm_address, fetched_at) VALUES (?, ?, ?)", [accountId, evm, Date.now()]);
    return evm;
  }
}

export { HederaAccountError };
