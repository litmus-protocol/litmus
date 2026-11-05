# Defect auditor (Chainlink CRE)

An independent check of every finished Defect contest (build plan §13).

Each run, the workflow:

1. Asks the gateway for finalized contests (`GET /contests?status=finalized`).
2. Skips contests already attested on Sepolia (reads `DefectAttestations.attestations(id)`).
3. Reads each contest straight from **DefectArena on Hedera** with a JSON-RPC `eth_call` over the HTTP capability. CRE has no Hedera support, so this is the only way to reach Hedera.
4. Downloads the published log and revealed data from the gateway.
5. Checks that:
   - the log hashes to the `logHash` the operator posted on chain;
   - the revealed canary tasks hash to the `canaryHash` locked at creation;
   - every revealed secret hashes to its invariant's `secretHash`.

   It also counts the charged messages in the log and logs a package-hash check.
6. Writes a signed report to **DefectAttestations on Ethereum Sepolia**, which stores the verdict. The web app shows it as "Independently audited by Chainlink".

| | |
|---|---|
| Workflow | `auditor/` (TypeScript, `@chainlink/cre-sdk` 1.23.0) |
| Audit logic (pure, unit-tested) | `auditor/audit.ts`, tests in `auditor/audit.test.ts` (real data from contest 10) |
| Consumer contract | `packages/contracts/src/DefectAttestations.sol`, Sepolia `0x729442d8577b71aeb1943250bf88cef0359d9a41` |
| Forwarder | Chainlink's Sepolia simulation forwarder `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |

## Run it

Prerequisites:
- Bun ≥ 1.2.21.
- The CRE CLI: `curl -sSL https://app.chain.link/cre/install.sh | bash`, then `cre login`.
- The gateway running, with at least one finalized contest.
- `CRE_ETH_PRIVATE_KEY` (64 hex characters, no `0x`) funded with Sepolia ETH.

```bash
cd workflows/auditor/auditor && bun install && bun test
```

```bash
cd workflows/auditor && set -a && . ../../../.env && set +a && cre workflow simulate auditor --target staging-settings --broadcast
```

Without `--broadcast` the Sepolia write is a dry run. In simulation the cron trigger fires once, immediately.

## Config (`auditor/config.staging.json`)

| Field | Meaning |
|---|---|
| `gatewayUrl` | Defect gateway; `http://localhost:8787` works for simulation, which runs on your machine |
| `hederaRpcUrl` | Hedera JSON-RPC relay |
| `arena` | The DefectArena deployment the gateway uses (`GET /config` → `arena`) |
| `attestations` | DefectAttestations on Sepolia |
| `maxPerRun` | Contests attested per run |
| `contestIds` | Optional allow-list; empty means every finalized contest |

To refresh the test fixture from a live contest: `bun scripts/capture-fixture.ts <contestId>`.
