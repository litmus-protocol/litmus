import { config } from "@/lib/config";
import { WarnIcon } from "../ui/icons";

export function TestnetBanner() {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-banner border-b border-banner-border text-warn text-xs font-medium text-center">
      <WarnIcon size={14} />
      <span>
        Testnet demo. Use only Hedera testnet keys.
        {config.dataMode === "mock" && <span className="ml-2 opacity-80">· Showing demo data (no real payments)</span>}
      </span>
    </div>
  );
}
