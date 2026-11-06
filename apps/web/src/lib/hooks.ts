"use client";

import { useQuery } from "@tanstack/react-query";
import { ENDED_PHASES, REVEAL_GRACE_SECONDS, type ContestDetail, type ContestPhase, type ContestSummary } from "@defect/shared";
import { api, isTransientError, type ContestListFilter, type Wallet } from "./api";

const live = (phase?: ContestPhase) => !!phase && !ENDED_PHASES.includes(phase);
const nowSec = () => Math.floor(Date.now() / 1000);

/** How often a query that failed to load (gateway down, timeout, 5xx) tries again on its own. */
const RECOVER_MS = 10_000;
/** The last fetch failed for a reason worth retrying (not a definite 4xx such as a 404). */
const failedTransiently = (q: { state: { status: string; error: unknown } }) => q.state.status === "error" && isTransientError(q.state.error);

export const useConfig = () =>
  useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
    // Without it the faucet, ERC-8004 field and window lengths silently fall back to defaults until a reload.
    refetchInterval: (q) => (q.state.data === undefined && failedTransiently(q) ? RECOVER_MS : false),
  });

export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: () => api.getStats(), refetchInterval: 30_000 });

/** How long after a phase boundary (start, end, end of the reveal grace) the list polls fast to pick up the new phase. */
const BOUNDARY_WINDOW_SECONDS = 300;

/** A contest whose countdown has run out but whose listed phase hasn't moved on yet. */
function pastBoundary(c: ContestSummary, now: number): boolean {
  const boundary =
    c.phase === "scheduled" ? c.startTime : c.phase === "open" ? c.endTime : c.phase === "awaiting_close" ? c.endTime + REVEAL_GRACE_SECONDS : null;
  return boundary !== null && now >= boundary && now - boundary < BOUNDARY_WINDOW_SECONDS;
}

export const useContests = (filter: ContestListFilter = "all") =>
  useQuery({
    queryKey: ["contests", filter],
    queryFn: () => api.listContests(filter),
    // A card whose countdown hit zero would otherwise sit at 00:00:00 until the next 15 s poll.
    refetchInterval: (q) => (q.state.data?.some((c) => pastBoundary(c, nowSec())) ? 5_000 : 15_000),
  });

/** How long after a contest ends the page keeps watching for the certificate and ERC-8004 feedback to land. */
const POST_FINAL_WATCH_SECONDS = 6 * 3600;

/** Work the gateway still does after finalization: mint + report the Held certificate, post ERC-8004 feedback. */
function postFinalPending(d: ContestDetail): boolean {
  if (d.endedAt !== null && nowSec() - d.endedAt > POST_FINAL_WATCH_SECONDS) return false;
  return (
    d.certificate?.status === "pending" ||
    d.certificate?.status === "minted" ||
    d.agent?.feedback === "none" ||
    d.winnerAgent?.feedback === "none"
  );
}

export const useContest = (id: number) =>
  useQuery({
    queryKey: ["contest", id],
    queryFn: () => api.getContest(id),
    refetchInterval: (q) => {
      const d = q.state.data;
      // Never loaded: keep trying while the failure is transient (gateway unreachable, timeout, 5xx), so a blip
      // doesn't leave the page on an error until a reload. A 404 is final.
      if (!d) return failedTransiently(q) ? 5_000 : false;
      if (live(d.phase)) return 5_000;
      if (d.phase === "cancelled") return false;
      // An ended contest is finalized a few seconds later (the log hash is posted on chain, then `revealed.logHash`
      // appears). Keep polling until it does, or a page opened in that window would verify against a stale copy.
      if (!d.revealed?.logHash) return 5_000;
      // Then the certificate (after the Chainlink audit) and the agent feedback follow, minutes later.
      return postFinalPending(d) ? 30_000 : false;
    },
  });

export const useSession = (id: number, wallet: Wallet | null) =>
  useQuery({
    queryKey: ["session", id, wallet?.address],
    queryFn: () => api.getSession(id, wallet!),
    enabled: !!wallet,
    retry: 1,
    // Each fetch signs a fresh session message; a WalletConnect wallet would prompt on every tab focus.
    refetchOnWindowFocus: false,
  });

/** The published transcripts are final once the log hash is posted (or the contest was cancelled). */
export const attemptsFinal = (c: ContestDetail) => c.phase === "cancelled" || !!c.revealed?.logHash;

/**
 * Transcripts, published once the contest ends. `final` = the log is posted; until then attempts still in
 * flight at the end (and vault events reconciled during finalization) can change, so it polls.
 */
export const useAttempts = (id: number, enabled: boolean, final = true) =>
  useQuery({
    queryKey: ["attempts", id],
    queryFn: () => api.getAttempts(id),
    enabled,
    refetchInterval: (q) => (!final || failedTransiently(q) ? RECOVER_MS : false),
  });

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

/** Polls until the Chainlink CRE attestation is recorded on Sepolia (null until then). */
export const useAttestation = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ["attestation", id],
    queryFn: () => api.getAttestation(id),
    enabled,
    retry: false,
    refetchInterval: (q) => (q.state.data ? false : 30_000),
  });

/** The shared breaker bot: its wallet, balance and runs. Polls fast while a run is in progress. */
export const useBot = () =>
  useQuery({ queryKey: ["bot"], queryFn: () => api.getBot(), refetchInterval: (q) => (q.state.data?.active ? 1_500 : 8_000) });
