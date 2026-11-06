"use client";

import { ReactLenis } from "lenis/react";
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useRef, type ReactNode } from "react";
import { cx } from "./primitives";

/* ===========================================================================
   Motion primitives.

   - SmoothScroll: inertial page scrolling (Lenis), so scroll-linked effects
     move with the page instead of stepping with the wheel. Nested scroll
     areas (wallet drawer, live chat) keep their own native scrolling.
   - ScrollText: a headline whose words fill in as it scrolls through the
     viewport, scrubbed to scroll position rather than played once.
   - Rise: content that rises out of a soft blur when it enters the viewport.

   All of them render static content when the viewer prefers reduced motion.
=========================================================================== */

export function SmoothScroll({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <ReactLenis root options={{ lerp: 0.1, anchors: { offset: -24 }, autoRaf: true, allowNestedScroll: true }}>
      {children}
    </ReactLenis>
  );
}

export type Segment = { text: string; muted?: boolean };

/**
 * Words start faint and fill to full strength as the heading travels from the lower part of the screen to the
 * upper middle. A `muted` segment fills only to the muted strength, so a two-tone headline keeps its two tones.
 */
export function ScrollText({
  as: Tag = "h2",
  segments,
  className,
  id,
  breakBefore,
}: {
  as?: "h1" | "h2" | "p";
  segments: Segment[];
  className?: string;
  id?: string;
  /** Segment indexes that start on a new line. */
  breakBefore?: number[];
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 92%", "start 38%"] });

  const words = segments.flatMap((seg, si) =>
    seg.text
      .split(" ")
      .filter(Boolean)
      .map((w, wi) => ({ w, muted: !!seg.muted, br: wi === 0 && !!breakBefore?.includes(si) })),
  );

  return (
    <Tag ref={ref} id={id} className={className} aria-label={segments.map((s) => s.text).join(" ")}>
      {words.map((word, i) => (
        <span key={i} aria-hidden>
          {word.br && <br />}
          <Word progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]} muted={word.muted} still={!!reduce}>
            {word.w}
          </Word>{" "}
        </span>
      ))}
    </Tag>
  );
}

function Word({
  children,
  progress,
  range,
  muted,
  still,
}: {
  children: string;
  progress: MotionValue<number>;
  range: [number, number];
  muted: boolean;
  still: boolean;
}) {
  const end = muted ? 0.35 : 1;
  const opacity = useTransform(progress, range, [0.12, end]);
  return <motion.span style={{ opacity: still ? end : opacity }}>{children}</motion.span>;
}

/** Rises out of a soft blur the first time it scrolls into view. `delay` is in milliseconds. */
export function Rise({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={cx(className)}
      initial={{ opacity: 0, y: 28, filter: "blur(8px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.9, delay: delay / 1000, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
