// Deployed contract addresses (build plan §8.7). P2 fills deployments.json; until then values are null.
import deployments from "./deployments.json";

export type DeploymentName = "prod" | "demo";

export interface ArenaDeployment {
  arena: `0x${string}` | null;
  block: number | null;
}

export function getArenaDeployment(name: DeploymentName): ArenaDeployment {
  const d = deployments.hederaTestnet[name] as { arena: string | null; block: number | null };
  return { arena: d.arena as `0x${string}` | null, block: d.block };
}

/** Like getArenaDeployment but throws when the contract has not been deployed yet. */
export function requireArenaAddress(name: DeploymentName): `0x${string}` {
  const { arena } = getArenaDeployment(name);
  if (!arena) throw new Error(`DefectArena "${name}" is not deployed yet: run Phase 2 and fill packages/shared/src/deployments.json`);
  return arena;
}

/** DefectCertificate for one arena deployment (build plan §8.9), or null if none is deployed for it yet. */
export function getCertificateAddress(name: DeploymentName): `0x${string}` | null {
  const d = deployments.hederaTestnet[name] as { certificate?: string | null };
  return (d.certificate ?? null) as `0x${string}` | null;
}

export function getAttestationsAddress(): `0x${string}` | null {
  return deployments.sepolia.attestations as `0x${string}` | null;
}

export function parseDeploymentName(value: string | undefined): DeploymentName {
  if (value === "prod" || value === "demo") return value;
  throw new Error(`ARENA_DEPLOYMENT must be "prod" or "demo" (got "${value ?? ""}")`);
}
