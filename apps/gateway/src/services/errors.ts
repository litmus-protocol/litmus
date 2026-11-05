export type FailureStatus = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503;

/** An API error response (§6.6): { error: { code, message } } with an HTTP status and optional headers. */
export class ApiFailure extends Error {
  constructor(
    readonly status: FailureStatus,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}
