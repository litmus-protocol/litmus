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
    refetchInterval: (q) => {
      const d = q.state.data;
      if (live(d?.phase)) return 5_000;
      // An ended contest is finalized a few seconds later (the log hash is posted on chain, then `revealed.logHash`
      // appears). Keep polling until it does, or a page opened in that window would verify against a stale copy.
      return d && d.phase !== "cancelled" && !d.revealed?.logHash ? 5_000 : false;
    },
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

/** Polls until the gateway has minted the certificate (it does so ~30 s after finalization). */
export const useCertificate = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ["certificate", id],
    queryFn: () => api.getCertificate(id),
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data ? false : 30_000),
  });

export const useAttestation = (id: number, enabled: boolean) =>
  useQuery({ queryKey: ["attestation", id], queryFn: () => api.getAttestation(id), enabled, retry: false });

/** The shared breaker bot: its wallet, balance and runs. Polls fast while a run is in progress. */
export const useBot = () =>
  useQuery({ queryKey: ["bot"], queryFn: () => api.getBot(), refetchInterval: (q) => (q.state.data?.active ? 1_500 : 8_000) });
