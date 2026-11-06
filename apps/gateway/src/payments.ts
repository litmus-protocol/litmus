import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { USDC_TOKEN_ID, X402_NETWORK, canonicalJson } from "@defect/shared";
import { keccak256, toBytes, type Hex } from "viem";

// x402 v2 on Hedera (build plan §10.5). The stock Hono middleware settles whenever the handler
// returns < 400; we need "deliver the reply but don't settle" for slow replies (D16), so the
// message route drives x402ResourceServer directly: verify → run → settle only if fast enough.

export const MAX_TIMEOUT_SECONDS = 60;

export type VerifyOutcome =
  | { ok: true; payer: string; requirements: PaymentRequirements }
  | { ok: false; reason: string };

export type SettleOutcome = { ok: true; txId: string; header: string } | { ok: false; reason: string };

export interface Payments {
  /** The x402 requirements a 402 advertises for a price in base units. */
  requirements(priceUnits: bigint): Promise<PaymentRequirements[]>;
  /** Base64 PAYMENT-REQUIRED header value for a price in base units. */
  paymentRequiredHeader(priceUnits: bigint, resourceUrl: string, description: string, error?: string): Promise<string>;
  /** Decodes a PAYMENT-SIGNATURE header; null when it is not a valid v2 payload. */
  decode(header: string): PaymentPayload | null;
  verify(payload: PaymentPayload, priceUnits: bigint, resourceUrl: string, description: string): Promise<VerifyOutcome>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleOutcome>;
}

/** Replay guard id: keccak256 of the signed Hedera transaction inside the payload (§10.5 step 4c). */
export function paymentId(payload: PaymentPayload): Hex {
  const inner = (payload as { payload?: { transaction?: unknown } }).payload;
  const tx = typeof inner?.transaction === "string" ? inner.transaction : canonicalJson(inner ?? null);
  return keccak256(toBytes(tx));
}

export class X402Payments implements Payments {
  private readonly server: x402ResourceServer;
  private init: Promise<void> | null = null;
  /** Requirements per price, so verify matches exactly what the 402 advertised. */
  private readonly cache = new Map<string, PaymentRequirements[]>();

  constructor(
    private readonly payTo: string,
    facilitator: FacilitatorClient | string,
  ) {
    const client = typeof facilitator === "string" ? new HTTPFacilitatorClient({ url: facilitator }) : facilitator;
    this.server = new x402ResourceServer(client).register(X402_NETWORK, new ExactHederaScheme());
  }

  /** Fetches the facilitator's /supported (fee payer etc.). Retried on the next call if it fails. */
  ready(): Promise<void> {
    this.init ??= this.server.initialize().catch((err) => {
      this.init = null;
      throw err;
    });
    return this.init;
  }

  async requirements(priceUnits: bigint): Promise<PaymentRequirements[]> {
    await this.ready();
    const key = priceUnits.toString();
    let reqs = this.cache.get(key);
    if (!reqs) {
      reqs = await this.server.buildPaymentRequirements({
        scheme: "exact",
        payTo: this.payTo,
        price: { asset: USDC_TOKEN_ID, amount: key },
        network: X402_NETWORK,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      });
      this.cache.set(key, reqs);
    }
    return reqs;
  }

  async paymentRequiredHeader(priceUnits: bigint, resourceUrl: string, description: string, error?: string): Promise<string> {
    const reqs = await this.requirements(priceUnits);
    const pr = await this.server.createPaymentRequiredResponse(
      reqs,
      { url: resourceUrl, description, mimeType: "application/json" },
      error ?? "PAYMENT-SIGNATURE header is required",
    );
    return encodePaymentRequiredHeader(pr);
  }

  decode(header: string): PaymentPayload | null {
    try {
      const p = decodePaymentSignatureHeader(header);
      return p && (p as { x402Version?: number }).x402Version === 2 ? p : null;
    } catch {
      return null;
    }
  }

  async verify(payload: PaymentPayload, priceUnits: bigint): Promise<VerifyOutcome> {
    const reqs = await this.requirements(priceUnits);
    const matched = this.server.findMatchingRequirements(reqs, payload);
    if (!matched) return { ok: false, reason: "Payment does not match the advertised requirements" };
    try {
      const r = await this.server.verifyPayment(payload, matched);
      if (!r.isValid) return { ok: false, reason: r.invalidMessage ?? r.invalidReason ?? "Payment is not valid" };
      if (!r.payer) return { ok: false, reason: "Facilitator did not report the payer" };
      return { ok: true, payer: r.payer, requirements: matched };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleOutcome> {
    try {
      const s = await this.server.settlePayment(payload, requirements);
      if (!s.success || !s.transaction) return { ok: false, reason: s.errorMessage ?? s.errorReason ?? "Settlement failed" };
      return { ok: true, txId: s.transaction, header: encodePaymentResponseHeader(s) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
