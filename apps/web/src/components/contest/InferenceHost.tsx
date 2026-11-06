"use client";

import { shortAddress, type OgModelInfo } from "@defect/shared";
import { useConfig } from "@/lib/hooks";
import { cx } from "../ui/primitives";

/** 0G mainnet explorer page of a provider address. */
export const ogChainscanAddress = (address: string) => `https://chainscan.0g.ai/address/${address}`;

/** Live Router data for a provider of a model, when the gateway's catalog lists it. */
export function findProvider(models: OgModelInfo[] | undefined, model: string, address: string) {
  return models?.find((m) => m.id === model)?.providers.find((p) => p.address.toLowerCase() === address.toLowerCase());
}

export function TeeBadge({ className }: { className?: string }) {
  return (
    <span title="TEE-attested 0G provider (Router data)" className={cx("mono text-[10px] font-semibold px-1.5 py-px border border-open/50 text-open", className)}>
      TEE
    </span>
  );
}

/** Where a contest's inference runs: the pinned 0G provider (explorer link + TEE badge) or "Auto via 0G Router". */
export function InferenceHost({ model, providerAddress, className }: { model: string; providerAddress: string | null | undefined; className?: string }) {
  const cfg = useConfig();
  if (!providerAddress) return <span className={cx("text-soft", className)}>Auto via 0G Router</span>;
  const p = findProvider(cfg.data?.models, model, providerAddress);
  return (
    <span className={cx("inline-flex items-center gap-1.5 flex-wrap", className)}>
      <a href={ogChainscanAddress(providerAddress)} target="_blank" rel="noreferrer" className="mono text-soft hover:text-accent no-underline" title={providerAddress}>
        {shortAddress(providerAddress, 6, 4)} ↗
      </a>
      {p?.teeAttested && <TeeBadge />}
      {p && !p.healthy && <span className="text-[10px] text-broken">unhealthy</span>}
    </span>
  );
}
