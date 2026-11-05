import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { fromBaseUnits, USDC_EVM_ADDRESS, USDC_TOKEN_ID, X402_NETWORK, HEDERA_TESTNET_CHAIN_ID, HASHSCAN_TESTNET, REVEAL_GRACE_SECONDS } from "@defect/shared";
import type { GatewayConfig as GatewayConfigView, Stats } from "@defect/shared";
import { verifyMessage } from "viem";
import { isEnded, type Ctx } from "./context";
import type { ContestRow } from "./db";
import { buildLog } from "./records";
import { confirmDraft, createDraft } from "./services/drafts";
import { ApiFailure } from "./services/errors";
import { handleMessage } from "./services/messages";
import { attemptView, canaryRoundView, contestDetail, contestSummary } from "./views";

/** Session headers are accepted within this many seconds of the gateway's clock (§11.3). */
export const SESSION_SKEW_SECONDS = 300;

export function sessionMessage(contestId: number, address: string, ts: number): string {
  return `Defect session access\ncontest:${contestId}\naddress:${address.toLowerCase()}\ntimestamp:${ts}`;
}

function fail(c: Context, f: ApiFailure) {
  for (const [k, v] of Object.entries(f.headers)) c.header(k, v);
  return c.json({ error: { code: f.code, message: f.message } }, f.status);
}

function contestIdParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new ApiFailure(404, "CONTEST_NOT_FOUND", "No contest with this id");
  return id;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createApp(ctx: Ctx, opts: { webOrigins: string[] }): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: opts.webOrigins,
      allowHeaders: ["Content-Type", "Authorization", "PAYMENT-SIGNATURE", "X-Defect-Address", "X-Defect-Timestamp", "X-Defect-Signature"],
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-Defect-Charged", "X-Defect-Log-Hash"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiFailure) return fail(c, err);
    ctx.log(`ERROR ${c.req.method} ${c.req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return c.json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong on the gateway." } }, 500);
  });

  const contestRow = (id: number): ContestRow => {
    const row = ctx.db.contest(id);
    if (!row) throw new ApiFailure(404, "CONTEST_NOT_FOUND", "No contest with this id");
    return row;
  };

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/config", (c) => {
    const body: GatewayConfigView = {
      network: X402_NETWORK,
      chainId: HEDERA_TESTNET_CHAIN_ID,
      arena: ctx.settings.arena,
      deployment: ctx.settings.deployment,
      usdcTokenId: USDC_TOKEN_ID,
      usdcEvm: USDC_EVM_ADDRESS,
      operatorAccountId: ctx.settings.operatorAccountId,
      windowSeconds: ctx.settings.windowSeconds,
      revealGraceSeconds: REVEAL_GRACE_SECONDS,
      canaryIntervalSec: ctx.settings.canaryIntervalSec,
      mirrorNodeUrl: ctx.settings.mirrorNodeUrl,
      hashscanBaseUrl: HASHSCAN_TESTNET,
      allowedModels: ctx.settings.allowedModels,
      attestations: ctx.settings.attestations,
    };
    return c.json(body);
  });

  app.get("/stats", (c) => {
    const contests = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contests")!.n;
    const attempts = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE outcome != 'pending'")!.n;
    let ogRequests = 0;
    let ogCost = 0n;
    for (const r of ctx.db.all<{ og_json: string | null }>("SELECT og_json FROM attempts WHERE og_json IS NOT NULL")) {
      for (const o of JSON.parse(r.og_json!) as { totalCost?: string }[]) {
        ogRequests++;
        try {
          ogCost += BigInt(o.totalCost ?? "0");
        } catch {
          // non-integer cost string; skip it in the total
        }
      }
    }
    const paid = ctx.db
      .all<{ final_pool: string | null }>("SELECT final_pool FROM contests WHERE status = 'broken'")
      .reduce((sum, r) => sum + BigInt(r.final_pool ?? "0"), 0n);
    const body: Stats = { contests, attempts, ogRequests, ogTotalCost: ogCost.toString(), paidToBreakers: fromBaseUnits(paid) };
    return c.json(body);
  });

  // ------------------------------------------------------------ Warden

  app.post("/drafts", async (c) => c.json(await createDraft(ctx, await readJson(c)), 201));

  app.post("/drafts/:draftId/confirm", async (c) => c.json(await confirmDraft(ctx, c.req.param("draftId"), await readJson(c))));

  // ------------------------------------------------------------ contests

  app.get("/contests", async (c) => {
    const status = c.req.query("status") ?? "all";
    const where =
      status === "active"
        ? "status = 'active'"
        : status === "ended"
          ? "status != 'active'"
          : status === "finalized"
            ? "finalized = 1"
            : status === "all"
              ? "1=1"
              : null;
    if (!where) throw new ApiFailure(400, "INVALID_STATUS", "status must be active, ended, finalized or all");
    const rows = ctx.db.contests(where);
    const out = await Promise.all(
      rows.map(async (r) => {
        try {
          return contestSummary(r, await ctx.state.get(r.contest_id));
        } catch (err) {
          ctx.log(`skipping contest ${r.contest_id} in list: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }),
    );
    return c.json(out.filter((x) => x !== null));
  });

  app.get("/contests/:id", async (c) => {
    const id = contestIdParam(c);
    const row = contestRow(id);
    const [s, invs] = await Promise.all([ctx.state.get(id), ctx.chain.getInvariants(id)]);
    const st = ctx.db.get<{ attempts: number; breakers: number }>(
      "SELECT COUNT(*) AS attempts, COUNT(DISTINCT breaker) AS breakers FROM attempts WHERE contest_id = ? AND outcome != 'pending'",
      [id],
    )!;
    let ogRequests = 0;
    for (const r of ctx.db.all<{ og_json: string | null }>("SELECT og_json FROM attempts WHERE contest_id = ? AND og_json IS NOT NULL", [id])) {
      ogRequests += (JSON.parse(r.og_json!) as unknown[]).length;
    }
    return c.json(contestDetail(row, s, invs, { attempts: st.attempts, breakers: st.breakers, ogRequests }, ctx.db.canaryRounds(id)));
  });

  app.post("/contests/:id/messages", async (c) => {
    const id = contestIdParam(c);
    const r = await handleMessage(ctx, id, await readJson(c), c.req.header("PAYMENT-SIGNATURE"));
    for (const [k, v] of Object.entries(r.headers)) c.header(k, v);
    return c.json(r.body, r.status);
  });

  app.get("/contests/:id/sessions/:address", async (c) => {
    const id = contestIdParam(c);
    contestRow(id);
    const address = c.req.param("address").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new ApiFailure(400, "INVALID_ADDRESS", "Address must be a 0x EVM address");
    const s = await ctx.state.get(id);
    if (!isEnded(s.phase)) await checkSessionAuth(c, ctx, id, address);
    return c.json(ctx.db.attempts(id, "breaker = ? AND outcome != 'pending'", [address]).map(attemptView));
  });

  app.get("/contests/:id/attempts", async (c) => {
    const id = contestIdParam(c);
    contestRow(id);
    const s = await ctx.state.get(id);
    if (!isEnded(s.phase)) throw new ApiFailure(403, "CONTEST_NOT_ENDED", "Transcripts are published when the contest ends");
    return c.json(ctx.db.attempts(id, "outcome != 'pending'").map(attemptView));
  });

  app.get("/contests/:id/canary-rounds", async (c) => {
    const id = contestIdParam(c);
    contestRow(id);
    const s = await ctx.state.get(id);
    return c.json(ctx.db.canaryRounds(id).map((r) => canaryRoundView(r, isEnded(s.phase))));
  });

  app.get("/contests/:id/log", (c) => {
    const id = contestIdParam(c);
    const row = contestRow(id);
    if (row.finalized !== 1) throw new ApiFailure(404, "LOG_NOT_READY", "The log is published once the contest is finalized");
    const { text, logHash } = buildLog(ctx.db.attempts(id), ctx.db.canaryRounds(id));
    c.header("X-Defect-Log-Hash", logHash);
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.body(text);
  });

  return app;
}

async function checkSessionAuth(c: Context, ctx: Ctx, contestId: number, address: string): Promise<void> {
  const hAddr = c.req.header("X-Defect-Address")?.toLowerCase();
  const hTs = c.req.header("X-Defect-Timestamp");
  const hSig = c.req.header("X-Defect-Signature");
  if (!hAddr || !hTs || !hSig) throw new ApiFailure(401, "SESSION_AUTH_REQUIRED", "Sign the session-access message to read this session");
  const ts = Number(hTs);
  if (hAddr !== address) throw new ApiFailure(403, "SESSION_FORBIDDEN", "You can only read your own session");
  if (!Number.isInteger(ts) || Math.abs(ctx.now() - ts) > SESSION_SKEW_SECONDS) {
    throw new ApiFailure(401, "SESSION_AUTH_EXPIRED", "Session signature timestamp is too old or in the future");
  }
  let ok = false;
  try {
    ok = await verifyMessage({ address: address as `0x${string}`, message: sessionMessage(contestId, address, ts), signature: hSig as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new ApiFailure(401, "SESSION_AUTH_INVALID", "Session signature does not match the address");
}
