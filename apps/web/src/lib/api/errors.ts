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

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) return FRIENDLY[err.code] ?? err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
