"use client";

// Dev-only wallet check (not linked anywhere): exercises the real WalletConnect path with no
// gateway, runner or keys. Every transaction here is signed only and never submitted.

import { useEffect, useState, type ReactNode } from "react";
import { encodeFunctionData, keccak256, toBytes } from "viem";
import {
  USDC_TOKEN_ID,
  X402_NETWORK,
  defectArenaAbi,
  hashscanAccount,
  requireArenaAddress,
  sessionMessage,
  verifyHederaMessage,
} from "@defect/shared";
import { friendlyError, type ConnectedWallet } from "@/lib/api";
import { config } from "@/lib/config";
import { mirrorAccountKey, type MirrorKeyInfo } from "@/lib/hedera-account";
import { useWallet } from "@/lib/wallet";
import { Button, Callout } from "@/components/ui/primitives";
import { WarnIcon } from "@/components/ui/icons";

const FEE_PAYER = "0.0.9185802"; // x402.org facilitator fee payer on Hedera testnet
const PAY_TO = "0.0.9185802";
const AMOUNT_UNITS = "10000"; // 0.01 USDC

type Result = { ok: boolean; lines: [string, ReactNode][] } | { error: string } | null;

/** Decodes signed transaction bytes and checks the payer's key signed every node entry. */
async function inspectSigned(bytes: Uint8Array, key: MirrorKeyInfo) {
  const [{ Transaction, PublicKey }, { proto }] = await Promise.all([import("@hiero-ledger/sdk"), import("@hiero-ledger/proto")]);
  const tx = Transaction.fromBytes(bytes);
  const pub = key.keyType === "ED25519" ? PublicKey.fromStringED25519(key.publicKey) : PublicKey.fromStringECDSA(key.publicKey);
  const valid = pub.verifyTransaction(tx);
  const list = proto.TransactionList.decode(bytes).transactionList;
  const sigPairs = list.map((t) => (t.signedTransactionBytes ? proto.SignedTransaction.decode(t.signedTransactionBytes).sigMap?.sigPair?.length ?? 0 : 0));
  return { tx, valid, entries: list.length, sigPairs };
}

export default function WalletTestPage() {
  const { wallet, connectWallet, walletOptions, loadWalletOptions, forget, connecting, error } = useWallet();
  const [key, setKey] = useState<MirrorKeyInfo | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});

  useEffect(() => {
    if (config.walletConnectProjectId) loadWalletOptions();
  }, [loadWalletOptions]);

  const wc: ConnectedWallet | null = wallet?.kind === "walletconnect" ? wallet : null;

  useEffect(() => {
    setKey(null);
    setKeyError(null);
    if (!wc) return;
    mirrorAccountKey(wc.accountId).then(setKey, (e) => setKeyError(friendlyError(e)));
  }, [wc?.accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = async (id: string, fn: () => Promise<Result>) => {
    setBusy(id);
    setResults((r) => ({ ...r, [id]: null }));
    try {
      const res = await fn();
      setResults((r) => ({ ...r, [id]: res }));
    } catch (e) {
      console.error(`[wallet-test] ${id}`, e);
      setResults((r) => ({ ...r, [id]: { error: friendlyError(e) } }));
    } finally {
      setBusy(null);
    }
  };

  const signMessage = () =>
    step("message", async () => {
      const hw = await import("@/lib/api/live/hedera-wallet");
      const ts = Math.floor(Date.now() / 1000);
      const message = sessionMessage(0, wc!.address, ts);
      const sig = await hw.signSessionMessage(wc!, message);
      // Same verifier the gateway runs on X-Defect-Account requests.
      const ok = verifyHederaMessage(message, sig, key!);
      const tampered = verifyHederaMessage(sessionMessage(1, wc!.address, ts), sig, key!);
      return {
        ok: ok && !tampered,
        lines: [
          ["Message", <pre key="m" className="m-0 whitespace-pre-wrap mono text-xs">{message}</pre>],
          ["Signature", <span key="s" className="mono text-xs break-all">{sig}</span>],
          ["Verifies against mirror key", ok ? "yes" : "NO"],
          ["Different message rejected", tampered ? "NO (verified a wrong message)" : "yes"],
        ],
      };
    });

  const signX402 = () =>
    step("x402", async () => {
      const hw = await import("@/lib/api/live/hedera-wallet");
      const requirements = {
        scheme: "exact",
        network: X402_NETWORK,
        amount: AMOUNT_UNITS,
        asset: USDC_TOKEN_ID,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { feePayer: FEE_PAYER },
      } as Parameters<ReturnType<typeof hw.x402Signer>["createPartiallySignedTransferTransaction"]>[0];
      // Exactly what a paid message sends as the x402 payload (sign only, never submitted here).
      const b64 = await hw.x402Signer(wc!).createPartiallySignedTransferTransaction(requirements);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const { tx, valid, entries, sigPairs } = await inspectSigned(bytes, key!);
      return {
        ok: valid && entries === 1,
        lines: [
          ["Transaction id", <span key="t" className="mono text-xs">{tx.transactionId?.toString()}</span>],
          ["Payer of fees (tx id account)", FEE_PAYER],
          ["Transfer", `${Number(AMOUNT_UNITS) / 1e6} USDC (${USDC_TOKEN_ID}) ${wc!.accountId} → ${PAY_TO}`],
          ["Node entries", String(entries)],
          ["Signatures per entry", sigPairs.join(", ")],
          ["Payer signature valid (verifyTransaction)", valid ? "yes" : "NO"],
          ["base64 length", String(b64.length)],
          ["Submitted", "no (sign only)"],
        ],
      };
    });

  const signCommit = () =>
    step("commit", async () => {
      const hw = await import("@/lib/api/live/hedera-wallet");
      const { AccountId, ContractExecuteTransaction, TransactionId } = await import("@hiero-ledger/sdk");
      const arena = requireArenaAddress("demo");
      const dummy = keccak256(toBytes(`defect wallet-test ${Date.now()}`));
      const data = encodeFunctionData({ abi: defectArenaAbi, functionName: "commitBreak", args: [1n, dummy] });
      const tx = new ContractExecuteTransaction()
        .setContractId(await hw.contractIdOf(arena))
        .setGas(300_000)
        .setFunctionParameters(toBytes(data))
        .setTransactionId(TransactionId.generate(AccountId.fromString(wc!.accountId)))
        .setNodeAccountIds(hw.pickNodes(1))
        .freeze();
      const signed = await hw.signOnly(wc!, tx);
      const { valid, entries, sigPairs } = await inspectSigned(signed.toBytes(), key!);
      return {
        ok: valid,
        lines: [
          ["Contract", <span key="c" className="mono text-xs">{arena}</span>],
          ["Call", <span key="f" className="mono text-xs break-all">commitBreak(1, {dummy})</span>],
          ["Node entries / signatures", `${entries} / ${sigPairs.join(", ")}`],
          ["Signature valid", valid ? "yes" : "NO"],
          ["Submitted", "no (sign only)"],
        ],
      };
    });

  return (
    <main className="mx-auto max-w-[760px] px-4 py-10 flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-2xl font-semibold">Wallet test</h1>
        <p className="m-0 text-muted">Developer check of the HashPack / WalletConnect path. No gateway, runner or keys needed. Hedera testnet only.</p>
      </div>
      <Callout tone="warn" icon={<WarnIcon size={16} />}>
        Nothing on this page submits a transaction. Every request asks your wallet to sign only; the signed bytes stay in this tab and are thrown away. If your wallet ever offers to send or execute
        something from this page, reject it.
      </Callout>

      {!config.walletConnectProjectId && (
        <Callout tone="broken" icon={<WarnIcon size={16} />}>
          NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set, so this page can&apos;t reach a real wallet.
        </Callout>
      )}

      <Section title="1. Connect">
        {!wallet ? (
          <div className="flex flex-wrap gap-2">
            {walletOptions.map((o) => (
              <Button key={o.id} disabled={connecting} onClick={() => void connectWallet(o.id)}>
                Connect {o.name}
              </Button>
            ))}
            <Button variant={walletOptions.length ? "ghost" : "primary"} disabled={connecting || !config.walletConnectProjectId} onClick={() => void connectWallet()}>
              {connecting ? "Waiting for the wallet…" : "WalletConnect QR"}
            </Button>
          </div>
        ) : !wc ? (
          <p className="m-0 text-muted">
            A pasted dev key is connected. Disconnect it to test a real wallet.{" "}
            <Button variant="ghost" onClick={forget}>
              Disconnect
            </Button>
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Rows
              lines={[
                ["Wallet", wc.walletName],
                [
                  "Account",
                  <a key="a" href={hashscanAccount(wc.accountId)} target="_blank" rel="noreferrer" className="mono text-sm text-soft hover:text-accent">
                    {wc.accountId} ↗
                  </a>,
                ],
                ["Key type", wc.keyType],
                ["Address the contract sees (msg.sender)", <span key="ad" className="mono text-xs break-all">{wc.address}</span>],
                ["Mirror public key", key ? <span key="k" className="mono text-xs break-all">{key.publicKey}</span> : (keyError ?? "loading…")],
              ]}
            />
            <div>
              <Button variant="ghost" onClick={forget}>
                Disconnect
              </Button>
            </div>
          </div>
        )}
        {error && (
          <Callout tone="broken" icon={<WarnIcon size={16} />}>
            {error}
          </Callout>
        )}
      </Section>

      <Section title="2. Sign the session message (hedera_signMessage)">
        <Button disabled={!wc || !key || !!busy} onClick={() => void signMessage()}>
          {busy === "message" ? "Waiting for the wallet…" : "Sign message"}
        </Button>
        <ResultView r={results.message} />
      </Section>

      <Section title="3. Sign an x402 payment, sign only (hedera_signTransaction)">
        <p className="m-0 text-xs text-faint">
          0.01 USDC to {PAY_TO}, transaction id from fee payer {FEE_PAYER}, frozen for one node. The wallet signs; nobody submits it. It expires unsent after about 2 minutes.
        </p>
        <Button disabled={!wc || !key || !!busy} onClick={() => void signX402()}>
          {busy === "x402" ? "Waiting for the wallet…" : "Sign payment (not sent)"}
        </Button>
        <ResultView r={results.x402} />
      </Section>

      <Section title="4. Sign a commitBreak contract call, sign only (optional)">
        <p className="m-0 text-xs text-faint">ContractExecuteTransaction on the demo arena with a dummy commitment. Signed, never executed.</p>
        <Button disabled={!wc || !key || !!busy} onClick={() => void signCommit()}>
          {busy === "commit" ? "Waiting for the wallet…" : "Sign contract call (not sent)"}
        </Button>
        <ResultView r={results.commit} />
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 p-5 rounded-xl border border-border bg-surface">
      <h2 className="m-0 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ lines }: { lines: [string, ReactNode][] }) {
  return (
    <dl className="m-0 flex flex-col">
      {lines.map(([label, value]) => (
        <div key={label} className="flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4 py-2 border-b border-line">
          <dt className="text-muted text-sm shrink-0">{label}</dt>
          <dd className="m-0 text-sm sm:text-right min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultView({ r }: { r: Result | undefined }) {
  if (!r) return null;
  if ("error" in r)
    return (
      <Callout tone="broken" icon={<WarnIcon size={16} />}>
        {r.error}
      </Callout>
    );
  return (
    <div className="flex flex-col gap-2">
      <span className={r.ok ? "text-open font-semibold" : "text-broken font-semibold"}>{r.ok ? "PASS" : "FAIL"}</span>
      <Rows lines={r.lines} />
    </div>
  );
}
