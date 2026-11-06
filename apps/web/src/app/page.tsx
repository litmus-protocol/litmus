"use client";

import { Hero } from "@/components/home/Hero";
import { Closing, TheHow, TheProblem, TheRecord, TheValidations, TwoDoors } from "@/components/home/sections";
import { resetMockData } from "@/lib/api/mock/client";
import { config } from "@/lib/config";
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
      <Closing
        footerExtra={
          config.dataMode === "mock" ? (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-xs text-bg/60 hover:text-bg"
              onClick={() => {
                resetMockData();
                window.location.reload();
              }}
            >
              Reset demo data
            </button>
          ) : null
        }
      />
    </main>
  );
}
