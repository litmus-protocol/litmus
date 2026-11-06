"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_MESSAGE_CHARS, type AttemptView, type ContestDetail, type MessageResult } from "@defect/shared";
import { api, friendlyError } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { ChatIcon, WalletIcon, WarnIcon } from "../ui/icons";
import { Button, Callout, Skeleton } from "../ui/primitives";
import { Exchange, MeBubble, ThinkingBubble } from "./messages";

interface Pending {
  text: string;
  stage: "paying" | "thinking";
}

export function ChatPanel({ c }: { c: ContestDetail }) {
  const { wallet, openDrawer, refreshBalances } = useWallet();
  const session = useSession(c.contestId, wallet);
  const qc = useQueryClient();
  const [local, setLocal] = useState<AttemptView[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLocal([]), [session.data]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [local.length, pending, session.data?.length]);

  if (!wallet) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-10 min-h-[320px]">
        <WalletIcon size={28} className="text-faint" />
        <span className="font-semibold">Connect a wallet to start breaking</span>
        <span className="text-[13px] text-muted max-w-[320px]">Every message costs {c.messagePrice} USDC, paid from your wallet. Slow replies are free.</span>
        <Button onClick={openDrawer}>Connect wallet</Button>
      </div>
    );
  }

  const history = [...(session.data ?? []), ...local];

  async function send() {
    const msg = text.trim();
    if (!msg || pending || !wallet) return;
    setError(null);
    setPending({ text: msg, stage: "paying" });
    setText("");
    const t = setTimeout(() => setPending((p) => (p ? { ...p, stage: "thinking" } : p)), 900);
    try {
      const result: MessageResult = await api.sendMessage(c.contestId, msg, wallet);
      const attempt: AttemptView = {
        ...result,
        contestId: c.contestId,
        breaker: wallet.address,
        text: msg,
        startedAt: Date.now(),
        outcome: result.charged ? "charged" : "free_late",
      };
      setLocal((l) => [...l, attempt]);
      refreshBalances();
      void qc.invalidateQueries({ queryKey: ["contest", c.contestId] });
      if (result.contestBroken) void qc.invalidateQueries({ queryKey: ["contests"] });
    } catch (e) {
      setError(friendlyError(e));
      setText(msg);
    } finally {
      clearTimeout(t);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-4 py-2 text-xs text-faint border-b border-border">Your conversation is private until the validation ends.</div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto bg-sunken">
        {/* Messages sit at the bottom, next to the input, and grow upward like a messaging app. */}
        <div className="min-h-full p-5 flex flex-col justify-end gap-[18px]">
        {session.isLoading ? (
          <>
            <Skeleton className="h-10 w-2/3 self-end" />
            <Skeleton className="h-14 w-3/4" />
          </>
        ) : history.length === 0 && !pending ? (
          <div className="my-auto flex flex-col items-center gap-2 text-center text-muted">
            <ChatIcon size={28} className="text-faint" />
            <span className="text-[13px] leading-relaxed">
              Say something to the agent.
              <br />
              Every message costs <span className="mono text-text">{c.messagePrice} USDC</span>.
            </span>
          </div>
        ) : (
          history.map((m) => <Exchange key={m.attemptId} a={m} price={c.messagePrice} />)
        )}
        {pending && (
          <>
            <MeBubble>{pending.text}</MeBubble>
            <ThinkingBubble stage={pending.stage} />
          </>
        )}
        </div>
      </div>
      <form
        className="border-t border-border p-3.5 flex flex-col gap-2.5 bg-surface"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {error && (
          <Callout tone="broken" icon={<WarnIcon size={14} />}>
            {error}
          </Callout>
        )}
        <label htmlFor="msg" className="sr-only">
          Message to {c.card.name}
        </label>
        <textarea
          id="msg"
          rows={2}
          maxLength={MAX_MESSAGE_CHARS}
          value={text}
          disabled={!!pending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Say something to the agent…"
          className="resize-none w-full box-border bg-sunken border border-border-strong rounded-none px-3.5 py-3 text-text text-sm placeholder:text-faint"
        />
        <div className="flex justify-between items-center gap-3 flex-wrap">
          <span className="text-xs text-faint">One message at a time. Slow replies aren&apos;t charged.</span>
          <Button type="submit" disabled={!!pending || !text.trim()}>
            Send · <span className="mono">{c.messagePrice} USDC</span>
          </Button>
        </div>
      </form>
    </div>
  );
}
