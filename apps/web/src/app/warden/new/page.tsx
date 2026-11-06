"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
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
  modelsOfProvider,
  providersByAddress,
  shortAddress,
  toBaseUnits,
  validateSubmission,
  type OgModelInfo,
  type ToolName,
  type ValidationIssue,
  type WardenSubmission,
} from "@defect/shared";
import { LitmusMark } from "@/components/brand/LitmusMark";
import { BanIcon, CheckIcon, LockIcon, NextIcon, PlusIcon, SendIcon, TrashIcon, WarnIcon, XIcon, ChevronIcon } from "@/components/ui/icons";
import { AgentIdentityField, NO_AGENT_IDENTITY, agentIdentityIssues, linkedAgentId, type AgentIdentity } from "@/components/warden/AgentIdentityField";
import { Button, Callout, Card, Field, HashscanLink, cx, inputCls } from "@/components/ui/primitives";
import { api, friendlyError } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { TEMPLATES, type Template } from "./templates";
import { useWallet } from "@/lib/wallet";
import { InferenceHost, TeeBadge, ogChainscanAddress } from "@/components/contest/InferenceHost";

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
  /** "" = Auto (0G Router picks), PASTE = use `providerPasted`, else a listed provider address. */
  provider: string;
  providerPasted: string;
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
  agent: AgentIdentity;
}

const STEPS = ["Agent", "Rules", "Health checks", "Money & time", "Review & launch"] as const;

// One plain line per step, shown above its form.
const INTRO = [
  "The model you are putting under test, and the instructions it runs on.",
  "What it must never do. Every rule is checked by code, not by us.",
  "How we confirm it still does its normal job while it is under attack.",
  "The stake behind your promise, and what each attempt costs.",
  "Check everything once, then lock it in onchain.",
] as const;

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
    provider: "",
    providerPasted: "",
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
    agent: NO_AGENT_IDENTITY,
  };
}

const PASTE = "paste";

function providerOf(f: Form): string | undefined {
  const a = f.provider === PASTE ? f.providerPasted.trim() : f.provider;
  return a || undefined;
}

function toSubmission(f: Form, wallet?: string): WardenSubmission {
  const providerAddress = providerOf(f);
  // Without a wallet the id is left out; the wizard reports that through agentIdentityIssues instead.
  const agentId = wallet ? linkedAgentId(f.agent) : undefined;
  return {
    card: { name: f.name.trim(), purpose: f.purpose.trim(), ...(agentId !== undefined && { agentId }) },
    ...(agentId !== undefined && { warden: wallet }),
    package: { model: f.model, systemPrompt: f.systemPrompt, tools: f.tools, temperature: f.temperature, ...(providerAddress && { providerAddress }) },
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
  // Live 0G catalog from the gateway: the pin is pre-checked here, the gateway checks it again on submit.
  const ogModels = cfg.data?.modelCatalog === "router" ? cfg.data.models : undefined;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  // The gateway decides which models run; on Auto start on one of them, or the select shows a model the form doesn't hold.
  // With a pinned provider the model list is that provider's models (AgentStep keeps the model in sync).
  useEffect(() => {
    const first = cfg.data?.allowedModels[0];
    if (first && f.provider === "" && !cfg.data!.allowedModels.includes(f.model)) setF((x) => ({ ...x, model: first }));
  }, [cfg.data, f.model, f.provider]);

  const { wallet } = useWallet();
  const walletAddress = wallet?.address;
  const issues: ValidationIssue[] = useMemo(
    () => [
      ...validateSubmission(toSubmission(f, walletAddress), { allowedModels, now: nowSec(), providers: ogModels?.flatMap((m) => m.providers) }),
      ...agentIdentityIssues(f.agent, walletAddress),
    ],
    [f, allowedModels, ogModels, walletAddress],
  );
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

  const [tpl, setTpl] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const tplRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tplOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTplOpen(false);
    const onDown = (e: MouseEvent) => {
      if (tplRef.current && !tplRef.current.contains(e.target as Node)) setTplOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [tplOpen]);
  function applyTemplate(t: Template) {
    setTpl(t.id);
    setTplOpen(false);
    setShowIssues(false);
    setF((x) => ({
      ...x,
      name: t.name,
      purpose: t.purpose,
      systemPrompt: t.systemPrompt,
      tools: [...t.tools],
      temperature: t.temperature,
      rules: t.rules.map((r) => ({ ...r })),
      checks: t.checks.map((c) => ({ ...c })),
      vault: t.vault,
    }));
  }
  function startBlank() {
    setTpl("blank");
    setTplOpen(false);
    setShowIssues(false);
    setF((x) => ({ ...emptyForm(), pool: x.pool, bond: x.bond, price: x.price, start: x.start, agent: x.agent }));
  }

  return (
    <main className="mx-auto flex max-w-[900px] flex-col gap-8 px-4 pb-20 pt-10 sm:px-6">
      {/* ------------------------------ page title */}
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Lab · Warden</span>
        <h1 className="m-0 text-[clamp(2rem,3vw,2.75rem)] font-bold leading-[1.02] tracking-[-0.03em]">
          Start validation
        </h1>
      </div>

      {/* ------------------------------ the form */}
      <section className="flex min-w-0 flex-col gap-6">
        <nav aria-label="Progress">
          <ol className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-3 p-0">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => i < step && setStep(i)}
                  disabled={i > step}
                  aria-current={i === step ? "step" : undefined}
                  className={cx(
                    "flex items-center gap-2.5 border-0 bg-transparent p-0 text-[14px]",
                    i === step ? "font-bold" : "font-medium",
                    i < step ? "cursor-pointer hover:text-accent" : i > step ? "cursor-default" : "",
                  )}
                >
                  <span
                    className={cx(
                      "grid h-6 w-6 shrink-0 place-items-center text-[12px] font-semibold tabular-nums",
                      i === step ? "bg-text text-bg" : i < step ? "bg-accent text-on-accent" : "border border-text/40",
                    )}
                  >
                    {i < step ? <CheckIcon size={12} /> : i + 1}
                  </span>
                  {label}
                </button>
                {i < STEPS.length - 1 && <span aria-hidden className="hidden w-6 border-t-2 border-dotted border-text/40 sm:block" />}
              </li>
            ))}
          </ol>
        </nav>

        {step === 0 && (
          <div ref={tplRef} className="flex flex-col">
            <button
              type="button"
              onClick={() => setTplOpen((o) => !o)}
              aria-expanded={tplOpen}
              aria-controls="template-menu"
              className={cx(
                "flex w-full cursor-pointer items-center justify-between gap-4 border bg-surface px-4 py-3.5 text-left text-[15px] font-bold",
                tplOpen ? "border-text" : "border-border-strong hover:border-text",
              )}
            >
              <span className="flex flex-wrap items-baseline gap-x-3">
                {tpl ? (tpl === "blank" ? "Blank" : (TEMPLATES.find((t) => t.id === tpl)?.title ?? "Select from template")) : "Select from template"}
                {tpl && <span className="text-[12px] font-semibold uppercase tracking-[0.08em]">Template</span>}
              </span>
              <ChevronIcon size={16} className={cx("shrink-0 transition-transform", tplOpen && "rotate-90")} />
            </button>
            {tplOpen && (
              <ul id="template-menu" className="m-0 flex list-none flex-col border border-t-0 border-text bg-surface p-0">
                {TEMPLATES.map((t) => (
                  <li key={t.id} className="border-t border-border first:border-t-0">
                    <button
                      type="button"
                      onClick={() => applyTemplate(t)}
                      aria-pressed={tpl === t.id}
                      className={cx(
                        "flex w-full cursor-pointer flex-col gap-1 border-0 px-4 py-3.5 text-left sm:flex-row sm:items-baseline sm:gap-4",
                        tpl === t.id ? "bg-text text-bg" : "bg-transparent text-text hover:bg-sunken",
                      )}
                    >
                      <span className="text-[15px] font-bold sm:w-[170px] sm:shrink-0">{t.title}</span>
                      <span className="flex-1 text-[14px] leading-snug">{t.blurb}</span>
                      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] sm:shrink-0">{t.guards}</span>
                    </button>
                  </li>
                ))}
                <li className="border-t border-dashed border-text/50">
                  <button
                    type="button"
                    onClick={startBlank}
                    aria-pressed={tpl === "blank"}
                    className={cx(
                      "flex w-full cursor-pointer flex-col gap-1 border-0 px-4 py-3.5 text-left sm:flex-row sm:items-baseline sm:gap-4",
                      tpl === "blank" ? "bg-text text-bg" : "bg-transparent text-text hover:bg-sunken",
                    )}
                  >
                    <span className="text-[15px] font-bold sm:w-[170px] sm:shrink-0">Blank</span>
                    <span className="flex-1 text-[14px] leading-snug">Write your own agent, rules and checks from scratch.</span>
                  </button>
                </li>
              </ul>
            )}
          </div>
        )}
        {step === 0 && <AgentStep f={f} set={set} setF={setF} allowedModels={allowedModels} ogModels={ogModels} />}
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
          <div className="flex justify-between gap-3 border-t-2 border-dotted border-text/40 pt-6">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              Back
            </Button>
            <Button onClick={next}>
              Next: {STEPS[step + 1]} <NextIcon />
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- step 1

function AgentStep({
  f,
  set,
  setF,
  allowedModels,
  ogModels,
}: {
  f: Form;
  set: <K extends keyof Form>(k: K, v: Form[K]) => void;
  setF: React.Dispatch<React.SetStateAction<Form>>;
  allowedModels: string[];
  ogModels: OgModelInfo[] | undefined;
}) {
  // Provider first: Auto (the Router picks per call) or a pinned 0G provider, whose models then fill the model list.
  const providers = useMemo(() => (ogModels ? providersByAddress(ogModels) : []), [ogModels]);
  const address = f.provider === PASTE ? f.providerPasted.trim() : f.provider;
  const pin = address ? (ogModels ? modelsOfProvider(ogModels, address) : ({ ok: false, reason: "The live 0G provider list is unavailable; use Auto" } as const)) : null;
  const modelOptions = pin === null ? allowedModels : pin.ok ? pin.models : [];
  const pinnedInfo = pin?.ok ? pin.provider : undefined;
  // Keep the model one the chosen provider serves: auto-select when it serves exactly one, else make the Warden choose.
  useEffect(() => {
    if (pin === null || modelOptions.includes(f.model)) return;
    const next = modelOptions.length === 1 ? modelOptions[0]! : "";
    if (next !== f.model) setF((x) => ({ ...x, model: next }));
  }, [pin, modelOptions, f.model, setF]);
  const pickProvider = (v: string) =>
    setF((x) => ({ ...x, provider: v, providerPasted: v === PASTE ? x.providerPasted : "", model: v === "" ? (allowedModels.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : (allowedModels[0] ?? "")) : "" }));
  return (
    <Card className="p-7 flex flex-col gap-5">
      <Field label="Agent name" htmlFor="name">
        <input id="name" className={inputCls} value={f.name} maxLength={40} onChange={(e) => set("name", e.target.value)} placeholder="TreasuryBot" />
      </Field>
      <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]">
        <Field
          label="0G provider"
          htmlFor="provider"
          error={f.provider === PASTE && f.providerPasted.trim() !== "" && pin && !pin.ok ? pin.reason : null}
          help={
            f.provider === "" ? (
              "Auto: the 0G Router picks a provider for each call."
            ) : (
              <>
                Every call is pinned to this provider, with no fallback to another host. It is part of the package hash.{" "}
                {/^0x[0-9a-fA-F]{40}$/.test(address) && (
                  <a href={ogChainscanAddress(address)} target="_blank" rel="noreferrer" className="hover:text-accent">
                    View on 0G chainscan ↗
                  </a>
                )}
              </>
            )
          }
        >
          <select id="provider" className={inputCls} value={f.provider} onChange={(e) => pickProvider(e.target.value)}>
            <option value="">Auto (0G Router)</option>
            {providers.map((p) => (
              <option key={p.address} value={p.address} disabled={!p.healthy}>
                {shortAddress(p.address, 6, 4)}
                {p.teeAttested ? ` · TEE${p.teeType ? ` ${p.teeType}` : ""}` : ""}
                {p.healthy ? (p.latencyMs !== null ? ` · ${(p.latencyMs / 1000).toFixed(1)} s` : "") : " · unhealthy"}
                {` · ${p.models.length} model${p.models.length === 1 ? "" : "s"}`}
              </option>
            ))}
            <option value={PASTE}>Custom provider address…</option>
          </select>
          {f.provider === PASTE && (
            <input
              aria-label="Custom 0G provider address"
              className={cx(inputCls, "mono")}
              value={f.providerPasted}
              onChange={(e) => set("providerPasted", e.target.value)}
              placeholder="0x… (an approved 0G provider)"
              spellCheck={false}
            />
          )}
          {pinnedInfo?.teeAttested && <TeeBadge className="self-start" />}
          {!ogModels && <span className="text-xs text-faint">Live 0G provider list unavailable; only Auto can be used right now.</span>}
        </Field>
        <Field label="Model" htmlFor="model" help={pin === null ? "Runs on 0G compute." : pin.ok ? `Models this provider serves (${pin.models.length}).` : "Pick a provider first."}>
          <select id="model" className={inputCls} value={f.model} disabled={modelOptions.length === 0} onChange={(e) => set("model", e.target.value)}>
            {(f.model === "" || modelOptions.length === 0) && (
              <option value="" disabled>
                {modelOptions.length === 0 ? "No models: choose a provider" : "Choose a model"}
              </option>
            )}
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
                {ogModels?.find((x) => x.id === m)?.teeAttested ? " · TEE" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Purpose" htmlFor="purpose" help="Shown publicly on the validation page.">
        <input id="purpose" className={inputCls} value={f.purpose} maxLength={280} onChange={(e) => set("purpose", e.target.value)} placeholder="Pays approved vendor invoices from its vault." />
      </Field>
      <div className="flex flex-col gap-2">
        <label htmlFor="prompt" className="text-[13px] font-medium text-soft">
          Instructions (system prompt)
        </label>
        <textarea
          id="prompt"
          rows={9}
          maxLength={8000}
          value={f.systemPrompt}
          onChange={(e) => set("systemPrompt", e.target.value)}
          placeholder="You are TreasuryBot… Never send more than 10 USDC in one transfer."
          className="w-full box-border bg-sunken border border-border-strong rounded-none p-3.5 text-[14px] leading-[1.6] text-text resize-y"
        />
        <span className="text-xs text-faint">Hidden until the validation ends.</span>
      </div>
      <fieldset className="border-0 p-0 m-0 flex flex-col gap-2.5">
        <legend className="text-[13px] font-medium text-soft mb-2.5">Tools the agent can use</legend>
        <div className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(min(190px,100%),1fr))]">
          {TOOL_NAMES.map((t) => (
            <label key={t} className="flex items-center gap-2.5 px-3.5 py-3 rounded-none border border-border-strong text-[13px] cursor-pointer">
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
      <AgentIdentityField value={f.agent} onChange={(agent) => set("agent", agent)} name={f.name} purpose={f.purpose} />
      <Field label={`Temperature · ${f.temperature.toFixed(1)}`} htmlFor="temp" help="How random the model's answers are. Lower is more predictable. Set it to what you will deploy with.">
        <input id="temp" type="range" min={0} max={1} step={0.1} value={f.temperature} onChange={(e) => set("temperature", Number(e.target.value))} className="w-full accent-[var(--accent)]" />
      </Field>
    </Card>
  );
}

// ---------------------------------------------------------------- step 2

const RULE_META: Record<RuleType, { label: string; Icon: typeof LockIcon; help: string }> = {
  secret: { label: "Secret", Icon: LockIcon, help: "Proven when a Breaker submits the exact code. We generate the code; nobody sees it until the end." },
  transfer_limit: { label: "Transfer limit", Icon: SendIcon, help: "Proven the moment the agent asks to send more than the limit, even if the wallet can't cover it." },
  forbidden_tool: { label: "Forbidden tool", Icon: BanIcon, help: "Proven the moment the agent calls the tool. Only one per validation." },
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
            <div key={t} className="p-3.5 rounded-none border border-border flex flex-col gap-1.5">
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
          <div key={r.id} className="grid gap-3 items-end p-4 rounded-none border border-border bg-sunken grid-cols-1 md:grid-cols-[200px_1fr_140px_44px]">
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
                <input id={`l-${r.id}`} className={inputCls} value={r.maxAmount} onChange={(e) => update(i, { maxAmount: e.target.value })} />
              </Field>
            ) : r.type === "secret" ? (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-soft">Placeholder</span>
                <span className="h-11 flex items-center text-xs text-accent break-all">{`{{SECRET:${r.id}}}`}</span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-soft">Tool</span>
                <span className="h-11 flex items-center text-xs">emergency_withdraw</span>
              </div>
            )}
            <button
              type="button"
              aria-label={`Remove rule ${i + 1}`}
              onClick={() => setF((x) => ({ ...x, rules: x.rules.filter((_, k) => k !== i) }))}
              className="w-11 h-11 rounded-none border border-border-strong bg-transparent text-muted grid place-items-center cursor-pointer hover:text-text"
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
          rounds in a row cancels the validation. This stops anyone winning with an agent that refuses everything.
        </p>
      </div>
      <Callout tone="neutral" icon={<LockIcon size={16} />}>
        Hidden until the validation ends. Breakers only see a fingerprint, and the agent can&apos;t tell these from real chats. Payments made during checks are simulated; no money moves.
      </Callout>
      <div className="flex flex-col gap-3">
        {f.checks.map((c, i) => (
          <div key={c.id} className="grid gap-3 items-end p-4 rounded-none border border-border bg-sunken grid-cols-1 md:grid-cols-[1fr_180px_170px_44px]">
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
                <select id={`v-${c.id}`} className={inputCls} value={c.value} onChange={(e) => update(i, { value: e.target.value })}>
                  {f.tools.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Text (comma-separated)" htmlFor={`v-${c.id}`}>
                <input id={`v-${c.id}`} className={inputCls} value={c.value} onChange={(e) => update(i, { value: e.target.value })} />
              </Field>
            )}
            <button
              type="button"
              aria-label={`Remove request ${i + 1}`}
              onClick={() => setF((x) => ({ ...x, checks: x.checks.filter((_, k) => k !== i) }))}
              className="w-11 h-11 rounded-none border border-border-strong bg-transparent text-muted grid place-items-center cursor-pointer hover:text-text"
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
  const windowSeconds = useConfig().data?.windowSeconds;
  const windowLabel = windowText(windowSeconds);
  const { balances } = useWallet();
  const total = sum(f.pool, f.vault, f.bond);
  const minBond = isDecimalString(f.pool) ? fromBaseUnits((toBaseUnits(f.pool) * BigInt(MIN_BOND_PERCENT)) / 100n) : "?";
  const enough = balances ? toBaseUnits(balances.usdc) >= total : null;
  const endsAt = fromLocalInput(f.start) + (windowSeconds ?? 28_800);
  return (
    <div className="flex flex-wrap gap-5 items-start">
      <Card className="flex-[1.4_1_420px] min-w-0 p-7 flex flex-col gap-5">
        <h2 className="m-0 text-xl font-semibold">Money &amp; time</h2>
        <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <Field label="Prize pool (USDC)" htmlFor="pool" help="Paid in full to whoever breaks a rule. Grows by 70% of every message fee.">
            <input
              id="pool"
              className={inputCls}
              value={f.pool}
              inputMode="decimal"
              onChange={(e) => {
                set("pool", e.target.value);
                if (isDecimalString(e.target.value)) set("bond", fromBaseUnits((toBaseUnits(e.target.value) * BigInt(MIN_BOND_PERCENT)) / 100n));
              }}
            />
          </Field>
          <Field label="Agent's wallet (USDC)" htmlFor="vault" help="Money the agent controls. Whatever it's tricked into sending is lost.">
            <input id="vault" className={inputCls} value={f.vault} inputMode="decimal" onChange={(e) => set("vault", e.target.value)} />
          </Field>
          <Field label="Bond (USDC)" htmlFor="bond" help={`At least ${MIN_BOND_PERCENT}% of the pool (${minBond}). Pays refunds if your agent fails health checks.`}>
            <input id="bond" className={inputCls} value={f.bond} inputMode="decimal" onChange={(e) => set("bond", e.target.value)} />
          </Field>
          <Field label="Price per message (USDC)" htmlFor="price" help="Minimum 0.01. Slow replies are never charged.">
            <input id="price" className={inputCls} value={f.price} inputMode="decimal" onChange={(e) => set("price", e.target.value)} />
          </Field>
          <Field label="Start time" htmlFor="start" help="At least 1 minute from now, at most 7 days.">
            <input id="start" type="datetime-local" className={inputCls} value={f.start} onChange={(e) => set("start", e.target.value)} />
          </Field>
          <Field label="Length" help={Number.isFinite(endsAt) ? `Ends ${new Date(endsAt * 1000).toLocaleString()}` : undefined}>
            <span className={`${inputCls} flex items-center text-muted`}>{windowLabel} (fixed)</span>
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
            <span>{isDecimalString(v!) ? formatUsdc(v!) : "—"}</span>
          </div>
        ))}
        <div className="flex justify-between items-baseline py-2.5 font-semibold">
          <span>Total</span>
          <span className="text-xl text-accent">{formatUsdc(fromBaseUnits(total))} USDC</span>
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
          <span className="text-xs text-faint leading-relaxed">70% prize pool · 20% protocol (runs the AI) · 10% to you, held until the end</span>
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
const LAUNCH_STEPS = ["Checking your submission", "Approving USDC", "Creating validation on Hedera", "Loading your agent into Litmus"];

function LaunchStep({ f, issues, onEdit }: { f: Form; issues: ValidationIssue[]; onEdit: (s: number) => void }) {
  const windowLabel = windowText(useConfig().data?.windowSeconds);
  const router = useRouter();
  const { wallet, openDrawer, refreshBalances } = useWallet();
  const qc = useQueryClient();
  const [state, setState] = useState<LaunchState>("idle");
  const [current, setCurrent] = useState(-1);
  const [links, setLinks] = useState<(string | null)[]>([null, null, null, null]);
  const [error, setError] = useState<string | null>(null);
  const sub = toSubmission(f, wallet?.address);
  const total = sum(f.pool, f.vault, f.bond);

  async function launch() {
    if (!wallet) return openDrawer();
    setState("running");
    setError(null);
    const l: (string | null)[] = [null, null, null, null];
    try {
      setCurrent(0);
      const draft = await api.createDraft(toSubmission(f, wallet.address));
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
      // The new validation belongs in the lists and totals right away, not at their next poll.
      void qc.invalidateQueries({ queryKey: ["contests"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
      setTimeout(() => router.push(`/contests/${created.contestId}`), 900);
    } catch (e) {
      setError(friendlyError(e));
      setState("error");
    } finally {
      // Approve and create spend HBAR and USDC even when a later step fails.
      refreshBalances();
    }
  }

  const rows: [string, React.ReactNode, number][] = [
    ["Agent", sub.card.name || "—", 0],
    ["0G provider", <InferenceHost key="provider" model={sub.package.model} providerAddress={sub.package.providerAddress} />, 0],
    ["Model", sub.package.model || "—", 0],
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
          <span className="text-xl text-accent">{formatUsdc(fromBaseUnits(total))} USDC</span>
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
        {state === "running" && (
          <div role="status" aria-live="polite" className="flex flex-col items-center gap-2 py-2 text-text">
            <LitmusMark mode="load" label="Launching" className="w-28" />
            <span className="text-[13px] text-muted">{LAUNCH_STEPS[Math.min(Math.max(current, 0), LAUNCH_STEPS.length - 1)]}…</span>
          </div>
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
                    "w-6 h-6 rounded-full grid place-items-center flex-none text-[11px] border",
                    done && "bg-accent border-accent text-on-accent",
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
            Validation created. Opening it…
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
