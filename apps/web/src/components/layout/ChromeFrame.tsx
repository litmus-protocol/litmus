"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Wraps the fixed chrome above the page (testnet header) and
 * publishes its measured height as `--chrome` on <html>.
 *
 * The hero is required to be exactly one viewport tall — the first scroll
 * must land on the section after it, never on more hero. That means the
 * hero needs `100svh` minus whatever sits above it, and "whatever sits
 * above it" is not a constant: the header is `flex-wrap`, so it gains a
 * row on narrow viewports. Hard-coding the subtraction is right at ~1000px
 * and wrong everywhere the header wraps.
 *
 * `--chrome` has a sane default in globals.css that matches the unwrapped
 * desktop case to the pixel, so the measured value replaces an identical
 * one there and nothing moves on first paint.
 */
export function ChromeFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => {
      // getBoundingClientRect, not offsetHeight: the latter rounds to whole
      // pixels and the leftover fraction shows up as a sliver of hero below
      // the fold.
      const h = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--chrome", `${h}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return <div ref={ref}>{children}</div>;
}
