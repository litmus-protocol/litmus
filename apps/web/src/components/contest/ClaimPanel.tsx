"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { commitment, formatUsdc, secretHash, type ContestDetail } from "@defect/shared";
import { api } from "@/lib/api";
import { useTx } from "@/lib/useTx";
import { useWallet } from "@/lib/wallet";
import { CheckIcon, XIcon } from "../ui/icons";
import { Button, HashscanLink, cx, inputCls } from "../ui/primitives";

// Two-step secret claim (build plan §11.3 panel 2): commit, then reveal in a later block.

interface StoredCommit {
  invariantIndex: number;
  secret: string;
  salt: `0x${string}`;
  blockNumber: string;
  hashscan: string;
  address: string;
}

const storageKey = (id: number) => `defect.commit.${id}`;

export function readStoredCommit(id: number): StoredCommit | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    return raw ? (JSON.parse(raw) as StoredCommit) : null;
  } catch {
    return null;
  }
}

function randomSalt(): `0x${string}` {
  return `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function ClaimPanel({ c, revealOnly = false }: { c: ContestDetail; revealOnly?: boolean }) {
  const { wallet, openDrawer, refreshBalances } = useWallet();
  const { run, busy } = useTx();
  const qc = useQueryClient();
  const secretRules = c.invariants.map((inv, index) => ({ inv, index })).filter((x) => x.inv.type === "secret");
  const [code, setCode] = useState("");
  const [ruleIndex, setRuleIndex] = useState(secretRules[0]?.index ?? 0);
  const [stored, setStored] = useState<StoredCommit | null>(null);
  const [blockReady, setBlockReady] = useState(false);

  useEffect(() => {
    const s = readStoredCommit(c.contestId);
    setStored(s && wallet && s.address === wallet.address.toLowerCase() ? s : null);
  }, [c.contestId, wallet]);

  // Step 2 unlocks once a block after the commit's block exists.
  useEffect(() => {
    if (!stored) return;
    let alive = true;
    const tick = async () => {
      try {
        const b = await api.getBlockNumber();
        if (alive) setBlockReady(b > BigInt(stored.blockNumber));
      } catch {
        // retry on next tick
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [stored]);

  const selected = c.invariants[ruleIndex];
  const target = selected?.type === "secret" ? selected.secretHash : null;
  const candidate = code.trim();
  const matches = !!candidate && !!target && secretHash(candidate) === target;

  if (!wallet) {
    return (
      <div className="p-10 flex flex-col items-center gap-3 text-center">
        <span className="font-semibold">Connect a wallet to claim a prize</span>
        <Button onClick={openDrawer}>Connect wallet</Button>
      </div>
    );
  }

  async function lockIn() {
    if (!wallet || !matches) return;
    const salt = randomSalt();
    const res = await run("Locking in your claim", () => api.commitBreak(wallet, c.contestId, commitment(candidate, wallet.address, salt)));
    if (!res) return;
    const s: StoredCommit = {
      invariantIndex: ruleIndex,
      secret: candidate,
      salt,
      blockNumber: String(res.blockNumber),
      hashscan: res.hashscan,
      address: wallet.address.toLowerCase(),
    };
    try {
      localStorage.setItem(storageKey(c.contestId), JSON.stringify(s));
    } catch {
      // progress just won't survive a reload
    }
    setStored(s);
  }

  async function reveal() {
    if (!wallet || !stored) return;
    const res = await run("Revealing and claiming", () => api.revealBreak(wallet, c.contestId, stored.invariantIndex, stored.secret, stored.salt));
    if (!res) return;
    try {
      localStorage.removeItem(storageKey(c.contestId));
    } catch {
      // ignore
    }
    setStored(null);
    refreshBalances();
    void qc.invalidateQueries();
  }

  if (revealOnly && !stored) {
    return <p className="m-0 p-6 text-muted text-[13px]">New claims are closed. Only claims locked in before time ran out can be revealed.</p>;
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      {!stored && (
        <>
          <div className="flex flex-col gap-1.5">
            <h3 className="m-0 text-xl font-semibold tracking-tight">Did the agent leak its code?</h3>
            <p className="m-0 text-muted leading-relaxed">Paste it here. We check it on your device first, so a wrong guess never costs you anything.</p>
          </div>
          {secretRules.length > 1 && (
            <div className="flex flex-col gap-2">
              <label htmlFor="rule" className="text-[13px] font-medium text-soft">
                Which rule?
              </label>
              <select id="rule" value={ruleIndex} onChange={(e) => setRuleIndex(Number(e.target.value))} className={inputCls}>
                {secretRules.map(({ inv, index }) => (
                  <option key={inv.id} value={index}>
                    {inv.text}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="code" className="text-[13px] font-medium text-soft">
              Access code
            </label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="DFT-…"
              className={cx(inputCls, "mono h-12 text-sm tracking-wide", candidate && (matches ? "border-open" : "border-broken"))}
            />
            {candidate &&
              (matches ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-open">
                  <CheckIcon size={14} /> This is the real code
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-broken-text">
                  <XIcon size={14} /> Not the code. Nothing was sent.
                </span>
              ))}
          </div>
        </>
      )}

      <ol className="list-none m-0 p-0 flex flex-col">
        <li className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span className={cx("w-7 h-7 rounded-full grid place-items-center flex-none mono text-xs font-semibold", stored ? "bg-open text-[#0b0d12]" : "border-2 border-accent text-accent")}>
              {stored ? <CheckIcon size={14} /> : "1"}
            </span>
            <span className={cx("w-0.5 flex-1 min-h-7", stored ? "bg-open" : "bg-border")} />
          </div>
          <div className="flex flex-col gap-2.5 pb-6 flex-1">
            <span className="text-[15px] font-semibold">Step 1 · Lock in your claim</span>
            <span className="text-[13px] text-muted leading-relaxed">Your claim is sealed on chain. Nobody can copy it.</span>
            {stored ? (
              <HashscanLink href={stored.hashscan} label="Locked in · HashScan ↗" />
            ) : (
              <Button disabled={!matches || busy || revealOnly} onClick={() => void lockIn()} className="self-start">
                Lock in my claim
              </Button>
            )}
          </div>
        </li>
        <li className="flex gap-3.5">
          <span className={cx("w-7 h-7 rounded-full grid place-items-center flex-none mono text-xs font-semibold border-2", stored ? "border-accent text-accent" : "border-border-strong text-faint")}>2</span>
          <div className="flex flex-col gap-2.5 flex-1">
            <span className="text-[15px] font-semibold">Step 2 · Reveal and claim prize</span>
            <span className="text-[13px] text-muted leading-relaxed">
              {stored && !blockReady ? "Waiting for the next block (a few seconds)…" : "Unlocks a few seconds after step 1 confirms."}
            </span>
            <Button disabled={!stored || !blockReady || busy} onClick={() => void reveal()} className="self-start">
              Reveal and claim <span className="mono">{formatUsdc(c.pool)} USDC</span>
            </Button>
          </div>
        </li>
      </ol>
      {stored && <p className="m-0 text-xs text-faint">Your progress is saved. You can reload the page and pick up at step 2.</p>}
    </div>
  );
}
