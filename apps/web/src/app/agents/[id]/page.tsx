"use client";

import Link from "next/link";
import { usePathParams } from "@/lib/route-params";
import { shortAddress, type AgentProfile, type AgentRecordEntry, type Erc8004AgentCard } from "@defect/shared";
import { LoadingMark } from "@/components/brand/LitmusMark";
import { AgentSeal } from "@/components/home/AgentSeal";
import { BackIcon } from "@/components/ui/icons";
import { ButtonLink, Card, CardHeader, Chip, CopyText, HashscanLink, Skeleton, relativeTime } from "@/components/ui/primitives";
import { friendlyError } from "@/lib/api";
import { useAgent } from "@/lib/agent-hooks";
import { useConfig } from "@/lib/hooks";

const OUTCOME: Record<AgentRecordEntry["tag1"], { label: string; tone: "held" | "broken" | "pass" }> = {
  "defect.held": { label: "Held", tone: "held" },
  "defect.broken": { label: "Broken", tone: "broken" },
  "defect.bounty": { label: "Bounty", tone: "pass" },
};

/** Card fields are chosen by whoever registered the agent: only https:// URLs become links or images. */
const isHttps = (url: string) => url.startsWith("https://");

function Counts({ counts }: { counts: AgentProfile["counts"] }) {
  const items = [
    ["Held", counts.held],
    ["Broken", counts.broken],
    ["Bounties won", counts.bounties],
  ] as const;
  return (
    <dl className="m-0 grid grid-cols-3 gap-3">
      {items.map(([label, n]) => (
        <div key={label} className="flex flex-col gap-2 border border-border bg-surface p-4">
          <dt className="eyebrow">{label}</dt>
          <dd className="m-0 font-accent text-[44px] font-black leading-none tracking-[-0.02em]">{n.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function Services({ card }: { card: Erc8004AgentCard }) {
  if (!card.services.length) return null;
  return (
    <ul className="list-none m-0 p-0 flex flex-col gap-1 text-[13px]">
      {card.services.map((s, i) => (
        <li key={i} className="flex flex-wrap gap-x-2 min-w-0">
          <span className="eyebrow text-[10px] self-center">{s.name}</span>
          {isHttps(s.endpoint) ? (
            <a href={s.endpoint} target="_blank" rel="noreferrer noopener" className="mono hover:text-accent no-underline break-all">
              {s.endpoint} ↗
            </a>
          ) : (
            <span className="mono break-all">{s.endpoint}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** `deployment` is this gateway's arena deployment; only its validations have a page on this site. */
function RecordRow({ r, deployment, last }: { r: AgentRecordEntry; deployment: string | undefined; last: boolean }) {
  const o = OUTCOME[r.tag1];
  const label = (
    <>
      <span className="mono">{r.deployment}</span> validation #{r.contestId}
    </>
  );
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {/* timeline: a square node and a dotted line down to the next entry */}
      <div className="flex flex-col items-center">
        <span className={`mt-1.5 h-3 w-3 shrink-0 ${r.tag1 === "defect.broken" ? "bg-broken" : r.tag1 === "defect.held" ? "bg-held" : "bg-text"}`} />
        {!last && <span aria-hidden className="mt-1 w-0 flex-1 border-l-2 border-dotted border-text/40" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 border border-border bg-surface px-5 py-4">
        <Chip tone={o.tone}>{o.label}</Chip>
        <div className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5">
          {r.deployment === deployment ? (
            <Link href={`/contests/${r.contestId}`} className="text-[15px] font-bold text-text no-underline hover:text-accent">
              {label}
            </Link>
          ) : (
            <span className="text-[15px] font-bold">{label}</span>
          )}
          <span className="text-xs">{relativeTime(r.timestamp)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow text-[10px]">Tested package</span>
          {r.packageHash ? <CopyText text={r.packageHash} display={shortAddress(r.packageHash, 6, 4)} /> : <span className="mono text-xs">unknown</span>}
        </div>
        <HashscanLink tx={r.txHash} />
      </div>
    </li>
  );
}

export default function AgentPage() {
  const agentId = usePathParams().agentId;
  const id = /^(0|[1-9][0-9]*)$/.test(agentId) ? Number(agentId) : NaN;
  const agent = useAgent(id);
  const cfg = useConfig();

  if (!Number.isSafeInteger(id)) return <NotFound />;
  if (agent.isLoading) {
    return (
      <main className="mx-auto max-w-[1180px] px-4 py-10 sm:px-6">
        <LoadingMark label="Loading agent" />
      </main>
    );
  }
  if (agent.isError || !agent.data) return <NotFound message={agent.error ? friendlyError(agent.error) : undefined} />;

  const a = agent.data;
  const card = a.card;
  const record = [...a.record].sort((x, y) => y.timestamp - x.timestamp);
  return (
    <main className="mx-auto grid max-w-[1180px] gap-10 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-14">
      {/* ------------------------------ rail: who this agent is */}
      <aside className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
        <Link href="/" className="inline-flex items-center gap-1.5 self-start text-[13px] font-medium text-text no-underline hover:text-accent">
          <BackIcon size={14} />
          All validations
        </Link>
        <div className="mx-auto w-full max-w-[200px] lg:mx-0 lg:max-w-[240px]">
          {card?.image && isHttps(card.image) ? (
            // Arbitrary https image chosen by the agent's owner; next/image would need every host allow-listed.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.image} alt="" referrerPolicy="no-referrer" className="aspect-square w-full border border-border object-cover" />
          ) : (
            <AgentSeal agentId={a.agentId} owner={a.owner} />
          )}
        </div>
        <dl className="m-0 flex flex-col gap-2 border-t-2 border-dotted border-text/40 pt-5 font-accent text-[12px] font-bold uppercase tracking-[0.1em]">
          <div className="flex justify-between gap-3">
            <dt>Standard</dt>
            <dd className="m-0">ERC-8004</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Agent</dt>
            <dd className="m-0">#{a.agentId}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt>Owner</dt>
            <dd className="m-0 normal-case tracking-normal">
              <CopyText text={a.owner} display={shortAddress(a.owner, 6, 4)} />
            </dd>
          </div>
        </dl>
      </aside>

      {/* ------------------------------ the agent and its record */}
      <section className="flex min-w-0 flex-col gap-8">
        <div className="flex flex-col gap-3 border-b-2 border-dotted border-text/40 pb-6">
          <span className="eyebrow">ERC-8004 agent</span>
          <h1 className="m-0 break-words text-[clamp(2.2rem,3.6vw,3.5rem)] font-bold leading-[1.02] tracking-[-0.03em]">
            {card?.name ?? `Agent #${a.agentId}`}
          </h1>
          {card?.description ? (
            <p className="m-0 max-w-2xl break-words text-[16px] leading-relaxed">{card.description}</p>
          ) : (
            <p className="m-0 text-[16px]">This agent&apos;s registration card couldn&apos;t be read.</p>
          )}
          {card && <Services card={card} />}
        </div>

        <Counts counts={a.counts} />

        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="m-0 font-accent text-[15px] font-black uppercase tracking-[0.14em]">Track record</h2>
            <span className="eyebrow">Newest first</span>
          </div>
          {record.length ? (
            <ul className="m-0 list-none p-0">
              {record.map((r, i) => (
                <RecordRow key={`${r.tag1}-${r.deployment}-${r.contestId}-${r.txHash}`} r={r} deployment={cfg.data?.deployment} last={i === record.length - 1} />
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-2 border border-dashed border-text/50 p-6">
              <span className="text-[16px] font-bold">Nothing on record yet.</span>
              <span className="text-[14px] leading-relaxed">Results are written on-chain after a validation of this agent ends. They appear here once posted.</span>
            </div>
          )}
          <p className="m-0 border-t-2 border-dotted border-text/40 pt-4 text-[13px] leading-relaxed">
            Each result is about the exact package tested (model, prompt, tools), not about whatever this agent runs today.
          </p>
        </div>
      </section>
    </main>
  );
}

function NotFound({ message }: { message?: string }) {
  return (
    <main className="max-w-[720px] mx-auto px-4 py-20 flex flex-col items-center gap-4 text-center">
      <h1 className="m-0 text-2xl font-bold">Agent not found</h1>
      <p className="m-0">{message ?? "This agent doesn't exist or couldn't be loaded."}</p>
      <ButtonLink href="/" variant="ghost">
        All validations
      </ButtonLink>
    </main>
  );
}
