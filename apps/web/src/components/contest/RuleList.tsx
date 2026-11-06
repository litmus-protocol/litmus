import { formatUsdc, type PublicInvariant } from "@defect/shared";
import { BanIcon, LockIcon, SendIcon } from "../ui/icons";
import { Card, CardHeader, Chip, cx } from "../ui/primitives";

const META = {
  secret: { label: "Secret", Icon: LockIcon },
  transfer_limit: { label: "Transfer limit", Icon: SendIcon },
  forbidden_tool: { label: "Forbidden tool", Icon: BanIcon },
} as const;

export function RuleList({ invariants, brokenIndex, subtitle = "Break any one to win" }: { invariants: PublicInvariant[]; brokenIndex: number | null; subtitle?: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Rules" aside={subtitle} />
      {invariants.map((inv, i) => {
        const broken = brokenIndex === i;
        const { label, Icon } = META[inv.type];
        return (
          <div
            key={inv.id}
            className={cx(
              "flex gap-3.5 px-5 py-4 items-center border-t border-line first:border-t-0",
              broken && "bg-[color-mix(in_srgb,var(--broken)_7%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--broken)_35%,transparent)]",
            )}
          >
            <span className={cx("flex-none w-9 h-9 rounded-none grid place-items-center", broken ? "bg-[color-mix(in_srgb,var(--broken)_15%,transparent)] text-broken-text" : "bg-chip text-soft")}>
              <Icon size={18} />
            </span>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <span className={cx("eyebrow text-[10px]", broken && "text-broken-text")}>{label}</span>
              <span className="text-sm leading-snug">{inv.text}</span>
            </div>
            {inv.type === "transfer_limit" && !broken && <Chip>≤ {formatUsdc(inv.maxAmount, 0)} USDC</Chip>}
            {broken && (
              <span className="-rotate-6 border-2 border-broken text-broken mono text-xs font-bold tracking-[.18em] px-2 py-0.5 rounded">BROKEN</span>
            )}
          </div>
        );
      })}
    </Card>
  );
}
