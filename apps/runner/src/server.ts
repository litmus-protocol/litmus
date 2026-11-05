import { Hono, type Context } from "hono";
import {
  DraftSecretsRequestSchema,
  INVARIANT_KIND,
  LoadContestRequestSchema,
  RunRequestSchema,
  generateSecret,
  hashJson,
  secretHash,
  toBaseUnits,
  type ContestSecretsResponse,
  type DraftSecretsResponse,
  type Invariant,
  type RunnerHealth,
} from "@defect/shared";
import { timingSafeEqual } from "node:crypto";
import type { ZodError } from "zod";
import { runAgent, type AgentDeps } from "./agent";
import { PHASE, type ArenaChain, type OnchainInvariant } from "./chain";
import type { SecretMap, SecretStore } from "./secret-store";
import type { HistoryStore, PackageStore } from "./stores";

export interface ServerDeps {
  token: string;
  chain: ArenaChain;
  secrets: SecretStore;
  packages: PackageStore;
  history: HistoryStore;
  model: AgentDeps["model"];
  allowedModels: string[];
  runDelayMs?: number;
  log?: (msg: string) => void;
}

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 500;

function fail(c: Context, status: ErrStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function zodMessage(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Checks the submitted invariants against what is on chain (build plan §9.3 load, steps 3–4). Returns a mismatch reason. */
function compareInvariants(local: Invariant[], onchain: OnchainInvariant[], secrets: SecretMap): string | null {
  if (local.length !== onchain.length) return `invariant count ${local.length} != on-chain ${onchain.length}`;
  for (let i = 0; i < local.length; i++) {
    const inv = local[i]!;
    const oc = onchain[i]!;
    if (oc.kind !== INVARIANT_KIND[inv.type]) return `invariant ${i} kind differs`;
    if (inv.type === "secret") {
      const s = secrets[inv.id];
      if (!s) return `no secret generated for ${inv.id}`;
      if (secretHash(s).toLowerCase() !== oc.secretHash.toLowerCase()) return `secret hash of ${inv.id} differs`;
    }
    if (inv.type === "transfer_limit" && toBaseUnits(inv.maxAmount) !== oc.maxAmount) return `limit of ${inv.id} differs`;
  }
  return null;
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? ((m: string) => console.log(`[runner] ${m}`));

  app.use("*", async (c, next) => {
    if (!tokenOk(c.req.header("Authorization"), deps.token)) return fail(c, 401, "UNAUTHORIZED", "Missing or wrong bearer token.");
    await next();
  });

  app.onError((e, c) => {
    log(`error on ${c.req.method} ${c.req.path}: ${e.message}`);
    return fail(c, 500, "INTERNAL", "The runner hit an unexpected error.");
  });

  app.get("/internal/health", (c) => c.json({ ok: true, runner: deps.chain.runnerAddress } satisfies RunnerHealth));

  app.post("/internal/drafts/:draftId/secrets", async (c) => {
    const draftId = c.req.param("draftId");
    const parsed = DraftSecretsRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", zodMessage(parsed.error));
    const existing = deps.secrets.getDraft(draftId) ?? {};
    const next: SecretMap = { ...existing };
    for (const id of parsed.data.invariantIds) next[id] ??= generateSecret();
    if (Object.keys(next).length !== Object.keys(existing).length) deps.secrets.setDraft(draftId, next);
    const secretHashes: DraftSecretsResponse["secretHashes"] = {};
    for (const id of parsed.data.invariantIds) secretHashes[id] = secretHash(next[id]!);
    return c.json({ secretHashes } satisfies DraftSecretsResponse);
  });

  app.post("/internal/contests/:contestId/load", async (c) => {
    const contestId = Number(c.req.param("contestId"));
    if (!Number.isInteger(contestId) || contestId <= 0) return fail(c, 400, "INVALID_REQUEST", "contestId must be a positive integer.");
    const parsed = LoadContestRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", zodMessage(parsed.error));
    const { draftId, package: pkg, invariants } = parsed.data;

    if (!deps.allowedModels.includes(pkg.model))
      return fail(c, 409, "PACKAGE_MISMATCH", `Model ${pkg.model} is not allowed on this runner.`);

    const [contest, onchainInvs] = await Promise.all([deps.chain.getContest(contestId), deps.chain.getInvariants(contestId)]);
    if (contest.status === 0) return fail(c, 409, "PACKAGE_MISMATCH", `Contest ${contestId} does not exist on chain.`);
    if (hashJson(pkg).toLowerCase() !== contest.packageHash.toLowerCase()) {
      return fail(c, 409, "PACKAGE_MISMATCH", "Package hash differs from the on-chain packageHash.");
    }
    const secrets = deps.secrets.getContest(contestId) ?? deps.secrets.getDraft(draftId) ?? {};
    const mismatch = compareInvariants(invariants, onchainInvs, secrets);
    if (mismatch) return fail(c, 409, "PACKAGE_MISMATCH", `Invariants differ from chain: ${mismatch}.`);

    if (!deps.secrets.getContest(contestId)) deps.secrets.bindContest(contestId, secrets, draftId);
    deps.packages.set({ contestId, package: pkg, invariants });
    log(`loaded contest ${contestId} (${pkg.model}, ${pkg.tools.length} tools, ${Object.keys(secrets).length} secrets)`);
    return c.json({ ok: true });
  });

  app.post("/internal/run", async (c) => {
    const parsed = RunRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail(c, 400, "INVALID_REQUEST", zodMessage(parsed.error));
    const req = parsed.data;
    const loaded = deps.packages.get(req.contestId);
    const secrets = deps.secrets.getContest(req.contestId);
    if (!loaded || !secrets) return fail(c, 404, "CONTEST_NOT_LOADED", `Contest ${req.contestId} is not loaded on this runner.`);
    // Live and canary runs both need an open contest (§9.4 step 2, §9.6).
    if ((await deps.chain.phase(req.contestId)) !== PHASE.Open) {
      return fail(c, 409, "CONTEST_NOT_OPEN", `Contest ${req.contestId} is not open.`);
    }
    const result = await runAgent(req, loaded.package, secrets, {
      model: deps.model,
      chain: deps.chain,
      history: deps.history,
      runDelayMs: deps.runDelayMs,
    });
    log(
      `run ${req.mode} contest=${req.contestId} attempt=${req.attemptId} calls=${result.modelCalls} tools=${result.toolCalls.length} broke=${result.broke} ${result.durationMs}ms`,
    );
    return c.json(result);
  });

  app.get("/internal/contests/:contestId/secrets", async (c) => {
    const contestId = Number(c.req.param("contestId"));
    if (!Number.isInteger(contestId) || contestId <= 0) return fail(c, 400, "INVALID_REQUEST", "contestId must be a positive integer.");
    const p = await deps.chain.phase(contestId);
    const ended = p === PHASE.Broken || p === PHASE.Held || p === PHASE.Void || p === PHASE.Cancelled;
    if (!ended) return fail(c, 403, "CONTEST_NOT_ENDED", "Secrets are published only after the contest ends.");
    return c.json({ secrets: deps.secrets.getContest(contestId) ?? {} } satisfies ContestSecretsResponse);
  });

  return app;
}
