// Session-access message (build plan §11.3): signed by a Breaker to read their own
// transcript while a contest runs. Dev-key wallets sign it with EIP-191 (personal_sign);
// Hedera wallets connected through WalletConnect sign it with `hedera_signMessage`,
// which prefixes it as below before signing (ED25519 over the bytes, ECDSA secp256k1
// over keccak256 of the bytes).

export function sessionMessage(contestId: number, address: string, ts: number): string {
  return `Defect session access\ncontest:${contestId}\naddress:${address.toLowerCase()}\ntimestamp:${ts}`;
}

/** Exactly what a HIP-820 / hedera-wallet-connect wallet signs for `hedera_signMessage`. */
export function hederaSignedMessage(message: string): string {
  return "\x19Hedera Signed Message:\n" + message.length + message;
}
