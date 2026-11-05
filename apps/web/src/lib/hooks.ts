"use client";

import { useQuery } from "@tanstack/react-query";
import { ENDED_PHASES, type ContestPhase } from "@defect/shared";
import { api, type ContestListFilter, type Wallet } from "./api";

const live = (phase?: ContestPhase) => !!phase && !ENDED_PHASES.includes(phase);

export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => api.getConfig(), staleTime: Infinity });

export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: () => api.getStats(), refetchInterval: 30_000 });

export const useContests = (filter: ContestListFilter = "all") =>
  useQuery({ queryKey: ["contests", filter], queryFn: () => api.listContests(filter), refetchInterval: 15_000 });

export const useContest = (id: number) =>
  useQuery({
    queryKey: ["contest", id],
    queryFn: () => api.getContest(id),
    refetchInterval: (q) => (live(q.state.data?.phase) ? 5_000 : false),
  });

export const useSession = (id: number, wallet: Wallet | null) =>
  useQuery({
    queryKey: ["session", id, wallet?.address],
    queryFn: () => api.getSession(id, wallet!),
    enabled: !!wallet,
  });

export const useAttempts = (id: number, enabled: boolean) =>
  useQuery({ queryKey: ["attempts", id], queryFn: () => api.getAttempts(id), enabled });

export const useCanaryRounds = (id: number) =>
  useQuery({ queryKey: ["canary", id], queryFn: () => api.getCanaryRounds(id), refetchInterval: 60_000 });

export const useAttestation = (id: number, enabled: boolean) =>
  useQuery({ queryKey: ["attestation", id], queryFn: () => api.getAttestation(id), enabled, retry: false });
