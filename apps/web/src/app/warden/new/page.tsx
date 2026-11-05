"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_MESSAGE_PRICE,
  DEFAULT_MODEL,
  MAX_CANARIES,
  MAX_INVARIANTS,
  MIN_BOND_PERCENT,
  TOOL_LABELS,
  TOOL_NAMES,
  formatUsdc,
  fromBaseUnits,
  isDecimalString,
  toBaseUnits,
  treasuryBotSubmission,
  validateSubmission,
  type ToolName,
  type ValidationIssue,
  type WardenSubmission,
} from "@defect/shared";
import { BanIcon, CheckIcon, LockIcon, NextIcon, PlusIcon, SendIcon, TrashIcon, WarnIcon, XIcon } from "@/components/ui/icons";
import { Button, Callout, Card, Field, HashscanLink, cx, inputCls } from "@/components/ui/primitives";
import { api, friendlyError } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";

// Warden wizard (build plan §11.4): 5 steps, then a visible 4-step launch.

type RuleType = "secret" | "transfer_limit" | "forbidden_tool";
interface RuleRow {
  id: string;
  type: RuleType;
  text: string;
  maxAmount: string;
}
interface CheckRow {
  id: string;
  prompt: string;
  kind: "tool" | "contains";
  value: string;
}
interface Form {
  name: string;
  purpose: string;
  model: string;
  systemPrompt: string;
  tools: ToolName[];
  temperature: number;
  rules: RuleRow[];
  checks: CheckRow[];
  pool: string;
  vault: string;
  bond: string;
  price: string;
  start: string; // datetime-local
}

const STEPS = ["Agent", "Rules", "Health checks", "Money & time", "Review & launch"] as const;

function toLocalInput(unix: number) {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (s: string) => Math.floor(new Date(s).getTime() / 1000);
const nowSec = () => Math.floor(Date.now() / 1000);

function emptyForm(): Form {
  return {
    name: "",
    purpose: "",
    model: DEFAULT_MODEL,
    systemPrompt: "",
    tools: ["vault_balance", "vault_send"],
    temperature: 0.3,
    rules: [],
    checks: [],
    pool: "20",
    vault: "15",
    bond: "4",
    price: DEFAULT_MESSAGE_PRICE,
    start: toLocalInput(nowSec() + 600),
  };
}

function exampleForm(): Form {
  const s = treasuryBotSubmission;
  return {
    name: s.card.name,
    purpose: s.card.purpose,
    model: s.package.model,
    systemPrompt: s.package.systemPrompt,
    tools: [...s.package.tools],
    temperature: s.package.temperature,
    rules: s.invariants.map((i) => ({ id: i.id, type: i.type, text: i.text, maxAmount: i.type === "transfer_limit" ? i.maxAmount : "10" })),
    checks: s.canaries.map((c) => ({ id: c.id, prompt: c.prompt, kind: c.expectTool ? "tool" : "contains", value: c.expectTool ?? c.mustContain?.join(", ") ?? "" })),
    pool: s.pool,
    vault: s.vaultFunding,
    bond: s.bond,
    price: s.messagePrice,
    start: toLocalInput(nowSec() + 180),
  };
}

function toSubmission(f: Form): WardenSubmission {
  return {
    card: { name: f.name.trim(), purpose: f.purpose.trim() },
    package: { model: f.model, systemPrompt: f.systemPrompt, tools: f.tools, temperature: f.temperature },
    invariants: f.rules.map((r) =>
      r.type === "secret"
        ? { id: r.id, text: r.text.trim(), type: "secret" as const }
        : r.type === "transfer_limit"
          ? { id: r.id, text: r.text.trim(), type: "transfer_limit" as const, maxAmount: r.maxAmount.trim() }
          : { id: r.id, text: r.text.trim(), type: "forbidden_tool" as const, tool: "emergency_withdraw" as const },
    ),
    canaries: f.checks.map((c) =>
      c.kind === "tool"
        ? { id: c.id, prompt: c.prompt.trim(), expectTool: c.value as ToolName }
        : { id: c.id, prompt: c.prompt.trim(), mustContain: c.value.split(",").map((v) => v.trim()).filter(Boolean) },
    ),
    vaultFunding: f.vault.trim(),
    pool: f.pool.trim(),
    bond: f.bond.trim(),
    startTime: fromLocalInput(f.start),
    messagePrice: f.price.trim(),
  };
}

function stepOf(path: string): number {
  if (path.startsWith("card") || path.startsWith("package")) return 0;
  if (path.startsWith("invariants")) return 1;
  if (path.startsWith("canaries")) return 2;
  return 3;
}

function nextId(prefix: "inv" | "can", existing: string[]) {
  for (let i = 1; i < 100; i++) if (!existing.includes(`${prefix}-${i}`)) return `${prefix}-${i}`;
  return `${prefix}-99`;
}

/** Contest length from the gateway's deployment (8 h prod, 15 min demo). */
function windowText(seconds?: number): string {
  if (!seconds) return "8 hours";
  return seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}` : `${Math.round(seconds / 60)} minutes`;
}

const sum = (...vals: string[]) => vals.reduce((s, v) => s + (isDecimalString(v) ? toBaseUnits(v) : 0n), 0n);

export default function WardenWizard() {
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>(emptyForm);
  const [showIssues, setShowIssues] = useState(false);
  const cfg = useConfig();
  const allowedModels = cfg.data?.allowedModels ?? [DEFAULT_MODEL];
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const issues: ValidationIssue[] = useMemo(() => validateSubmission(toSubmission(f), { allowedModels, now: nowSec() }), [f, allowedModels]);
  const stepIssues = issues.filter((i) => stepOf(i.path) === step);

  function next() {
    if (step < 3 && stepIssues.length) {
      setShowIssues(true);
      return;
    }
    setShowIssues(false);
    setStep((s) => Math.min(4, s + 1));
    window.scrollTo({ top: 0 });
  }

  return (
    <main className="max-w-[920px] mx-auto px-4 sm:px-6 pt-8 pb-16 flex flex-col gap-6">
      <div className="flex justify-between items-end gap-4 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Warden</span>
          <h1 className="m-0 text-[30px] font-bold tracking-tight">Create a contest</h1>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setF(exampleForm());
            setShowIssues(false);
          }}
        >
          Load example (TreasuryBot)
        </Button>
      </div>

      <div className="flex flex-col gap-3.5">
        <div className="h-1 rounded bg-chip overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${(step + 1) * 20}%` }} />
        </div>
        <ol className="list-none m-0 p-0 flex gap-x-6 gap-y-2 flex-wrap">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={cx("flex items-center gap-2.5 text-[13px] bg-transparent border-0 p-0", i === step ? "text-text" : "text-faint", i < step && "cursor-pointer hover:text-text")}
              >
                <span
                  className={cx(
                    "w-[26px] h-[26px] rounded-full grid place-items-center mono text-xs font-semibold border",
                    i === step ? "bg-accent text-on-accent border-accent" : i < step ? "bg-chip text-open border-open" : "border-border-strong",
                  )}
                >
                  {i < step ? <CheckIcon size={12} /> : i + 1}
                </span>
                {s}
              </button>
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && <AgentStep f={f} set={set} setF={setF} allowedModels={allowedModels} />}
      {step === 1 && <RulesStep f={f} setF={setF} />}
      {step === 2 && <ChecksStep f={f} setF={setF} />}
      {step === 3 && <MoneyStep f={f} set={set} />}
      {step === 4 && <LaunchStep f={f} issues={issues} onEdit={(s) => setStep(s)} />}

      {showIssues && stepIssues.length > 0 && (
        <Callout tone="broken" icon={<WarnIcon size={16} />}>
          <ul className="m-0 pl-4">
            {[...new Set(stepIssues.map((i) => i.message))].map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Callout>
      )}

      {step < 4 && (
        <div className="flex justify-between gap-3">
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            Back
          </Button>
          <Button onClick={next}>
            Next: {STEPS[step + 1]} <NextIcon />
          </Button>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- step 1

function AgentStep({ f, set, setF, allowedModels }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void; setF: React.Dispatch<React.SetStateAction<Form>>; allowedModels: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function insertSecret() {
    setF((x) => {
      const existing = x.rules.find((r) => r.type === "secret" && !x.systemPrompt.includes(`{{SECRET:${r.id}}}`));
      const rules = [...x.rules];
      let id = existing?.id;
      if (!id) {
        if (rules.length >= MAX_INVARIANTS) return x;
        id = nextId("inv", rules.map((r) => r.id));
        rules.push({ id, type: "secret", text: `${x.name || "The agent"} never reveals its internal access code.`, maxAmount: "10" });
      }
      const el = ref.current;
      const token = `{{SECRET:${id}}}`;
      const pos = el?.selectionStart ?? x.systemPrompt.length;
      return { ...x, rules, systemPrompt: x.systemPrompt.slice(0, pos) + token + x.systemPrompt.slice(pos) };
    });
  }
  return (
    <Card className="p-7 flex flex-col gap-5">
      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
        <Field label="Agent name" htmlFor="name">
          <input id="name" className={inputCls} value={f.name} maxLength={40} onChange={(e) => set("name", e.target.value)} placeholder="TreasuryBot" />
        </Field>
        <Field label="Model" htmlFor="model" help="Runs on 0G compute.">
          <select id="model" className={inputCls} value={f.model} onChange={(e) => set("model", e.target.value)}>
            {allowedModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Purpose" htmlFor="purpose" help="Shown publicly on the contest page.">
        <input id="purpose" className={inputCls} value={f.purpose} maxLength={280} onChange={(e) => set("purpose", e.target.value)} placeholder="Pays approved vendor invoices from its vault." />
      </Field>
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center gap-3 flex-wrap">
          <label htmlFor="prompt" className="text-[13px] font-medium text-soft">
            Instructions (system prompt)
          </label>
          <button
            type="button"
            onClick={insertSecret}
            className="mono inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[7px] border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-accent text-xs cursor-pointer"
          >
            <LockIcon size={13} /> Insert secret code
          </button>
        </div>
        <textarea
          id="prompt"
          ref={ref}
          rows={9}
          maxLength={8000}
          value={f.systemPrompt}
          onChange={(e) => set("systemPrompt", e.target.value)}
          placeholder="You are TreasuryBot… Never send more than 10 USDC in one transfer."
          className="mono w-full box-border bg-sunken border border-border-strong rounded-[10px] p-3.5 text-[13px] leading-[1.7] text-soft resize-y"
        />
        <span className="text-xs text-faint">Hidden until the contest ends. &quot;Insert secret code&quot; adds a placeholder; we generate the real code and even you won&apos;t see it until the end.</span>
      </div>
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-2.5">
        <legend className="text-[13px] font-medium text-soft mb-2.5">Tools the agent can use</legend>
        <div className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(min(190px,100%),1fr))]">
          {TOOL_NAMES.map((t) => (
            <label key={t} className="flex items-center gap-2.5 px-3.5 py-3 rounded-[10px] border border-border-strong text-[13px] cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[var(--accent)]"
                checked={f.tools.includes(t)}
                onChange={(e) => set("tools", e.target.checked ? [...f.tools, t] : f.tools.filter((x) => x !== t))}
              />
              {TOOL_LABELS[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={`Creativity · ${f.temperature.toFixed(1)}`} htmlFor="temp" help="Lower is more predictable.">
        <input id="temp" type="range" min={0} max={1} step={0.1} value={f.temperature} onChange={(e) => set("temperature", Number(e.target.value))} className="w-full accent-[var(--accent)]" />
      </Field>
    </Card>
  );
}

// ---------------------------------------------------------------- step 2

const RULE_META: Record<RuleType, { label: string; Icon: typeof LockIcon; help: string }> = {
  secret: { label: "Secret", Icon: LockIcon, help: "Proven when a Breaker submits the exact code. We generate the code; nobody sees it until the end." },
  transfer_limit: { label: "Transfer limit", Icon: SendIcon, help: "Proven the moment the agent asks to send more than the limit, even if the wallet can't cover it." },
  forbidden_tool: { label: "Forbidden tool", Icon: BanIcon, help: "Proven the moment the agent calls the tool. Only one per contest." },
};

function RulesStep({ f, setF }: { f: Form; setF: React.Dispatch<React.SetStateAction<Form>> }) {
  const update = (i: number, patch: Partial<RuleRow>) => setF((x) => ({ ...x, rules: x.rules.map((r, k) => (k === i ? { ...r, ...patch } : r)) }));
  return (
    <Card className="p-7 flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold">What does your agent promise never to do?</h2>
        <p className="m-0 text-muted leading-relaxed">Each rule is checked by code, not by a person. If a Breaker makes the agent break any one of them, the contract pays them your whole prize pool.</p>
      </div>
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))]">
        {(Object.keys(RULE_META) as RuleType[]).map((t) => {
          const { label, Icon, help } = RULE_META[t];
          return (
            <div key={t} className="p-3.5 rounded-[10px] border border-border flex flex-col gap-1.5">
              <span className="inline-flex items-center gap-2 font-semibold">
                <Icon size={16} className="text-soft" />
                {label}
              </span>
              <span className="text-xs text-faint leading-relaxed">{help}</span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-3">
        {f.rules.length === 0 && <p className="m-0 text-muted text-[13px]">No rules yet. Add at least one.</p>}
        {f.rules.map((r, i) => (
          <div key={r.id} className="grid gap-3 items-end p-4 rounded-xl border border-border bg-sunken grid-cols-1 md:grid-cols-[200px_1fr_140px_44px]">
            <Field label="Type" htmlFor={`t-${r.id}`}>
              <select id={`t-${r.id}`} className={inputCls} value={r.type} onChange={(e) => update(i, { type: e.target.value as RuleType })}>
                <option value="transfer_limit">Transfer limit</option>
                <option value="secret">Secret</option>
                <option value="forbidden_tool">Forbidden tool</option>
              </select>
            </Field>
            <Field label="Rule, in plain English" htmlFor={`x-${r.id}`}>
              <input id={`x-${r.id}`} className={inputCls} value={r.text} maxLength={200} onChange={(e) => update(i, { text: e.target.value })} />
            </Field>
            {r.type === "transfer_limit" ? (
              <Field label="Limit (USDC)" htmlFor={`l-${r.id}`}>
                <input id={`l-${r.id}`} className={`${inputCls} mono`} value={r.maxAmount} onChange={(e) => update(i, { maxAmount: e.target.value })} />
              </Field>
            ) : r.type === "secret" ? (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-soft">Placeholder</span>
                <span className="mono h-11 flex items-center text-xs text-accent break-all">{`{{SECRET:${r.id}}}`}</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-soft">Tool</span>
                <span className="mono h-11 flex items-center text-xs">emergency_withdraw</span>
              </div>
            )}
            <button
              type="button"
              aria-label={`Remove rule ${i + 1}`}
              onClick={() => setF((x) => ({ ...x, rules: x.rules.filter((_, k) => k !== i) }))}
              className="w-11 h-11 rounded-[10px] border border-border-strong bg-transparent text-muted grid place-items-center cursor-pointer hover:text-text"
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <Button
          variant="ghost"
          disabled={f.rules.length >= MAX_INVARIANTS}
          onClick={() =>
            setF((x) => ({ ...x, rules: [...x.rules, { id: nextId("inv", x.rules.map((r) => r.id)), type: "transfer_limit", text: "", maxAmount: "10" }] }))
          }
        >
          <PlusIcon /> Add rule
        </Button>
        <span className="text-xs text-faint">
          {f.rules.length} of {MAX_INVARIANTS} rules
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- step 3

function ChecksStep({ f, setF }: { f: Form; setF: React.Dispatch<React.SetStateAction<Form>> }) {
  const update = (i: number, patch: Partial<CheckRow>) => setF((x) => ({ ...x, checks: x.checks.map((c, k) => (k === i ? { ...c, ...patch } : c)) }));
  return (
    <Card className="p-7 flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold">Prove your agent still does its job</h2>
        <p className="m-0 text-muted leading-relaxed">
          Add normal requests your agent should handle. Every 15 minutes we send them, each in a fresh chat. If 2 or more fail in a round, Breakers get refunded from your bond; 3 failed
          rounds in a row cancels the contest. This stops anyone winning with an agent that refuses everything.
        </p>
      </div>
      <Callout tone="neutral" icon={<LockIcon size={16} />}>
        Hidden until the contest ends. Breakers only see a fingerprint, and the agent can&apos;t tell these from real chats. Payments made during checks are simulated; no money moves.
      </Callout>
      <div className="flex flex-col gap-3">
        {f.checks.map((c, i) => (
          <div key={c.id} className="grid gap-3 items-end p-4 rounded-xl border border-border bg-sunken grid-cols-1 md:grid-cols-[1fr_180px_170px_44px]">
            <Field label={`Request ${i + 1}`} htmlFor={`p-${c.id}`}>
              <input id={`p-${c.id}`} className={inputCls} value={c.prompt} maxLength={1000} onChange={(e) => update(i, { prompt: e.target.value })} />
            </Field>
            <Field label="Check" htmlFor={`k-${c.id}`}>
              <select
                id={`k-${c.id}`}
                className={inputCls}
                value={c.kind}
                onChange={(e) => update(i, { kind: e.target.value as CheckRow["kind"], value: e.target.value === "tool" ? (f.tools[0] ?? "vault_balance") : "" })}
              >
                <option value="tool">Must use tool</option>
                <option value="contains">Reply must contain</option>
              </select>
            </Field>
            {c.kind === "tool" ? (
              <Field label="Tool" htmlFor={`v-${c.id}`}>
                <select id={`v-${c.id}`} className={`${inputCls} mono text-xs`} value={c.value} onChange={(e) => update(i, { value: e.target.value })}>
                  {f.tools.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Text (comma-separated)" htmlFor={`v-${c.id}`}>
                <input id={`v-${c.id}`} className={`${inputCls} mono text-xs`} value={c.value} onChange={(e) => update(i, { value: e.target.value })} />
              </Field>
            )}
            <button
              type="button"
              aria-label={`Remove request ${i + 1}`}
              onClick={() => setF((x) => ({ ...x, checks: x.checks.filter((_, k) => k !== i) }))}
              className="w-11 h-11 rounded-[10px] border border-border-strong bg-transparent text-muted grid place-items-center cursor-pointer hover:text-text"
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <Button
          variant="ghost"
          disabled={f.checks.length >= MAX_CANARIES}
          onClick={() =>
            setF((x) => ({ ...x, checks: [...x.checks, { id: nextId("can", x.checks.map((c) => c.id)), prompt: "", kind: "tool", value: x.tools[0] ?? "vault_balance" }] }))
          }
        >
          <PlusIcon /> Add request
        </Button>
        <span className="text-xs text-faint">{f.checks.length} requests · minimum 5, maximum 10</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- step 4

function MoneyStep({ f, set }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void }) {
  const windowLabel = windowText(useConfig().data?.windowSeconds);
  const { balances } = useWallet();
  const total = sum(f.pool, f.vault, f.bond);
  const minBond = isDecimalString(f.pool) ? fromBaseUnits((toBaseUnits(f.pool) * BigInt(MIN_BOND_PERCENT)) / 100n) : "?";
  const enough = balances ? toBaseUnits(balances.usdc) >= total : null;
  const endsAt = fromLocalInput(f.start) + 28_800;
  return (
    <div className="flex flex-wrap gap-5 items-start">
      <Card className="flex-[1.4_1_420px] min-w-0 p-7 flex flex-col gap-5">
        <h2 className="m-0 text-xl font-semibold">Money &amp; time</h2>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <Field label="Prize pool (USDC)" htmlFor="pool" help="Paid in full to whoever breaks a rule. Grows by 70% of every message fee.">
            <input
              id="pool"
              className={`${inputCls} mono`}
              value={f.pool}
              inputMode="decimal"
              onChange={(e) => {
                set("pool", e.target.value);
                if (isDecimalString(e.target.value)) set("bond", fromBaseUnits((toBaseUnits(e.target.value) * BigInt(MIN_BOND_PERCENT)) / 100n));
              }}
            />
          </Field>
          <Field label="Agent's wallet (USDC)" htmlFor="vault" help="Money the agent controls. Whatever it's tricked into sending is lost.">
            <input id="vault" className={`${inputCls} mono`} value={f.vault} inputMode="decimal" onChange={(e) => set("vault", e.target.value)} />
          </Field>
          <Field label="Bond (USDC)" htmlFor="bond" help={`At least ${MIN_BOND_PERCENT}% of the pool (${minBond}). Pays refunds if your agent fails health checks.`}>
            <input id="bond" className={`${inputCls} mono`} value={f.bond} inputMode="decimal" onChange={(e) => set("bond", e.target.value)} />
          </Field>
          <Field label="Price per message (USDC)" htmlFor="price" help="Minimum 0.01. Slow replies are never charged.">
            <input id="price" className={`${inputCls} mono`} value={f.price} inputMode="decimal" onChange={(e) => set("price", e.target.value)} />
          </Field>
          <Field label="Start time" htmlFor="start" help="At least 1 minute from now, at most 7 days.">
            <input id="start" type="datetime-local" className={`${inputCls} mono`} value={f.start} onChange={(e) => set("start", e.target.value)} />
          </Field>
          <Field label="Length" help={Number.isFinite(endsAt) ? `Ends ${new Date(endsAt * 1000).toLocaleString()}` : undefined}>
            <span className={`${inputCls} mono flex items-center text-muted`}>{windowLabel} (fixed)</span>
          </Field>
        </div>
      </Card>
      <Card className="flex-[1_1_280px] min-w-0 p-6 flex flex-col gap-1">
        <span className="eyebrow mb-2">You will deposit</span>
        {[
          ["Prize pool", f.pool],
          ["Agent's wallet", f.vault],
          ["Bond", f.bond],
        ].map(([l, v]) => (
          <div key={l} className="flex justify-between py-2.5 border-b border-line text-sm">
            <span className="text-muted">{l}</span>
            <span className="mono">{isDecimalString(v!) ? formatUsdc(v!) : "—"}</span>
          </div>
        ))}
        <div className="flex justify-between items-baseline py-2.5 font-semibold">
          <span>Total</span>
          <span className="mono text-xl text-accent">{formatUsdc(fromBaseUnits(total))} USDC</span>
        </div>
        {enough !== null && (
          <span className={cx("inline-flex items-center gap-1.5 text-xs", enough ? "text-open" : "text-broken-text")}>
            {enough ? <CheckIcon size={12} /> : <XIcon size={12} />}
            Your wallet has {formatUsdc(balances!.usdc)} USDC
          </span>
        )}
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-2">
          <span className="eyebrow">Each message fee is split</span>
          <div className="flex h-2.5 rounded overflow-hidden">
            <span className="w-[70%] bg-accent" />
            <span className="w-[20%] bg-held" />
            <span className="w-[10%] bg-soft" />
          </div>
          <span className="text-xs text-faint leading-relaxed">70% prize pool · 20% arena (runs the AI) · 10% to you, held until the end</span>
        </div>
        <div className="mt-3 pt-4 border-t border-border flex flex-col gap-1.5">
          <span className="eyebrow">You get it all back if</span>
          <span className="text-xs text-faint leading-relaxed">Nobody breaks a rule in {windowLabel}: pool + wallet + bond + your 10% return to you, with a public &quot;survived&quot; record.</span>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- step 5

type LaunchState = "idle" | "running" | "done" | "error";
const LAUNCH_STEPS = ["Checking your submission", "Approving USDC", "Creating contest on Hedera", "Loading your agent into the arena"];

function LaunchStep({ f, issues, onEdit }: { f: Form; issues: ValidationIssue[]; onEdit: (s: number) => void }) {
  const windowLabel = windowText(useConfig().data?.windowSeconds);
  const router = useRouter();
  const { wallet, openDrawer, refreshBalances } = useWallet();
  const [state, setState] = useState<LaunchState>("idle");
  const [current, setCurrent] = useState(-1);
  const [links, setLinks] = useState<(string | null)[]>([null, null, null, null]);
  const [error, setError] = useState<string | null>(null);
  const sub = toSubmission(f);
  const total = sum(f.pool, f.vault, f.bond);

  async function launch() {
    if (!wallet) return openDrawer();
    setState("running");
    setError(null);
    const l: (string | null)[] = [null, null, null, null];
    try {
      setCurrent(0);
      const draft = await api.createDraft(toSubmission(f));
      setCurrent(1);
      const approve = await api.ensureAllowance(wallet, BigInt(draft.approveTotalUnits));
      l[1] = approve?.hashscan ?? null;
      setLinks([...l]);
      setCurrent(2);
      const created = await api.createContestOnChain(wallet, draft);
      l[2] = created.hashscan;
      setLinks([...l]);
      setCurrent(3);
      await api.confirmDraft(draft.draftId, created.contestId);
      setCurrent(4);
      setState("done");
      refreshBalances();
      setTimeout(() => router.push(`/contests/${created.contestId}`), 900);
    } catch (e) {
      setError(friendlyError(e));
      setState("error");
    }
  }

  const rows: [string, React.ReactNode, number][] = [
    ["Agent", `${sub.card.name || "—"} · ${sub.package.model}`, 0],
    ["Tools", `${sub.package.tools.length} enabled`, 0],
    ["Rules", sub.invariants.map((i) => (i.type === "transfer_limit" ? `Transfer limit ≤ ${i.maxAmount} USDC` : i.type === "secret" ? "Secret" : "Forbidden tool")).join(" · ") || "—", 1],
    ["Health checks", `${sub.canaries.length} requests`, 2],
    ["Starts", Number.isFinite(sub.startTime) ? `${new Date(sub.startTime * 1000).toLocaleString()} · runs ${windowLabel}` : "—", 3],
    ["Price per message", `${sub.messagePrice} USDC`, 3],
    ["Prize pool", formatUsdc(isDecimalString(sub.pool) ? sub.pool : "0"), 3],
    ["Agent's wallet", formatUsdc(isDecimalString(sub.vaultFunding) ? sub.vaultFunding : "0"), 3],
    [`Bond (${MIN_BOND_PERCENT}%+ of pool)`, formatUsdc(isDecimalString(sub.bond) ? sub.bond : "0"), 3],
  ];

  return (
    <div className="flex flex-wrap gap-5 items-start">
      <Card className="flex-[1.2_1_420px] min-w-0 p-6 flex flex-col">
        <h2 className="m-0 mb-2 text-lg font-semibold">Summary</h2>
        {rows.map(([k, v, s]) => (
          <div key={k} className="flex justify-between gap-4 py-2.5 border-b border-line text-sm">
            <span className="text-muted">{k}</span>
            <span className="text-right flex items-center gap-2">
              {v}
              {state === "idle" && (
                <button type="button" onClick={() => onEdit(s)} className="text-xs text-faint hover:text-accent bg-transparent border-0 cursor-pointer">
                  Edit
                </button>
              )}
            </span>
          </div>
        ))}
        <div className="flex justify-between items-baseline pt-3 font-semibold">
          <span>You will deposit</span>
          <span className="mono text-xl text-accent">{formatUsdc(fromBaseUnits(total))} USDC</span>
        </div>
      </Card>
      <Card className="flex-[1_1_320px] min-w-0 p-6 flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">Launch</h2>
        {issues.length > 0 && (
          <Callout tone="broken" icon={<WarnIcon size={16} />}>
            Fix these first:
            <ul className="m-0 mt-1 pl-4">
              {[...new Set(issues.map((i) => i.message))].map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </Callout>
        )}
        <ol className="list-none m-0 p-0 flex flex-col gap-3">
          {LAUNCH_STEPS.map((label, i) => {
            const done = current > i;
            const active = current === i && state === "running";
            const failed = current === i && state === "error";
            return (
              <li key={label} className="flex items-center gap-3 text-sm">
                <span
                  className={cx(
                    "w-6 h-6 rounded-full grid place-items-center flex-none mono text-[11px] border",
                    done && "bg-open border-open text-[#0b0d12]",
                    active && "border-accent text-accent",
                    failed && "border-broken text-broken-text",
                    !done && !active && !failed && "border-border-strong text-faint",
                  )}
                >
                  {done ? <CheckIcon size={12} /> : failed ? <XIcon size={12} /> : active ? <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" /> : i + 1}
                </span>
                <span className={cx("flex-1", !done && !active && "text-muted")}>{label}</span>
                {links[i] && <HashscanLink href={links[i]!} />}
              </li>
            );
          })}
        </ol>
        {error && (
          <Callout tone="broken" icon={<WarnIcon size={16} />}>
            {error}
          </Callout>
        )}
        {state === "done" ? (
          <Callout tone="held" icon={<CheckIcon size={16} />}>
            Contest created. Opening it…
          </Callout>
        ) : !wallet ? (
          <Button onClick={openDrawer}>Connect wallet to launch</Button>
        ) : (
          <Button onClick={() => void launch()} disabled={issues.length > 0 || state === "running"}>
            {state === "running" ? "Launching…" : state === "error" ? "Try again" : `Launch · deposit ${formatUsdc(fromBaseUnits(total))} USDC`}
          </Button>
        )}
      </Card>
    </div>
  );
}
