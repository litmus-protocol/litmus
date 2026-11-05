import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// SQLite through Node's built-in node:sqlite (build plan §10.2; see docs/DEVIATIONS.md P4 for why not better-sqlite3).

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface DraftRow {
  draft_id: string;
  submission_json: string;
  package_hash: string;
  canary_hash: string;
  secret_hashes_json: string;
  created_at: number;
  contest_id: number | null;
}

export type ContestStatus = "active" | "broken" | "held" | "void" | "cancelled";

export interface ContestRow {
  contest_id: number;
  draft_id: string;
  warden: string;
  card_json: string;
  package_json: string;
  invariants_json: string;
  canaries_json: string;
  start_time: number;
  end_time: number;
  message_price: string;
  status: ContestStatus;
  winner: string | null;
  broken_invariant: number | null;
  ended_at: number | null;
  final_pool: string | null;
  last_pool: string | null;
  last_vault: string | null;
  last_bond: string | null;
  secrets_json: string | null;
  log_hash: string | null;
  loaded: number;
  finalized: number;
  consecutive_failed_rounds: number;
  last_passing_round_at: number | null;
}

export type AttemptOutcome = "pending" | "charged" | "free_late" | "free_error" | "settle_failed";
export type DepositStatus = "none" | "pending" | "done" | "failed" | "refunded_direct";

export interface AttemptRow {
  attempt_id: string;
  contest_id: number;
  breaker: string;
  payer_account: string;
  text: string;
  reply: string | null;
  tool_calls_json: string | null;
  og_json: string | null;
  started_at: number;
  latency_ms: number | null;
  outcome: AttemptOutcome;
  amount: string;
  settle_tx: string | null;
  settled_at: number | null;
  deposit_status: DepositStatus;
  deposit_tx: string | null;
  deposit_tries: number;
  deposit_next_at: number | null;
  payment_id: string | null;
  refunded: number;
  refund_tx: string | null;
  broke: number;
  record_hash: string | null;
  signature: string | null;
}

export interface CanaryRoundRow {
  id: number;
  contest_id: number;
  round: number;
  started_at: number;
  results_json: string;
  failures: number;
  passed: number;
  action: "none" | "refund" | "void";
  action_tx: string | null;
  record_hash: string | null;
  signature: string | null;
}

type Params = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = new Set(
      (this.raw.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(sql);
        this.raw.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now());
        this.raw.exec("COMMIT");
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    }
  }

  all<T>(sql: string, params: Params | SQLInputValue[] = []): T[] {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  get<T>(sql: string, params: Params | SQLInputValue[] = []): T | undefined {
    const stmt = this.raw.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  run(sql: string, params: Params | SQLInputValue[] = []): { changes: number } {
    const stmt = this.raw.prepare(sql);
    const r = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(r.changes) };
  }

  close(): void {
    this.raw.close();
  }

  // ------------------------------------------------------------ contests

  contest(id: number): ContestRow | undefined {
    return this.get<ContestRow>("SELECT * FROM contests WHERE contest_id = ?", [id]);
  }

  contests(where = "1=1", params: SQLInputValue[] = []): ContestRow[] {
    return this.all<ContestRow>(`SELECT * FROM contests WHERE ${where} ORDER BY contest_id DESC`, params);
  }

  // ------------------------------------------------------------ attempts

  attempt(id: string): AttemptRow | undefined {
    return this.get<AttemptRow>("SELECT * FROM attempts WHERE attempt_id = ?", [id]);
  }

  attempts(contestId: number, extraWhere = "1=1", params: SQLInputValue[] = []): AttemptRow[] {
    return this.all<AttemptRow>(
      `SELECT * FROM attempts WHERE contest_id = ? AND ${extraWhere} ORDER BY started_at ASC, attempt_id ASC`,
      [contestId, ...params],
    );
  }

  canaryRounds(contestId: number): CanaryRoundRow[] {
    return this.all<CanaryRoundRow>("SELECT * FROM canary_rounds WHERE contest_id = ? ORDER BY round ASC", [contestId]);
  }

  /** Startup and finalizer cleanup (§10.1, §10.8 step 1): a crash leaves attempts pending forever otherwise. */
  expirePendingAttempts(olderThanMs: number | null, contestId?: number): number {
    const conds = ["outcome = 'pending'"];
    const params: SQLInputValue[] = [];
    if (olderThanMs !== null) {
      conds.push("started_at < ?");
      params.push(Date.now() - olderThanMs);
    }
    if (contestId !== undefined) {
      conds.push("contest_id = ?");
      params.push(contestId);
    }
    return this.run(`UPDATE attempts SET outcome = 'free_error' WHERE ${conds.join(" AND ")}`, params).changes;
  }
}

export function isUniqueViolation(err: unknown, index?: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(msg)) return false;
  return index ? msg.includes(index) : true;
}
