// Error codes come from the gateway (build plan §6.6) or from contract reverts (§8.4).

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FRIENDLY: Record<string, string> = {
  CONTEST_NOT_OPEN: "This contest isn't open right now.",
  ATTEMPT_IN_PROGRESS: "Send one message at a time. Wait for the reply.",
  PAYMENT_INVALID: "Payment failed. You weren't charged.",
  PAYMENT_REUSED: "That payment was already used. Try again.",
  PAYER_BLOCKED: "This wallet is blocked for this contest after repeated failed payments.",
  ECDSA_ACCOUNT_REQUIRED: "This wallet needs an ECDSA Hedera account (create one at portal.hedera.com).",
  UNSUPPORTED_ACCOUNT_KEY: "This account uses a key list or threshold key. Use an account with a single ECDSA or ED25519 key.",
  WALLET_CONNECT_CANCELLED: "Connection cancelled.",
  WALLET_REJECTED: "Rejected in your wallet. Nothing was sent.",
  WALLET_DISCONNECTED: "Your wallet session ended. Connect the wallet again.",
  RUN_FAILED: "The agent couldn't reply. You weren't charged.",
  INVALID_TEXT: "Messages must be 1 to 2000 characters.",
  INSUFFICIENT_USDC: "Not enough USDC.",
  USDC_NOT_ASSOCIATED: "USDC isn't enabled on this wallet yet.",
  NotOpen: "The contest window is closed.",
  NotActive: "This contest has already ended.",
  NoCommit: "Lock in your claim first.",
  CommitTooFresh: "Wait a few seconds for the next block, then reveal.",
  CommitExpired: "Your locked-in claim expired (30 minutes). Lock it in again.",
  TooLate: "The time to reveal claims has passed.",
  TooEarly: "This contest can't be closed yet.",
  BadReveal: "That code doesn't match. Nothing was paid.",
  WrongKind: "That rule isn't a secret rule.",
  TransferFailed: "A token transfer failed. Check that USDC is enabled on the wallet.",
};

// Codes whose underlying reason is worth showing next to the friendly text (payment failures
// come from the x402 client or the facilitator, and the generic line alone can't be debugged).
const SHOW_DETAIL = new Set(["PAYMENT_INVALID"]);

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    const friendly = FRIENDLY[err.code];
    if (!friendly) return err.message;
    const detail = err.message.trim();
    return SHOW_DETAIL.has(err.code) && detail && detail !== "Payment failed." ? `${friendly} (${detail})` : friendly;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** A definite "this doesn't exist" from the gateway (or the mock), as opposed to a failure to load it. */
export function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * Worth retrying: the gateway was unreachable, timed out or answered 5xx / 408 / 429. A 4xx is a real answer
 * (not found, not ended yet, bad input) and retrying it changes nothing.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status === undefined) return true;
  return err.status >= 500 || err.status === 408 || err.status === 429;
}
