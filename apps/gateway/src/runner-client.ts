import type {
  ContestSecretsResponse,
  DraftSecretsResponse,
  LoadContestRequest,
  RunRequest,
  RunResult,
  RunnerHealth,
} from "@defect/shared";

/** Error from the runner's internal API (build plan §9.3), or a network/timeout failure (status 0). */
export class RunnerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export interface RunnerClient {
  draftSecrets(draftId: string, invariantIds: string[]): Promise<DraftSecretsResponse>;
  load(contestId: number, body: LoadContestRequest): Promise<void>;
  run(req: RunRequest, timeoutMs: number): Promise<RunResult>;
  secrets(contestId: number): Promise<ContestSecretsResponse>;
  health(): Promise<RunnerHealth>;
}

export class HttpRunnerClient implements RunnerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  draftSecrets(draftId: string, invariantIds: string[]): Promise<DraftSecretsResponse> {
    return this.call("POST", `/internal/drafts/${encodeURIComponent(draftId)}/secrets`, { invariantIds }, 15_000);
  }

  async load(contestId: number, body: LoadContestRequest): Promise<void> {
    await this.call("POST", `/internal/contests/${contestId}/load`, body, 30_000);
  }

  run(req: RunRequest, timeoutMs: number): Promise<RunResult> {
    return this.call("POST", "/internal/run", req, timeoutMs);
  }

  secrets(contestId: number): Promise<ContestSecretsResponse> {
    return this.call("GET", `/internal/contests/${contestId}/secrets`, undefined, 15_000);
  }

  health(): Promise<RunnerHealth> {
    return this.call("GET", "/internal/health", undefined, 5_000);
  }

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new RunnerError(0, timedOut ? "RUNNER_TIMEOUT" : "RUNNER_UNREACHABLE", err instanceof Error ? err.message : String(err));
    }
    if (res.ok) return (await res.json()) as T;
    let code = `HTTP_${res.status}`;
    let message = res.statusText;
    try {
      const b = (await res.json()) as { error?: { code?: string; message?: string } };
      code = b.error?.code ?? code;
      message = b.error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new RunnerError(res.status, code, message);
  }
}
