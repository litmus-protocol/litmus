import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentPackage, Invariant } from "@defect/shared";

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export interface LoadedContest {
  contestId: number;
  package: AgentPackage;
  invariants: Invariant[];
}

/** Loaded packages, kept in memory and on disk at ${dataDir}/packages/${id}.json (build plan §9.3). */
export class PackageStore {
  private readonly cache = new Map<number, LoadedContest>();
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "packages");
    mkdirSync(this.dir, { recursive: true });
  }

  get(contestId: number): LoadedContest | undefined {
    const hit = this.cache.get(contestId);
    if (hit) return hit;
    const file = join(this.dir, `${contestId}.json`);
    if (!existsSync(file)) return undefined;
    const loaded = JSON.parse(readFileSync(file, "utf8")) as LoadedContest;
    this.cache.set(contestId, loaded);
    return loaded;
  }

  set(contest: LoadedContest): void {
    writeJsonAtomic(join(this.dir, `${contest.contestId}.json`), contest);
    this.cache.set(contest.contestId, contest);
  }
}

export interface HistoryEntry {
  to: string;
  amount: string;
  time: number;
  kind: "send" | "emergency_withdraw";
}

/** Vault payments the runner made, per contest, at ${dataDir}/history/${id}.json. Newest last on disk. */
export class HistoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "history");
    mkdirSync(this.dir, { recursive: true });
  }

  private file(contestId: number): string {
    return join(this.dir, `${contestId}.json`);
  }

  list(contestId: number): HistoryEntry[] {
    const f = this.file(contestId);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as HistoryEntry[]) : [];
  }

  append(contestId: number, entry: HistoryEntry): void {
    writeJsonAtomic(this.file(contestId), [...this.list(contestId), entry]);
  }
}
