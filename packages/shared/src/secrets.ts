// Secret format (build plan §6.4): "DFT-" + 26 base32 characters (130 bits).
export const SECRET_RE = /^DFT-[A-Z2-7]{26}$/;
export const SECRET_SCAN_RE = /DFT-[A-Z2-7]{26}/g;

export function isSecret(value: string): boolean {
  return SECRET_RE.test(value);
}
