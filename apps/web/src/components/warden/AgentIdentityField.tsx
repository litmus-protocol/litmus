"use client";

import { useState } from "react";
import type { ValidationIssue } from "@defect/shared";
import { api, friendlyError } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { WarnIcon } from "../ui/icons";
import { Button, Callout, HashscanLink, cx, inputCls } from "../ui/primitives";

export type AgentIdentityMode = "none" | "use" | "register";

/** Wizard state for the optional ERC-8004 identity. `agentId` is the raw input text. */
export interface AgentIdentity {
  mode: AgentIdentityMode;
  agentId: string;
  /** HashScan link of the registration transaction, when the agent was registered in this wizard. */
  registerTx: string | null;
}

export const NO_AGENT_IDENTITY: AgentIdentity = { mode: "none", agentId: "", registerTx: null };

/** The ERC-8004 agent id to send with the submission, or undefined when none is linked or the input is invalid. */
export function linkedAgentId(a: AgentIdentity): number | undefined {
  if (a.mode !== "use" || !/^(0|[1-9][0-9]{0,15})$/.test(a.agentId.trim())) return undefined;
  const n = Number(a.agentId.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * UI-side checks for the identity field. The shared schema's "wallet required" rule only runs once the
 * rest of the submission parses, so the wizard checks it here too.
 */
export function agentIdentityIssues(a: AgentIdentity, wallet: string | undefined): ValidationIssue[] {
  const path = "card.agentId";
  if (a.mode === "register") return [{ path, message: "Register the agent first, or choose another ERC-8004 option" }];
  if (a.mode !== "use") return [];
  if (linkedAgentId(a) === undefined) return [{ path, message: "Enter your ERC-8004 agent ID as a whole number" }];
  if (!wallet) return [{ path, message: "Connect a wallet to link an ERC-8004 agent" }];
  return [];
}

const OPTIONS: { mode: AgentIdentityMode; label: string }[] = [
  { mode: "none", label: "No ERC-8004 identity" },
  { mode: "use", label: "Use my agent ID" },
  { mode: "register", label: "Register a new agent" },
];

/** Optional ERC-8004 identity for the agent under test. Hidden when the gateway has no ERC-8004 registries. */
export function AgentIdentityField({ value, onChange, name, purpose }: { value: AgentIdentity; onChange: (v: AgentIdentity) => void; name: string; purpose: string }) {
  const cfg = useConfig();
  const { wallet, openDrawer, refreshBalances } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!cfg.data?.erc8004) return null;

  const canRegister = !!wallet && name.trim() !== "" && purpose.trim() !== "";

  async function register() {
    if (!wallet || !canRegister) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.registerAgent(wallet, { name: name.trim(), purpose: purpose.trim() });
      onChange({ mode: "use", agentId: String(r.agentId), registerTx: r.hashscan });
      refreshBalances(); // registering pays gas in HBAR
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="border-0 p-0 m-0 flex flex-col gap-2.5">
      <legend className="text-[13px] font-medium text-soft mb-2.5">ERC-8004 identity (optional)</legend>
      <div className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(min(190px,100%),1fr))]">
        {OPTIONS.map((o) => (
          <label key={o.mode} className={cx("flex items-center gap-2.5 px-3.5 py-3 rounded-none border text-[13px] cursor-pointer", value.mode === o.mode ? "border-accent" : "border-border-strong")}>
            <input
              type="radio"
              name="erc8004-identity"
              className="w-4 h-4 accent-[var(--accent)]"
              checked={value.mode === o.mode}
              onChange={() => {
                setError(null);
                onChange({ ...value, mode: o.mode });
              }}
            />
            {o.label}
          </label>
        ))}
      </div>

      {value.mode === "use" && (
        <div className="flex flex-col gap-2">
          <label htmlFor="agent-id" className="text-[13px] font-medium text-soft">
            ERC-8004 agent ID
          </label>
          <input
            id="agent-id"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            className={cx(inputCls, "max-w-[220px]")}
            value={value.agentId}
            onChange={(e) => onChange({ ...value, agentId: e.target.value, registerTx: null })}
            placeholder="42"
          />
          {value.registerTx && (
            <span className="text-xs text-muted">
              Registered. <HashscanLink href={value.registerTx} />
            </span>
          )}
          {!wallet && (
            <span className="text-xs text-faint">
              Connect a wallet to link an agent.{" "}
              <button type="button" onClick={openDrawer} className="bg-transparent border-0 p-0 text-accent cursor-pointer text-xs underline">
                Connect
              </button>
            </span>
          )}
        </div>
      )}

      {value.mode === "register" && (
        <div className="flex flex-col gap-2.5 items-start">
          <Button onClick={() => void register()} disabled={!canRegister || busy}>
            {busy ? "Registering…" : "Register agent"}
          </Button>
          <span className="text-xs text-faint leading-relaxed">
            {!wallet ? "Connect a wallet first. " : !canRegister ? "Fill in the agent name and purpose above first. " : ""}
            Creates an ERC-8004 identity from the name and purpose above, owned by your wallet.
          </span>
          {error && (
            <Callout tone="broken" icon={<WarnIcon size={16} />}>
              {error}
            </Callout>
          )}
        </div>
      )}
      <span className="text-xs text-faint leading-relaxed">
        Results are posted to this agent&apos;s ERC-8004 reputation, tied to the exact package tested.
      </span>
    </fieldset>
  );
}
