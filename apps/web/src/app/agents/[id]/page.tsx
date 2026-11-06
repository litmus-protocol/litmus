"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { shortAddress, type AgentProfile, type AgentRecordEntry, type Erc8004AgentCard } from "@defect/shared";
import { BackIcon } from "@/components/ui/icons";
import { ButtonLink, Card, CardHeader, Chip, CopyText, HashscanLink, Skeleton, relativeTime } from "@/components/ui/primitives";
import { friendlyError } from "@/lib/api";
import { useAgent } from "@/lib/agent-hooks";

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
    <div className="grid grid-cols-3 gap-4 pt-5 border-t border-line">
      {items.map(([label, n]) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="eyebrow">{label}</span>
          <span className="mono text-[28px] font-semibold leading-none">{n.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function Services({ card }: { card: Erc8004AgentCard }) {
  if (!card.services.length) return null;
  return (
    <ul className="list-none m-0 p-0 flex flex-col gap-1 text-[13px]">
      {card.services.map((s, i) => (
        <li key={i} className="flex flex-wrap gap-x-2 text-muted min-w-0">
          <span className="eyebrow text-[10px] self-center">{s.name}</span>
          {isHttps(s.endpoint) ? (
            <a href={s.endpoint} target="_blank" rel="noreferrer noopener" className="mono text-soft hover:text-accent no-underline break-all">
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

function RecordRow({ r }: { r: AgentRecordEntry }) {
  const o = OUTCOME[r.tag1];
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 border-t border-line first:border-t-0">
      <Chip tone={o.tone}>{o.label}</Chip>
      <div className="flex-[1_1_200px] min-w-0 flex flex-col gap-0.5">
        <span className="text-sm">
          <span className="mono">{r.deployment}</span> contest #{r.contestId}
        </span>
        <span className="text-xs text-faint">{relativeTime(r.timestamp)}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="eyebrow text-[10px]">Tested package</span>
        {r.packageHash ? <CopyText text={r.packageHash} display={shortAddress(r.packageHash, 6, 4)} /> : <span className="mono text-xs text-faint">unknown</span>}
      </div>
      <HashscanLink tx={r.txHash} />
    </li>
  );
}

export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const id = /^(0|[1-9][0-9]*)$/.test(params.id) ? Number(params.id) : NaN;
  const agent = useAgent(id);

  if (!Number.isSafeInteger(id)) return <NotFound />;
  if (agent.isLoading) {
    return (
      <main className="max-w-[920px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
        <Skeleton className="h-4 w-28" />
        <Card className="p-6 flex flex-col gap-4">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-14 w-full" />
        </Card>
      </main>
    );
  }
  if (agent.isError || !agent.data) return <NotFound message={agent.error ? friendlyError(agent.error) : undefined} />;

  const a = agent.data;
  const card = a.card;
  const record = [...a.record].sort((x, y) => y.timestamp - x.timestamp);
  return (
    <main className="max-w-[920px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      <Link href="/" className="inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:text-text self-start">
        <BackIcon size={14} />
        All contests
      </Link>
      <Card className="p-6 flex flex-col gap-5">
        <div className="flex gap-4 items-start">
          {card?.image && isHttps(card.image) && (
            // Arbitrary https image chosen by the agent's owner; next/image would need every host allow-listed.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.image} alt="" referrerPolicy="no-referrer" className="w-16 h-16 rounded-[14px] border border-border object-cover flex-none" />
          )}
          <div className="flex flex-col gap-2 min-w-0">
            <span className="eyebrow">ERC-8004 agent #{a.agentId}</span>
            <h1 className="m-0 text-[30px] font-bold tracking-tight break-words">{card?.name ?? `Agent #${a.agentId}`}</h1>
            {card?.description ? (
              <p className="m-0 text-[15px] text-muted leading-relaxed break-words">{card.description}</p>
            ) : (
              <p className="m-0 text-[15px] text-muted">This agent&apos;s registration card couldn&apos;t be read.</p>
            )}
            {card && <Services card={card} />}
            <div className="flex items-center gap-2 text-xs text-muted">
              Owner <CopyText text={a.owner} display={shortAddress(a.owner, 6, 4)} />
            </div>
          </div>
        </div>
        <Counts counts={a.counts} />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Defect record" aside="Newest first" />
        {record.length ? (
          <ul className="list-none m-0 p-0">
            {record.map((r) => (
              <RecordRow key={`${r.tag1}-${r.deployment}-${r.contestId}-${r.txHash}`} r={r} />
            ))}
          </ul>
        ) : (
          <p className="m-0 px-5 py-4 text-[13px] text-muted">No Defect results have been posted for this agent yet.</p>
        )}
        <p className="m-0 px-5 py-3.5 border-t border-border text-xs text-faint leading-relaxed">
          Each result is about the exact package tested (model, prompt, tools), not about whatever this agent runs today.
        </p>
      </Card>
    </main>
  );
}

function NotFound({ message }: { message?: string }) {
  return (
    <main className="max-w-[720px] mx-auto px-4 py-20 flex flex-col items-center gap-4 text-center">
      <h1 className="m-0 text-2xl font-bold">Agent not found</h1>
      <p className="m-0 text-muted">{message ?? "This agent doesn't exist or couldn't be loaded."}</p>
      <ButtonLink href="/" variant="ghost">
        All contests
      </ButtonLink>
    </main>
  );
}
