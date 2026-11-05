// Secret format (build plan §6.4): "DFT-" + 26 base32 characters (130 bits).
export const SECRET_RE = /^DFT-[A-Z2-7]{26}$/;
export const SECRET_SCAN_RE = /DFT-[A-Z2-7]{26}/g;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_CHARS = 26;

export function isSecret(value: string): boolean {
  return SECRET_RE.test(value);
}

/** Cryptographically random secret. Uses Web Crypto, available in Node 22+ and browsers; never Math.random. */
export function generateSecret(): string {
  const bytes = new Uint8Array(SECRET_CHARS);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so taking the low 5 bits of each byte is uniform.
  let body = "";
  for (const b of bytes) body += BASE32_ALPHABET[b & 31];
  return `DFT-${body}`;
}

/** Placeholder the Warden writes in the system prompt for a secret invariant (build plan D4). */
export function secretPlaceholder(invariantId: string): string {
  return `{{SECRET:${invariantId}}}`;
}

export const PLACEHOLDER_RE = /\{\{([^}]*)\}\}/g;
