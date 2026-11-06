"use client";

import { shortAddress, type AttemptView, type MessageResult, type ToolCallView } from "@defect/shared";
import { BanIcon, ClockIcon, HistoryIcon, SendIcon, WalletIcon } from "../ui/icons";
import { HashscanLink, cx } from "../ui/primitives";

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
      {m.og[0] && (
        <span className="mono text-[10px] px-1.5 py-0.5 rounded border border-border-strong text-muted" title={`0G request ${m.og[0].requestId}`}>
          Ran on 0G · req {m.og[0].requestId.slice(0, 4)}…{m.og[0].teeVerified ? " · TEE ✓" : ""}
        </span>
      )}
    </div>
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
        <span className="inline-flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span className="w-1.5 h-1.5 rounded-full bg-accent opacity-60 animate-pulse" />
          <span className="w-1.5 h-1.5 rounded-full bg-accent opacity-30 animate-pulse" />
        </span>
        {stage === "paying" ? "Paying…" : "Agent is thinking…"}
        <span className="mono text-[11px] text-faint">up to ~15 s</span>
      </div>
    </div>
  );
}
