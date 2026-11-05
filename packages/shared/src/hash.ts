import { encodePacked, keccak256, stringToHex, toBytes, type Address, type Hex } from "viem";

/** JSON with keys sorted at every level and no whitespace (build plan §6.3). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("canonicalJson: unsupported value");
    return json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashJson(value: unknown): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}

export function secretHash(secret: string): Hex {
  return keccak256(toBytes(secret));
}

/** Must equal Solidity keccak256(abi.encodePacked(bytes(secret), msg.sender, salt)). */
export function commitment(secret: string, breaker: Address, salt: Hex): Hex {
  return keccak256(encodePacked(["bytes", "address", "bytes32"], [stringToHex(secret), breaker, salt]));
}
