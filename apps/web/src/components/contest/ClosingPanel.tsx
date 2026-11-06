"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { ContestDetail } from "@defect/shared";
import { api } from "@/lib/api";
import { useTx } from "@/lib/useTx";
import { useWallet } from "@/lib/wallet";
import { Button, Card, Countdown, useNow } from "../ui/primitives";
import { ClaimPanel } from "./ClaimPanel";

// Phase "awaiting_close": window over, 10-minute grace for locked-in secret claims.

export function ClosingPanel({ c, revealGraceSeconds }: { c: ContestDetail; revealGraceSeconds: number }) {
  const now = useNow();
  const { wallet, openDrawer } = useWallet();
  const { run, busy } = useTx();
  const qc = useQueryClient();
  const closeAt = c.endTime + revealGraceSeconds;
  const canClose = now > closeAt;
  const hasSecret = c.invariants.some((i) => i.type === "secret");

  return (
    <div className="flex flex-wrap gap-5 items-start">
      <Card className="flex-[1_1_420px] min-w-0 p-6 flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">What happens now</h2>
        <ol className="m-0 pl-5 flex flex-col gap-2.5 text-soft leading-relaxed">
          <li>Chat is closed. No new messages or new secret claims.</li>
          {hasSecret && (
            <li>
              If you locked in a secret claim before time ran out, you have <b>10 minutes</b> to reveal it.
            </li>
          )}
          <li>
            After that, anyone can close the contest. If nobody broke a rule, everything returns to the Warden with a public &quot;survived&quot; record. The arena
            closes it automatically within a minute.
          </li>
        </ol>
        <div className="flex items-center gap-3 flex-wrap pt-3 border-t border-border">
          <Button
            variant="ghost"
            disabled={!canClose || busy}
            onClick={() => {
              if (!wallet) return openDrawer();
              void run("Closing the validation", () => api.closeHeld(wallet, c.contestId)).then(() => qc.invalidateQueries());
            }}
          >
            {canClose ? (
              "Close validation"
            ) : (
              <>
                Close validation · available in <Countdown to={closeAt} />
              </>
            )}
          </Button>
          <span className="text-xs text-faint">Anyone can press this once the 10 minutes pass.</span>
        </div>
      </Card>
      {hasSecret && (
        <Card className="flex-[1_1_420px] min-w-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="m-0 text-[15px] font-semibold">Your locked-in claim</h2>
          </div>
          <ClaimPanel c={c} revealOnly />
        </Card>
      )}
    </div>
  );
}
