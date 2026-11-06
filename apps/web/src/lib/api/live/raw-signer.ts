// Everything a wallet needs on Hedera, built from one primitive: "sign this 32-byte hash with the
// account's secp256k1 key" (Privy embedded wallets expose it as the EIP-1193 method
// `secp256k1_sign`). From that:
//  - EVM transactions and EIP-191 messages, as a viem LocalAccount (same path as a pasted dev key:
//    signed here, sent through the JSON-RPC relay);
//  - native Hedera transactions (the x402 USDC transfer): Hedera's ECDSA_SECP256K1 rule is a
//    secp256k1 signature over keccak256(bodyBytes), 64 bytes r||s. The public key is recovered from
//    the signature itself, so a brand-new (hollow) account that has no key on the mirror node works.
// Loaded on demand by the live client.

import { AccountId, PublicKey, TokenId, TransactionId, TransferTransaction, type Transaction } from "@hiero-ledger/sdk";
import type { ClientHederaSigner } from "@x402/hedera";
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseSignature,
  recoverPublicKey,
  serializeTransaction,
  type Address,
  type Hex,
  type LocalAccount,
  type SerializeTransactionFn,
  type TransactionSerializable,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";

/** Signs a 32-byte hash with no prefix; returns the 65-byte r||s||v signature as hex. */
export type RawHashSigner = (hash: Hex) => Promise<Hex>;

const TESTNET_NODES = ["0.0.3", "0.0.4", "0.0.5", "0.0.6", "0.0.7", "0.0.8", "0.0.9"];

/** viem account whose every signature goes through `sign`. */
export function rawViemAccount(address: Address, sign: RawHashSigner): LocalAccount {
  return toAccount({
    address,
    sign: ({ hash }) => sign(hash),
    signMessage: ({ message }) => sign(hashMessage(message)),
    signTypedData: (typedData) => sign(hashTypedData(typedData as never)),
    async signTransaction(transaction, options) {
      // Same as viem's privateKeyToAccount: keccak of the unsigned serialization, then re-serialize with the signature.
      const serializer = (options?.serializer ?? serializeTransaction) as SerializeTransactionFn<TransactionSerializable>;
      const signable = (transaction.type === "eip4844" ? { ...transaction, sidecars: false } : transaction) as TransactionSerializable;
      const signature = parseSignature(await sign(keccak256(await serializer(signable))));
      return serializer(transaction as TransactionSerializable, signature);
    },
  });
}

/** Compressed (33-byte) secp256k1 public key recovered from a signature. */
async function recoverCompressed(hash: Hex, signature: Hex): Promise<{ compressed: Uint8Array; address: Address }> {
  const uncompressed = await recoverPublicKey({ hash, signature }); // 0x04 || x || y
  const bytes = hexToBytes(uncompressed);
  const out = new Uint8Array(33);
  out[0] = (bytes[64]! & 1) === 1 ? 0x03 : 0x02;
  out.set(bytes.slice(1, 33), 1);
  return { compressed: out, address: publicKeyToAddress(uncompressed).toLowerCase() as Address };
}

/**
 * Adds the account's ECDSA signature to a frozen Hedera transaction (every node body).
 * Checks the recovered key belongs to `address`, so a wrong key fails here and not at consensus.
 */
export async function signHederaTransaction<T extends Transaction>(tx: T, address: Address, sign: RawHashSigner): Promise<{ tx: T; publicKey: PublicKey }> {
  const bodies = tx.signableNodeBodyBytesList.map((b) => b.signableTransactionBodyBytes);
  const first = bodies[0];
  if (!first) throw new Error("Freeze the transaction before signing it.");
  const sigs = new Map<string, Hex>();
  const firstHash = keccak256(first);
  const firstSig = await sign(firstHash);
  sigs.set(bytesToHex(first), firstSig);
  const recovered = await recoverCompressed(firstHash, firstSig);
  if (recovered.address !== address.toLowerCase()) {
    throw new Error(`The wallet signed with a different key (${recovered.address}) than the account's (${address}).`);
  }
  const publicKey = PublicKey.fromBytesECDSA(recovered.compressed);
  await tx.signWith(publicKey, async (body) => {
    const sig = sigs.get(bytesToHex(body)) ?? (await sign(keccak256(body)));
    return hexToBytes(sig).slice(0, 64); // r || s; Hedera ignores v
  });
  return { tx, publicKey };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/**
 * x402 payer for a raw-hash signer: the same payer → payTo token transfer @x402/hedera's
 * createClientHederaSigner builds (transaction id from the facilitator's fee payer), frozen for one
 * node and signed here. The facilitator adds the fee payer signature and submits it.
 */
export function rawX402Signer(accountId: string, address: Address, sign: RawHashSigner): ClientHederaSigner {
  return {
    accountId,
    async createPartiallySignedTransferTransaction(requirements) {
      const feePayer = (requirements.extra as { feePayer?: unknown } | undefined)?.feePayer;
      if (typeof feePayer !== "string") throw new Error("feePayer is required in paymentRequirements.extra");
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("amount must be greater than zero");
      if (!/^\d+\.\d+\.\d+$/.test(requirements.asset)) throw new Error(`Unsupported x402 asset ${requirements.asset}`);
      const token = TokenId.fromString(requirements.asset);
      const node = TESTNET_NODES[Math.floor(Math.random() * TESTNET_NODES.length)]!;
      const tx = new TransferTransaction()
        .addTokenTransfer(token, AccountId.fromString(accountId), -amount)
        .addTokenTransfer(token, AccountId.fromString(requirements.payTo), amount)
        .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
        .setNodeAccountIds([AccountId.fromString(node)])
        .freeze();
      await signHederaTransaction(tx, address, sign);
      return toBase64(tx.toBytes());
    },
  };
}
