"use client";

import { Hero } from "@/components/home/Hero";
import { ClosingBand, TheHow, TheProblem, TheRecord, TheValidations, TwoDoors } from "@/components/home/sections";
import { useContests } from "@/lib/hooks";

export default function HomePage() {
  const contests = useContests("all");
  const openCount = (contests.data ?? []).filter((c) => c.phase === "open" || c.phase === "awaiting_close").length;

  return (
    <main className="flex flex-col">
      <Hero openCount={openCount} />
      <TheRecord />
      <TheProblem />
      <TheHow />
      <TheValidations />
      <TwoDoors />
      <ClosingBand />
    </main>
  );
}
