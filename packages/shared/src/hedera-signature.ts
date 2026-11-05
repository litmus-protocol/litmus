import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes, keccak256, toBytes } from "viem";
import { hederaSignedMessage } from "./session";

export interface HederaAccountKey {
  keyType: "ED25519" | "ECDSA_SECP256K1";
  /** Hex public key as the mirror node reports it (raw or DER-encoded). */
  publicKey: string;
}

// DER prefixes the mirror node or wallets may put in front of raw public keys.
const ED25519_DER = "302a300506032b6570032100";
const ECDSA_DER = "302d300706052b8104000a032200";

function rawKey(hex: string, keyType: HederaAccountKey["keyType"]): Uint8Array {
  let k = hex.toLowerCase().replace(/^0x/, "");
  if (keyType === "ED25519" && k.startsWith(ED25519_DER)) k = k.slice(ED25519_DER.length);
  if (keyType === "ECDSA_SECP256K1" && k.startsWith(ECDSA_DER)) k = k.slice(ECDSA_DER.length);
  return hexToBytes(`0x${k}`);
}

/**
 * Verifies a `hedera_signMessage` signature (hedera-wallet-connect / HIP-820): the wallet signs
 * "\x19Hedera Signed Message:\n" + length + message — ED25519 over those bytes, ECDSA secp256k1
 * over their keccak256 (r||s, 64 bytes; a 65th recovery byte is ignored).
 */
export function verifyHederaMessage(message: string, signatureHex: string, key: HederaAccountKey): boolean {
  try {
    const bytes = toBytes(hederaSignedMessage(message));
    let sig = hexToBytes(signatureHex.startsWith("0x") ? (signatureHex as `0x${string}`) : `0x${signatureHex}`);
    const pub = rawKey(key.publicKey, key.keyType);
    if (key.keyType === "ED25519") return sig.length === 64 && ed25519.verify(sig, bytes, pub);
    if (sig.length === 65) sig = sig.subarray(0, 64);
    if (sig.length !== 64) return false;
    return secp256k1.verify(sig, hexToBytes(keccak256(bytes)), pub, { prehash: false, lowS: false });
  } catch {
    return false;
  }
}
