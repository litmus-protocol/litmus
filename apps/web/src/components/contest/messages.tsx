"use client";

import { shortAddress, type AttemptView, type MessageResult, type OgEvidence, type ToolCallView } from "@defect/shared";
import { LitmusMark } from "../brand/LitmusMark";
import { BanIcon, ClockIcon, HistoryIcon, SendIcon, WalletIcon } from "../ui/icons";
import { CopyText, HashscanLink, cx } from "../ui/primitives";

// Chat building blocks shared by the live chat, results and transcript views.

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

const ERROR_TEXT: Record<string, string> = {
  INSUFFICIENT_FUNDS: "not enough funds",
  RECIPIENT_CANNOT_RECEIVE_USDC: "recipient can't receive USDC",
  VAULT_CLOSED: "vault closed",
  INVALID_ARGUMENT: "invalid request",
};

function describe(call: ToolCallView): { detail: string; status: string | null; ok: boolean } {
  const args = asRec(call.args);
  const result = asRec(call.result);
  const ok = result.ok !== false;
  const status = result.ok === false ? (ERROR_TEXT[String(result.error)] ?? String(result.error ?? "failed")) : null;
  switch (call.name) {
    case "vault_balance":
      return { detail: `${result.balance ?? "?"} USDC`, status: null, ok };
    case "vault_send":
      return { detail: `${args.amount ?? "?"} USDC to ${typeof args.to === "string" ? shortAddress(args.to, 6, 4) : "?"}`, status: status ?? (ok ? "sent" : null), ok };
    case "vault_history": {
      const n = Array.isArray(result.payments) ? result.payments.length : 0;
      return { detail: `${n} recent ${n === 1 ? "payment" : "payments"}`, status: null, ok };
    }
    case "emergency_withdraw":
      return { detail: `${result.amount ?? "all"} USDC to ${typeof args.to === "string" ? shortAddress(args.to, 6, 4) : "?"}`, status: status ?? (ok ? "withdrawn" : null), ok };
  }
}

const ICONS = { vault_balance: WalletIcon, vault_send: SendIcon, vault_history: HistoryIcon, emergency_withdraw: BanIcon };

export function ToolCallCard({ call }: { call: ToolCallView }) {
  const { detail, status, ok } = describe(call);
  const Icon = ICONS[call.name];
  const moving = call.name === "vault_send" || call.name === "emergency_withdraw";
  return (
    <div
      className={cx(
        "flex items-center gap-2.5 flex-wrap px-3 py-2.5 rounded-none border text-[13px]",
        call.broke
          ? "border-broken bg-[color-mix(in_srgb,var(--broken)_8%,transparent)]"
          : moving
            ? "border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-sunken"
            : "border-border bg-sunken",
      )}
    >
      <span
        className={cx(
          "w-[26px] h-[26px] rounded-none grid place-items-center flex-none",
          call.broke ? "bg-[color-mix(in_srgb,var(--broken)_18%,transparent)] text-broken-text" : moving ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent" : "bg-chip text-soft",
        )}
      >
        <Icon size={14} />
      </span>
      <span className={cx("mono text-xs", call.broke ? "text-broken-text" : moving ? "text-accent" : "text-soft")}>{call.name}</span>
      <span className="text-faint">→</span>
      <span className="mono text-xs font-medium">{detail}</span>
      {call.broke ? (
        <span className="text-[11px] font-bold tracking-[.08em] text-broken-text">RULE BROKEN</span>
      ) : status ? (
        <span className={cx("text-xs", ok ? "text-open" : "text-warn")}>{ok ? `✓ ${status}` : status}</span>
      ) : null}
      {call.txHash && <HashscanLink tx={call.txHash} className="ml-auto" />}
    </div>
  );
}

export function Receipt({ m, price }: { m: Pick<MessageResult, "charged" | "latencyMs" | "settlement" | "og">; price: string }) {
  return (
    <div className="flex gap-3 flex-wrap items-center text-xs text-faint">
      {m.charged ? (
        <>
          <span>
            Charged <span className="mono">{price} USDC</span>
          </span>
          {m.settlement && <HashscanLink href={m.settlement.hashscan} />}
        </>
      ) : m.latencyMs > 15_000 ? (
        <span className="inline-flex items-center gap-1.5 text-warn">
          <ClockIcon size={12} />
          Not charged · slow reply <span className="mono">({(m.latencyMs / 1000).toFixed(1)} s)</span>
        </span>
      ) : (
        <span>Not charged</span>
      )}
      {m.og[0] && <OgBadge og={m.og} />}
    </div>
  );
}

// 0G has no public page per request id, so the badge carries the ids itself: hover lists every call, click copies them.
function OgBadge({ og }: { og: OgEvidence[] }) {
  const ids = og.map((o) => o.requestId);
  const tee = og.every((o) => o.teeVerified === true);
  const title = og.map((o, i) => `0G call ${i + 1}: ${o.requestId}${o.teeVerified ? " · TEE verified" : ""} · cost ${o.totalCost}`).join("\n");
  return (
    <span className="inline-flex items-center gap-1 mono text-[10px] px-1.5 py-0.5 rounded border border-border-strong text-muted" title={`${title}\n\nClick to copy`}>
      Ran on 0G · req
      <CopyText text={ids.join("\n")} display={`${ids[0]!.slice(0, 8)}${ids.length > 1 ? ` +${ids.length - 1}` : ""}`} className="text-[10px] text-muted" />
      {tee ? " · TEE ✓" : ""}
    </span>
  );
}

export function MeBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="self-end max-w-[78%] bg-me border border-me-border rounded-none px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
      {children}
    </div>
  );
}

export function AgentTurn({ m, price }: { m: MessageResult; price: string }) {
  return (
    <div className="self-start max-w-[88%] flex flex-col gap-2 min-w-0">
      {m.toolCalls.map((call, i) => (
        <ToolCallCard key={i} call={call} />
      ))}
      {m.reply && (
        <div className="bg-raised border border-border rounded-none px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">{m.reply}</div>
      )}
      <Receipt m={m} price={price} />
    </div>
  );
}

export function Exchange({ a, price }: { a: AttemptView; price: string }) {
  return (
    <>
      <MeBubble>{a.text}</MeBubble>
      <AgentTurn m={a} price={price} />
    </>
  );
}

export function ThinkingBubble({ stage }: { stage: "paying" | "thinking" }) {
  return (
    <div className="self-start flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5 bg-raised border border-border rounded-none px-3.5 py-2.5 text-muted">
        <LitmusMark mode="load" grid={64} label={stage === "paying" ? "Paying" : "Agent is thinking"} className="w-9 flex-none text-text" />
        {stage === "paying" ? "Paying…" : "Agent is thinking…"}
        <span className="mono text-[11px] text-faint">up to ~15 s</span>
      </div>
    </div>
  );
}
