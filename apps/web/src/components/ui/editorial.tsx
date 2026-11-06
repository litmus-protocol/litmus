"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "./primitives";
import { Rise } from "./motion";

/* ===========================================================================
   Editorial primitives shared by the home page and the content pages:
   page width, display type, numbered section labels, scroll reveal and the
   square call-to-action buttons.
=========================================================================== */

export const WRAP = "mx-auto w-full max-w-[1320px] px-4 sm:px-6";
export const H2 = "m-0 text-[clamp(2.25rem,4.6vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.035em] text-text";
export const LEDE = "m-0 text-[clamp(1.05rem,1.2vw,1.25rem)] leading-[1.55] text-text/75";

export function useInView<T extends Element>(threshold = 0.18) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, inView] as const;
}

/** Kept as the shared name for "animate in on scroll"; the motion itself lives in ./motion. */
export const Reveal = Rise;

/** Section label: a numbered eyebrow on a hairline, like a magazine folio. */
export function Folio({ n, label, inverse }: { n: string; label: string; inverse?: boolean }) {
  return (
    <div className={cx("flex items-center gap-4 border-t pt-4", inverse ? "border-bg/20" : "border-line")}>
      <span className={cx("text-[13px] font-semibold tabular-nums", inverse ? "text-bg/60" : "text-text/50")}>{n}</span>
      <span className={cx("text-[12px] font-semibold uppercase tracking-[0.08em]", inverse ? "text-bg" : "text-text")}>{label}</span>
    </div>
  );
}

export function Arrow({ incline }: { incline?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block transition-transform duration-300",
        incline ? "-rotate-45 group-hover:rotate-0" : "group-hover:translate-x-1",
      )}
    >
      →
    </span>
  );
}

export function Cta({
  href,
  children,
  tone = "accent",
  className = "",
  incline,
}: {
  href: string;
  children: ReactNode;
  tone?: "accent" | "ink" | "paper" | "line";
  className?: string;
  incline?: boolean;
}) {
  const skin = {
    accent: "bg-accent text-on-accent hover:bg-accent-hover",
    ink: "bg-text text-bg hover:bg-text/85",
    paper: "bg-bg text-text hover:bg-sunken",
    line: "border border-current bg-transparent hover:bg-text/5",
  }[tone];
  return (
    <Link
      href={href}
      className={cx(
        "group inline-flex w-fit items-center gap-3 px-6 py-3.5 text-[15px] font-medium no-underline transition-colors",
        skin,
        className,
      )}
    >
      {children}
      <Arrow incline={incline} />
    </Link>
  );
}
