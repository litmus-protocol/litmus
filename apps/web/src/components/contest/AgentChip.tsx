import Link from "next/link";

/** Links a contest to the ERC-8004 agent identity its Warden attached. */
export function AgentChip({ agentId }: { agentId: number }) {
  return (
    <Link
      href={`/agents/${agentId}`}
      className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-md text-[11px] font-semibold tracking-[.02em] border whitespace-nowrap no-underline text-soft bg-chip border-border-strong hover:text-accent"
    >
      ERC-8004 agent #{agentId}
    </Link>
  );
}
