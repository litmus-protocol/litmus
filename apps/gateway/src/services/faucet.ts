import { fromBaseUnits, type Address, type FaucetGrant, type FaucetResponse } from "@defect/shared";
import type { Ctx } from "../context";
import type { Faucet, FaucetAccountInfo } from "../faucet";
import { ApiFailure } from "./errors";

type Asset = "hbar" | "usdc";

const DAY_SECONDS = 86_400;
/** Keep this many tinybars on the faucet for its own gas. */
const HBAR_RESERVE = 200_000_000n; // 2 HBAR

export function hbarDecimal(tinybars: bigint): string {
  const whole = tinybars / 100_000_000n;
  const frac = (tinybars % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Decimal HBAR → tinybars. */
export function parseHbar(decimal: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(decimal)) throw new Error(`Invalid HBAR amount: ${decimal}`);
  const [w, f = ""] = decimal.split(".");
  return BigInt(w!) * 100_000_000n + BigInt(f.padEnd(8, "0"));
}

function requireFaucet(ctx: Ctx): Faucet {
  if (!ctx.faucet) throw new ApiFailure(404, "FAUCET_DISABLED", "This gateway has no test-funds faucet.");
  return ctx.faucet;
}

function parseAddress(body: unknown): Address {
  const raw = (body as { address?: unknown } | undefined)?.address;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new ApiFailure(400, "INVALID_ADDRESS", "address must be a 0x EVM address");
  const address = raw.toLowerCase() as Address;
  if (/^0x0{40}$/.test(address)) throw new ApiFailure(400, "INVALID_ADDRESS", "address must not be the zero address");
  return address;
}

interface GrantRow {
  status: "pending" | "done";
  tx_hash: string | null;
  amount: string;
}

/**
 * POST /faucet: HBAR once per address (creates the account if needed), then USDC once per
 * address after the account has enabled USDC. Enabling USDC is the account's first signed
 * transaction, which also completes a hollow account. Call again after associating for the USDC.
 */
export async function handleFaucet(ctx: Ctx, body: unknown): Promise<FaucetResponse> {
  const faucet = requireFaucet(ctx);
  const address = parseAddress(body);
  let info: FaucetAccountInfo | null;
  try {
    info = await faucet.chain.account(address);
  } catch (err) {
    ctx.log(`faucet: mirror lookup failed for ${address}: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiFailure(503, "MIRROR_NODE_ERROR", "Couldn't look up the account on the Hedera mirror node. Try again.");
  }

  const hbarAmount = hbarDecimal(faucet.hbarTinybars);
  const usdcAmount = fromBaseUnits(faucet.usdcUnits);

  const hbar = await grant(ctx, faucet, address, "hbar", hbarAmount, async () => {
    if ((await faucet.chain.hbarBalance()) < faucet.hbarTinybars + HBAR_RESERVE) return null;
    return faucet.chain.sendHbar(address, faucet.hbarTinybars);
  });

  let usdc: FaucetGrant;
  const prior = existing(ctx, address, "usdc");
  if (prior) usdc = prior;
  else if (!info) usdc = { status: "needs_account", amount: usdcAmount, txHash: null };
  else if (!info.hasKey || !info.usdcAssociated) usdc = { status: "needs_association", amount: usdcAmount, txHash: null };
  else {
    usdc = await grant(ctx, faucet, address, "usdc", usdcAmount, async () => {
      if ((await faucet.chain.usdcBalance()) < faucet.usdcUnits) return null;
      return faucet.chain.sendUsdc(address, faucet.usdcUnits);
    });
  }

  return { address, accountId: info?.accountId ?? null, hbar, usdc };
}

function existing(ctx: Ctx, address: Address, asset: Asset): FaucetGrant | null {
  const row = ctx.db.get<GrantRow>("SELECT status, tx_hash, amount FROM faucet_grants WHERE address = ? AND asset = ?", [address, asset]);
  return row ? { status: "already_sent", amount: row.amount, txHash: (row.tx_hash as `0x${string}` | null) ?? null } : null;
}

async function grant(ctx: Ctx, faucet: Faucet, address: Address, asset: Asset, amount: string, send: () => Promise<`0x${string}` | null>): Promise<FaucetGrant> {
  const prior = existing(ctx, address, asset);
  if (prior) return prior;
  const since = ctx.now() - DAY_SECONDS;
  const used = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM faucet_grants WHERE created_at > ?", [since])!.n;
  if (used >= faucet.dailyCap) {
    throw new ApiFailure(429, "FAUCET_DAILY_LIMIT", "The test-funds faucet has handed out its daily limit. Try again tomorrow, or use portal.hedera.com and faucet.circle.com.");
  }
  // The primary key makes a parallel request for the same address and asset lose here.
  const inserted = ctx.db.run(
    "INSERT OR IGNORE INTO faucet_grants (address, asset, amount, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    [address, asset, amount, ctx.now()],
  );
  if (inserted.changes === 0) return existing(ctx, address, asset)!;
  let txHash: `0x${string}` | null;
  try {
    txHash = await send();
  } catch (err) {
    ctx.db.run("DELETE FROM faucet_grants WHERE address = ? AND asset = ?", [address, asset]);
    ctx.log(`faucet: ${asset} to ${address} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiFailure(502, "FAUCET_SEND_FAILED", `The faucet couldn't send ${asset.toUpperCase()}. Try again in a moment.`);
  }
  if (!txHash) {
    ctx.db.run("DELETE FROM faucet_grants WHERE address = ? AND asset = ?", [address, asset]);
    ctx.log(`faucet: out of ${asset}`);
    return { status: "unavailable", amount, txHash: null };
  }
  ctx.db.run("UPDATE faucet_grants SET status = 'done', tx_hash = ? WHERE address = ? AND asset = ?", [txHash, address, asset]);
  ctx.log(`faucet: sent ${amount} ${asset.toUpperCase()} to ${address}: ${txHash}`);
  return { status: "sent", amount, txHash };
}
