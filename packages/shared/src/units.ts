// USDC amounts: integers in base units (6 decimals) on chain and in storage,
// decimal strings like "0.05" in human-facing JSON (build plan §6.1).

export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);
const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

export type DecimalString = string;

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

export function toBaseUnits(decimal: string): bigint {
  if (!isDecimalString(decimal)) {
    throw new Error(`Invalid USDC amount "${decimal}": use a plain decimal with at most 6 decimals`);
  }
  const [whole, frac = ""] = decimal.split(".");
  return BigInt(whole!) * SCALE + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

export function fromBaseUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Display helper: fixed 2 decimals unless more precision is needed (e.g. 0.035). */
export function formatUsdc(decimal: string | bigint, minDecimals = 2): string {
  const s = typeof decimal === "bigint" ? fromBaseUnits(decimal) : decimal;
  const [whole, frac = ""] = s.split(".");
  const padded = frac.length < minDecimals ? frac.padEnd(minDecimals, "0") : frac;
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return padded ? `${grouped}.${padded}` : grouped;
}
