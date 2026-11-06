"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { isTransientError } from "@/lib/api";
import { ToastProvider } from "@/lib/toast";
import { WalletProvider } from "@/lib/wallet";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 2_000,
            // Coming back to the tab shows current data at once instead of waiting for the next poll (if any).
            // The session query, which signs on every fetch, opts out (hooks.ts).
            refetchOnWindowFocus: true,
            // Retry a gateway blip or timeout; a 4xx (not found, not ended yet) is an answer, not a failure.
            retry: (failures, err) => failures < 2 && isTransientError(err),
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <WalletProvider>{children}</WalletProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
