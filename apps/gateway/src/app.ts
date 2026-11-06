import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ACCOUNT_ID_RE, verifyHederaMessage, FEE_SPLIT_BPS, fromBaseUnits, sessionMessage, toBaseUnits, USDC_EVM_ADDRESS, USDC_TOKEN_ID, X402_NETWORK, HEDERA_TESTNET_CHAIN_ID, HASHSCAN_TESTNET, REVEAL_GRACE_SECONDS } from "@defect/shared";
import type { GatewayConfig as GatewayConfigView, Stats } from "@defect/shared";
import { verifyMessage } from "viem";
import { isEnded, type Ctx } from "./context";
import type { ContestRow } from "./db";
import { buildLog } from "./records";
import { confirmDraft, createDraft } from "./services/drafts";
import { agentProfile } from "./services/agents";
import { ApiFailure } from "./services/errors";
import { handleFaucet, hbarDecimal } from "./services/faucet";
import { handleMessage } from "./services/messages";
import { attemptView, canaryRoundView, contestDetail, contestSummary, type EndBalances } from "./views";

/** Session headers are accepted within this many seconds of the gateway's clock (§11.3). */
export const SESSION_SKEW_SECONDS = 300;

export { sessionMessage };

function fail(c: Context, f: ApiFailure) {
  for (const [k, v] of Object.entries(f.headers)) c.header(k, v);
  return c.json({ error: { code: f.code, message: f.message } }, f.status);
}

function contestIdParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new ApiFailure(404, "CONTEST_NOT_FOUND", "No contest with this id");
  return id;
}

/**
 * The caller's IP: `proxyHops` entries from the right of X-Forwarded-For when the gateway sits behind
 * that many proxies (each appends the address it saw, so the left part is whatever the client sent),
 * else the socket address. null when neither is known.
 */
export function clientIp(c: Context, proxyHops: number): string | null {
  if (proxyHops > 0) {
    const hops = (c.req.header("X-Forwarded-For") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return hops[hops.length - proxyHops] ?? null;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // not served by @hono/node-server (tests)
  }
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
      // @x402/fetch also sets an "Access-Control-Expose-Headers" request header on the paid retry;
      // without allowing it the browser's preflight fails and the payment never reaches us.
      allowHeaders: ["Content-Type", "Authorization", "PAYMENT-SIGNATURE", "Access-Control-Expose-Headers", "X-Defect-Address", "X-Defect-Timestamp", "X-Defect-Signature", "X-Defect-Account", "X-Agent-Id"],
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

  app.get("/config", async (c) => {
    const catalog = await ctx.catalog.get();
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
      allowedModels: catalog.models.map((m) => m.id),
      models: catalog.models,
      modelCatalog: catalog.source,
      attestations: ctx.settings.attestations,
      certificate: ctx.settings.certificate,
      faucet: ctx.faucet ? { hbar: hbarDecimal(ctx.faucet.hbarTinybars), usdc: fromBaseUnits(ctx.faucet.usdcUnits), loginRequired: ctx.faucet.privy !== null } : null,
      erc8004: ctx.settings.erc8004,
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

  // ------------------------------------------------------------ test funds

  app.post("/faucet", async (c) =>
    c.json(await handleFaucet(ctx, await readJson(c), { ip: clientIp(c, ctx.faucet?.proxyHops ?? 0), authorization: c.req.header("Authorization") })),
  );

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
    const end = isEnded(s.phase) ? endBalances(ctx, row) : undefined;
    return c.json(contestDetail(row, s, invs, { attempts: st.attempts, breakers: st.breakers, ogRequests }, ctx.db.canaryRounds(id), end, ctx.settings.certificate, ctx.settings.erc8004));
  });

  app.get("/agents/:agentId", async (c) => {
    const raw = c.req.param("agentId");
    if (!/^\d{1,15}$/.test(raw)) throw new ApiFailure(400, "INVALID_AGENT_ID", "Agent id must be a whole number");
    return c.json(await agentProfile(ctx, Number(raw)));
  });

  app.post("/contests/:id/messages", async (c) => {
    const id = contestIdParam(c);
    const r = await handleMessage(ctx, id, await readJson(c), c.req.header("PAYMENT-SIGNATURE"), c.req.header("X-Agent-Id"));
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

/** What the contract held for an ended contest just before it zeroed vault, bond and escrow. */
function endBalances(ctx: Ctx, row: ContestRow): EndBalances {
  let escrow = 0n;
  for (const a of ctx.db.all<{ amount: string }>(
    "SELECT amount FROM attempts WHERE contest_id = ? AND outcome = 'charged' AND deposit_status = 'done' AND refunded = 0",
    [row.contest_id],
  )) {
    const amount = BigInt(a.amount);
    escrow += amount - (amount * BigInt(FEE_SPLIT_BPS.pool)) / 10_000n - (amount * BigInt(FEE_SPLIT_BPS.arena)) / 10_000n;
  }
  let bond = row.last_bond !== null ? BigInt(row.last_bond) : 0n;
  if (row.last_bond === null) {
    const draft = ctx.db.get<{ submission_json: string }>("SELECT submission_json FROM drafts WHERE draft_id = ?", [row.draft_id]);
    if (draft) bond = toBaseUnits((JSON.parse(draft.submission_json) as { bond: string }).bond);
  }
  return { vault: row.last_vault !== null ? BigInt(row.last_vault) : 0n, bond, escrow };
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
  const message = sessionMessage(contestId, address, ts);
  const hAccount = c.req.header("X-Defect-Account");
  let ok = false;
  if (hAccount) {
    // Hedera wallet (WalletConnect `hedera_signMessage`): check the account maps to this address
    // and the signature verifies against the account's current key on the mirror node.
    if (!ACCOUNT_ID_RE.test(hAccount)) throw new ApiFailure(400, "INVALID_ADDRESS", "X-Defect-Account must look like 0.0.x");
    let key;
    try {
      key = await ctx.accounts.key(hAccount);
    } catch {
      throw new ApiFailure(401, "SESSION_AUTH_INVALID", `Couldn't read the key of account ${hAccount}`);
    }
    if (key.evmAddress.toLowerCase() !== address) throw new ApiFailure(403, "SESSION_FORBIDDEN", "That account does not own this address");
    ok = verifyHederaMessage(message, hSig, key);
  } else {
    try {
      ok = await verifyMessage({ address: address as `0x${string}`, message, signature: hSig as `0x${string}` });
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new ApiFailure(401, "SESSION_AUTH_INVALID", "Session signature does not match the address");
}
