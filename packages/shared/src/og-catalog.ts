// Live model + provider catalog of the 0G Compute Router (GET /models, GET /providers).
// Used by the gateway (draft validation, GET /config) and the runner (load check), so both
// apply the same rule for which models and pinned providers a contest may use.

/**
 * The Router lists centralized upstreams (Claude, Gemini, …) under one shared pseudo-address.
 * Those are not 0G on-chain providers: they are never pinnable and never make a model eligible.
 */
export const OG_PSEUDO_PROVIDER = "0x000000003f486c7198d6203568a98d02b91f8044";

/** How long a fetched catalog is reused before the next refresh. */
export const OG_CATALOG_TTL_MS = 5 * 60_000;

export interface OgProviderInfo {
  address: `0x${string}`;
  /** Canonical (lowercase) model id the provider serves; matches GET /models ids. */
  model: string;
  healthy: boolean;
  /** Router-measured latency in ms, null when unknown. */
  latencyMs: number | null;
  uptime: number | null;
  /** Acknowledged by the Router; pinning an unacknowledged provider fails with 400 provider_model_mismatch. */
  teeAcknowledged: boolean;
  teeAttested: boolean;
  teeType: string | null;
}

export interface OgModelInfo {
  id: string;
  name: string;
  verifiability: string | null;
  teeAttested: boolean;
  /** 0G on-chain providers of this model that the Router has acknowledged (pseudo-address entries excluded). */
  providers: OgProviderInfo[];
}

export interface OgCatalogView {
  /** "router": live catalog; "static": env list fallback (Router unreachable or catalog disabled), no provider data. */
  source: "router" | "static";
  /** Unix ms of the last successful Router fetch, null for a static catalog. */
  fetchedAt: number | null;
  /** Models a contest may use. */
  models: OgModelInfo[];
}

export function isPseudoProvider(address: string): boolean {
  const a = address.toLowerCase();
  return a === OG_PSEUDO_PROVIDER || /^0x0{8}/.test(a);
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

interface RawModel {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  supported_parameters?: unknown;
  verifiability?: unknown;
  tee_attested?: unknown;
}
interface RawProvider {
  address?: unknown;
  canonical_id?: unknown;
  model_id?: unknown;
  is_healthy?: unknown;
  latency?: unknown;
  uptime?: unknown;
  tee_acknowledged?: unknown;
  tee_attested?: unknown;
  tee_type?: unknown;
}

function list(raw: unknown): unknown[] {
  const data = (raw as { data?: unknown } | null)?.data ?? raw;
  return Array.isArray(data) ? data : [];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parses GET /providers into 0G on-chain, Router-acknowledged providers. */
export function parseProviders(raw: unknown): OgProviderInfo[] {
  const out: OgProviderInfo[] = [];
  for (const r of list(raw) as RawProvider[]) {
    if (typeof r.address !== "string" || !ADDRESS_RE.test(r.address) || isPseudoProvider(r.address)) continue;
    const model = typeof r.canonical_id === "string" ? r.canonical_id : typeof r.model_id === "string" ? r.model_id : null;
    if (!model || r.tee_acknowledged !== true) continue;
    out.push({
      address: r.address as `0x${string}`,
      model: model.toLowerCase(),
      healthy: r.is_healthy === true,
      latencyMs: num(r.latency),
      uptime: num(r.uptime),
      teeAcknowledged: true,
      teeAttested: r.tee_attested === true,
      teeType: typeof r.tee_type === "string" ? r.tee_type : null,
    });
  }
  return out;
}

/**
 * Eligible models: chat models that support tool calls and are served by at least one 0G on-chain provider.
 * Models reachable only through centralized upstreams are excluded: 0G hosts all inference.
 */
export function buildCatalog(modelsRaw: unknown, providersRaw: unknown): OgModelInfo[] {
  const providers = parseProviders(providersRaw);
  const out: OgModelInfo[] = [];
  for (const m of list(modelsRaw) as RawModel[]) {
    if (typeof m.id !== "string" || m.type !== "chatbot") continue;
    if (!Array.isArray(m.supported_parameters) || !m.supported_parameters.includes("tools")) continue;
    const id = m.id;
    const own = providers.filter((p) => p.model === id.toLowerCase()).sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9));
    if (own.length === 0) continue;
    out.push({
      id,
      name: typeof m.name === "string" ? m.name : id,
      verifiability: typeof m.verifiability === "string" ? m.verifiability : null,
      teeAttested: m.tee_attested === true,
      providers: own,
    });
  }
  return out;
}

export function staticCatalog(models: string[]): OgCatalogView {
  return { source: "static", fetchedAt: null, models: models.map((id) => ({ id, name: id, verifiability: null, teeAttested: false, providers: [] })) };
}

/** Why a pinned provider is not usable for a model, or null when it is. `requireHealthy` is off for re-checks of an already-funded contest. */
export function providerIssue(catalog: OgCatalogView, model: string, address: string, opts: { requireHealthy: boolean }): string | null {
  if (catalog.source !== "router") return "The 0G provider list is unavailable right now; choose Auto or try again later";
  const m = catalog.models.find((x) => x.id === model);
  const p = m?.providers.find((x) => x.address.toLowerCase() === address.toLowerCase());
  if (!p) return `Provider ${address} is not a 0G provider of ${model}`;
  if (opts.requireHealthy && !p.healthy) return `Provider ${address} is not healthy right now`;
  return null;
}

export interface ModelCatalogOptions {
  /** Router base URL (…/v1). null disables the live catalog (e.g. a local non-0G model endpoint). */
  baseUrl: string | null;
  /** Used until the first successful fetch, or when the catalog is disabled. */
  fallbackModels: string[];
  ttlMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Cached Router catalog. A failed refresh keeps serving the last good snapshot; before any success it serves the env list. */
export class ModelCatalog {
  private snapshot: OgCatalogView | null = null;
  private inflight: Promise<OgCatalogView> | null = null;

  constructor(private readonly opts: ModelCatalogOptions) {}

  async get(): Promise<OgCatalogView> {
    const now = (this.opts.now ?? Date.now)();
    if (!this.opts.baseUrl) return staticCatalog(this.opts.fallbackModels);
    if (this.snapshot && now - this.snapshot.fetchedAt! < (this.opts.ttlMs ?? OG_CATALOG_TTL_MS)) return this.snapshot;
    this.inflight ??= this.refresh(now).finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async refresh(now: number): Promise<OgCatalogView> {
    const f = this.opts.fetchFn ?? fetch;
    const base = this.opts.baseUrl!.replace(/\/$/, "");
    try {
      const get = async (path: string) => {
        const res = await f(`${base}${path}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
        return res.json();
      };
      const [models, providers] = await Promise.all([get("/models"), get("/providers")]);
      const built = buildCatalog(models, providers);
      if (built.length === 0) throw new Error("no eligible models in the Router catalog");
      this.snapshot = { source: "router", fetchedAt: now, models: built };
      return this.snapshot;
    } catch (err) {
      this.opts.log?.(`0G catalog refresh failed: ${(err as Error).message}`);
      return this.snapshot ?? staticCatalog(this.opts.fallbackModels);
    }
  }
}

/** One 0G provider with every eligible model it serves (provider-first view of a catalog). */
export interface OgProviderView {
  address: `0x${string}`;
  /** True when at least one of its models is healthy. */
  healthy: boolean;
  /** Lowest known latency across its models, ms. */
  latencyMs: number | null;
  teeAttested: boolean;
  teeType: string | null;
  models: { id: string; healthy: boolean; latencyMs: number | null }[];
}

/** Groups a model→providers catalog by provider address (a provider may serve several models). Sorted healthy first, then latency. */
export function providersByAddress(models: OgModelInfo[]): OgProviderView[] {
  const byAddr = new Map<string, OgProviderView>();
  for (const m of models) {
    for (const p of m.providers) {
      const key = p.address.toLowerCase();
      let v = byAddr.get(key);
      if (!v) {
        v = { address: p.address, healthy: false, latencyMs: null, teeAttested: false, teeType: null, models: [] };
        byAddr.set(key, v);
      }
      v.models.push({ id: m.id, healthy: p.healthy, latencyMs: p.latencyMs });
      v.healthy ||= p.healthy;
      v.teeAttested ||= p.teeAttested;
      v.teeType ??= p.teeType;
      if (p.latencyMs !== null && (v.latencyMs === null || p.latencyMs < v.latencyMs)) v.latencyMs = p.latencyMs;
    }
  }
  return [...byAddr.values()].sort((a, b) => Number(b.healthy) - Number(a.healthy) || (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9));
}

/** Healthy models of a provider address (case-insensitive), or the reason none can be used. */
export function modelsOfProvider(
  models: OgModelInfo[],
  address: string,
): { ok: true; provider: OgProviderView; models: string[] } | { ok: false; reason: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, reason: "Enter a 0x address (40 hex characters)" };
  const provider = providersByAddress(models).find((p) => p.address.toLowerCase() === address.toLowerCase());
  if (!provider) return { ok: false, reason: "Not an approved 0G provider of any allowed model" };
  const healthy = provider.models.filter((m) => m.healthy).map((m) => m.id);
  if (healthy.length === 0) return { ok: false, reason: "This provider is not healthy right now" };
  return { ok: true, provider, models: healthy };
}
