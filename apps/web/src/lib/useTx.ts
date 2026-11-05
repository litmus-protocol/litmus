"use client";

import { useCallback, useState } from "react";
import { friendlyError, type TxResult } from "./api";
import { useToasts } from "./toast";

/** Runs a wallet transaction with "Sending… → Confirmed ✓ / Failed" toasts. */
export function useTx() {
  const { push, update } = useToasts();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async <T extends TxResult | null>(label: string, fn: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      const id = push({ kind: "pending", title: `${label}…` });
      try {
        const result = await fn();
        update(id, { kind: "success", title: `${label}: confirmed`, href: result?.hashscan });
        return result;
      } catch (e) {
        update(id, { kind: "error", title: `Failed: ${friendlyError(e)}` });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [push, update],
  );

  return { run, busy };
}
