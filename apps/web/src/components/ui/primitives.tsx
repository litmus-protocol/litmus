"use client";

import Link from "next/link";
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { formatUsdc, hashscanTx, type ContestPhase } from "@defect/shared";
import { CheckIcon, CopyIcon } from "./icons";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- buttons

type Variant = "primary" | "ghost" | "light" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  ghost: "bg-[color-mix(in_srgb,var(--text)_5%,transparent)] text-text border-border-strong hover:bg-[color-mix(in_srgb,var(--text)_9%,transparent)]",
  light: "bg-white text-[#2a0909] hover:bg-[#ffe3e3]",
  danger: "bg-broken text-white hover:opacity-90",
};
const btnBase =
  "inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-none border border-transparent text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap";

export function Button({ variant = "primary", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button type="button" className={cx(btnBase, variants[variant], className)} {...props} />;
}

export function ButtonLink({ href, variant = "primary", className, children }: { href: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cx(btnBase, variants[variant], className)}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------- surfaces

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("bg-surface border border-border rounded-none", className)}>{children}</div>;
}

export function CardHeader({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-4 border-b border-border">
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      {aside && <div className="text-xs text-faint">{aside}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- chips

const phaseStyle: Record<ContestPhase, { label: string; cls: string; dot?: boolean }> = {
  scheduled: { label: "Upcoming", cls: "text-soft bg-chip border-border-strong" },
  open: { label: "Open", cls: "text-open bg-[color-mix(in_srgb,var(--open)_10%,transparent)] border-[color-mix(in_srgb,var(--open)_30%,transparent)]", dot: true },
  awaiting_close: { label: "Closing", cls: "text-warn bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] border-[color-mix(in_srgb,var(--warn)_32%,transparent)]" },
  broken: { label: "Broken", cls: "text-broken-text bg-[color-mix(in_srgb,var(--broken)_10%,transparent)] border-[color-mix(in_srgb,var(--broken)_32%,transparent)]" },
  held: { label: "Held", cls: "text-held bg-[color-mix(in_srgb,var(--held)_10%,transparent)] border-[color-mix(in_srgb,var(--held)_30%,transparent)]" },
  void: { label: "Void", cls: "text-muted bg-raised border-border-strong" },
  cancelled: { label: "Cancelled", cls: "text-muted bg-raised border-border-strong" },
};

const chipBase = "inline-flex items-center gap-1.5 h-[22px] px-2 rounded-none text-[11px] font-semibold tracking-[.02em] border whitespace-nowrap";

export function PhaseChip({ phase }: { phase: ContestPhase }) {
  const s = phaseStyle[phase];
  return (
    <span className={cx(chipBase, s.cls)}>
      {s.dot && <span className="w-1.5 h-1.5 rounded-full bg-current pulse-dot" />}
      {s.label}
    </span>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: "neutral" | "pass" | "broken" | "held" | "warn"; children: ReactNode }) {
  const cls = {
    neutral: "text-soft bg-chip border-border-strong",
    pass: phaseStyle.open.cls,
    broken: phaseStyle.broken.cls,
    held: phaseStyle.held.cls,
    warn: phaseStyle.awaiting_close.cls,
  }[tone];
  return <span className={cx(chipBase, cls)}>{children}</span>;
}

// ---------------------------------------------------------------- data display

export function Usdc({ value, className, unit = true }: { value: string; className?: string; unit?: boolean }) {
  return (
    <span className={cx("mono", className)}>
      {formatUsdc(value)}
      {unit && <span className="ml-1 text-[0.75em] font-medium text-muted tracking-normal">USDC</span>}
    </span>
  );
}

export function HashscanLink({ tx, href, label = "HashScan ↗", className }: { tx?: string | null; href?: string; label?: string; className?: string }) {
  const url = href ?? (tx ? hashscanTx(tx) : null);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className={cx("text-xs text-muted hover:text-accent whitespace-nowrap no-underline", className)}>
      {label}
    </a>
  );
}

export function CopyText({ text, display, className }: { text: string; display?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cx("inline-flex items-center gap-1.5 mono text-xs text-soft hover:text-text cursor-pointer bg-transparent border-0 p-0", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // clipboard unavailable
        }
      }}
      aria-label={`Copy ${text}`}
    >
      {display ?? text}
      {copied ? <CheckIcon size={12} className="text-open" /> : <CopyIcon size={12} className="text-faint" />}
    </button>
  );
}

export function Stat({ label, children, align = "start" }: { label: string; children: ReactNode; align?: "start" | "end" }) {
  return (
    <div className={cx("flex flex-col gap-1", align === "end" && "items-end")}>
      <span className="eyebrow">{label}</span>
      <span className="mono text-lg font-semibold">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------- time

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function Countdown({ to, className }: { to: number; className?: string }) {
  const now = useNow();
  return <span className={cx("mono", className)}>{formatDuration(to - now)}</span>;
}

export function relativeTime(unixSeconds: number, now = Math.floor(Date.now() / 1000)) {
  const d = now - unixSeconds;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86_400)} d ago`;
}

export function hoursMinutes(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------- forms

export function Field({ label, htmlFor, help, error, children }: { label: string; htmlFor?: string; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-soft">
        {label}
      </label>
      {children}
      {error ? <span className="text-xs text-broken-text">{error}</span> : help ? <span className="text-xs text-faint leading-relaxed">{help}</span> : null}
    </div>
  );
}

export const inputCls =
  "h-11 w-full box-border bg-sunken border border-border-strong rounded-none px-3.5 text-text text-sm placeholder:text-faint focus:outline-2 focus:outline-accent focus:outline-offset-1";

export function Callout({ tone = "warn", children, icon }: { tone?: "warn" | "broken" | "neutral" | "held"; children: ReactNode; icon?: ReactNode }) {
  const cls = {
    warn: "border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_6%,transparent)] text-warn",
    broken: "border-[color-mix(in_srgb,var(--broken)_35%,transparent)] bg-[color-mix(in_srgb,var(--broken)_6%,transparent)] text-broken-text",
    held: "border-[color-mix(in_srgb,var(--held)_30%,transparent)] bg-[color-mix(in_srgb,var(--held)_6%,transparent)] text-held",
    neutral: "border-border bg-sunken text-muted",
  }[tone];
  return (
    <div role={tone === "broken" ? "alert" : undefined} className={cx("flex gap-2.5 items-start px-3.5 py-3 rounded-none border text-[13px] leading-relaxed", cls)}>
      {icon && <span className="mt-0.5 flex-none">{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}
