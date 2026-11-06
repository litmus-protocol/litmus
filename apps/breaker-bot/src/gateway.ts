import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { USDC_TOKEN_ID, X402_NETWORK, type ContestDetail, type GatewayConfig, type MessageResult, type X402Discovery } from "@defect/shared";
import type { Wallet } from "./config";

export type SendOutcome = { ok: true; result: MessageResult } | { ok: false; status: number; code: string; message: string };

export interface Gateway {
  getContest(contestId: number): Promise<ContestDetail>;
  send(contestId: number, text: string): Promise<SendOutcome>;
}

/** A paid endpoint found through GET /.well-known/x402: messages go to `url`, and only `payTo` is paid. */
export interface PinnedEndpoint {
  contestId: number;
  url: string;
  payTo: string;
}

/**
 * Pays every message with x402 from the wallet's own Hedera account: no human approves anything.
 * Spend controls (Hedera bonus point): USDC only, and never more than `maxPriceUnits` per payment,
 * so a gateway asking for more than the contest price is refused by the client itself. With a
 * pinned endpoint, a 402 that names any other payee is refused too.
 */
export class HttpGateway implements Gateway {
  private readonly pay: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    wallet: Wallet,
    maxPriceUnits: bigint,
    private readonly agentId: number | null = null,
    private readonly pinned: PinnedEndpoint | null = null,
  ) {
    const signer = createClientHederaSigner(wallet.accountId, PrivateKey.fromStringECDSA(wallet.privateKey.replace(/^0x/, "")), {
      network: X402_NETWORK,
    });
    const client = new x402Client().register(X402_NETWORK, new ExactHederaScheme(signer)).setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{ network: X402_NETWORK, asset: USDC_TOKEN_ID, maxAmountPerPayment: maxPriceUnits.toString() }],
    });
    if (pinned) client.registerPolicy((_version, reqs) => reqs.filter((r) => r.payTo === pinned.payTo));
    this.pay = wrapFetchWithPayment(fetch, client);
  }

  async getConfig(): Promise<GatewayConfig> {
    const res = await fetch(`${this.baseUrl}/config`);
    if (!res.ok) throw new Error(`GET /config → HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as GatewayConfig;
  }

  async discover(): Promise<X402Discovery> {
    const res = await fetch(`${this.baseUrl}/.well-known/x402`);
    if (!res.ok) throw new Error(`GET /.well-known/x402 → HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as X402Discovery;
  }

  async getContest(contestId: number): Promise<ContestDetail> {
    const res = await fetch(`${this.baseUrl}/contests/${contestId}`);
    if (!res.ok) throw new Error(`GET /contests/${contestId} → HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as ContestDetail;
  }

  async send(contestId: number, text: string): Promise<SendOutcome> {
    let res: Response;
    try {
      const url = this.pinned?.contestId === contestId ? this.pinned.url : `${this.baseUrl}/contests/${contestId}/messages`;
      res = await this.pay(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.agentId !== null ? { "X-Agent-Id": String(this.agentId) } : {}) },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      // Spend controls or signing refused before anything was sent.
      return { ok: false, status: 0, code: "PAYMENT_NOT_SENT", message: err instanceof Error ? err.message : String(err) };
    }
    const body = (await res.json().catch(() => ({}))) as MessageResult & { error?: { code: string; message: string } };
    if (!res.ok) {
      return { ok: false, status: res.status, code: body.error?.code ?? `HTTP_${res.status}`, message: body.error?.message ?? "" };
    }
    return { ok: true, result: body };
  }
}
