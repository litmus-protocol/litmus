"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** ERC-8004 agent profile (card, owner, Defect record). Not-found is final, so it isn't retried. */
export const useAgent = (id: number) =>
  useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.getAgent(id),
    enabled: Number.isSafeInteger(id) && id >= 0,
    retry: false,
  });
