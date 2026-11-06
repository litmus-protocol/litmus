import type { FaucetGrantStatus, FaucetResponse } from "@defect/shared";
import { api, ApiError, type Wallet } from "./api";

// "Get test funds": one button that takes a brand-new wallet (typically a Privy email login with no
// Hedera account yet) to a funded, payment-ready account:
//   1. faucet HBAR (a transfer to the EVM address creates a hollow account),
//   2. wait for the account to appear on the mirror node,
//   3. enable USDC: the account's first signed transaction, which also completes the hollow account,
//   4. faucet USDC (only sent once the account is complete and associated).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAITING: FaucetGrantStatus[] = ["needs_account", "needs_association"];

export interface TestFundsResult {
  hbar: FaucetGrantStatus;
  usdc: FaucetGrantStatus;
  /** Shown to the user when something could not be handed out. */
  note: string | null;
}

export async function getTestFunds(
  wallet: Wallet,
  deps: { refreshWallet: () => Promise<Wallet | null>; onStep: (label: string) => void },
): Promise<TestFundsResult> {
  deps.onStep("Sending test HBAR…");
  let r: FaucetResponse = await api.requestTestFunds(wallet.address);
  const hbar = r.hbar.status;

  let w: Wallet = wallet;
  if (r.usdc.status === "needs_account" || (w.kind === "privy" && !w.accountId)) {
    deps.onStep("Creating your Hedera account…");
    for (let i = 0; i < 30; i++) {
      w = (await deps.refreshWallet()) ?? w;
      if (w.accountId) break;
      await sleep(2_000);
    }
    if (!w.accountId) throw new ApiError("ACCOUNT_NOT_FOUND", "The HBAR was sent but the account hasn't appeared on the mirror node yet. Try again in a minute.");
  }

  if (WAITING.includes(r.usdc.status) || (w.kind === "privy" && !w.activated)) {
    const balances = await api.getBalances(w);
    if (!balances.usdcAssociated) {
      deps.onStep("Enabling USDC (your first signed transaction)…");
      await api.associateUsdc(w);
    } else if (w.kind === "privy" && !w.activated) {
      throw new ApiError("ACCOUNT_HOLLOW", "Your account already holds USDC but hasn't signed a transaction yet. Send any small transaction from it, then try again.");
    }
    deps.onStep("Sending test USDC…");
    // The faucet checks the mirror node, which trails consensus by a few seconds.
    for (let i = 0; i < 12; i++) {
      r = await api.requestTestFunds(w.address);
      if (!WAITING.includes(r.usdc.status)) break;
      await sleep(2_500);
    }
    w = (await deps.refreshWallet()) ?? w;
  }

  const notes: string[] = [];
  if (hbar === "unavailable") notes.push("The faucet is out of HBAR (portal.hedera.com has more).");
  if (r.usdc.status === "unavailable") notes.push("The faucet is out of USDC: get some at faucet.circle.com (Hedera Testnet).");
  if (WAITING.includes(r.usdc.status)) notes.push("USDC is enabled but the faucet hasn't seen it yet. Press the button again in a moment.");
  return { hbar, usdc: r.usdc.status, note: notes.length ? notes.join(" ") : null };
}
