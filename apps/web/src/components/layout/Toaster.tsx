"use client";

import { useToasts } from "@/lib/toast";
import { CheckIcon, WarnIcon, XIcon } from "../ui/icons";
import { cx } from "../ui/primitives";

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 left-4 sm:left-auto z-50 flex flex-col gap-2 sm:w-[360px]">
      {toasts.map((t) => (
        <div key={t.id} className="flex items-center gap-3 px-4 py-3 rounded-[10px] bg-surface border border-border-strong shadow-lg text-[13px]">
          <span
            className={cx(
              "flex-none",
              t.kind === "pending" && "text-accent",
              t.kind === "success" && "text-open",
              t.kind === "error" && "text-broken-text",
            )}
          >
            {t.kind === "pending" ? (
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
            ) : t.kind === "success" ? (
              <CheckIcon size={16} />
            ) : (
              <WarnIcon size={16} />
            )}
          </span>
          <span className="flex-1 min-w-0">{t.title}</span>
          {t.href && (
            <a href={t.href} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-accent no-underline whitespace-nowrap">
              HashScan ↗
            </a>
          )}
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-faint hover:text-text bg-transparent border-0 cursor-pointer p-1">
            <XIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
