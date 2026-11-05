// HashScan link helpers (build plan §10.4).

export const HASHSCAN_TESTNET = "https://hashscan.io/testnet";

/** "0.0.X@secs.nanos" → ".../transaction/0.0.X-secs-nanos". EVM hashes pass through. */
export function hashscanTx(txId: string, base = HASHSCAN_TESTNET): string {
  const loc = txId.startsWith("0x") ? txId : txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return `${base}/transaction/${loc}`;
}

export function hashscanAccount(idOrAddress: string, base = HASHSCAN_TESTNET): string {
  return `${base}/account/${idOrAddress}`;
}

export function hashscanContract(idOrAddress: string, base = HASHSCAN_TESTNET): string {
  return `${base}/contract/${idOrAddress}`;
}

export function shortAddress(address: string, head = 4, tail = 2): string {
  if (address.length <= head + tail + 3) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
