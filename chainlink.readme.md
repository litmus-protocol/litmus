# Litmus on Chainlink

Litmus tests what AI agents promise. A lab stakes USDC behind rules its agent must never break, anyone can pay per message to try to break one, and the contest settles on Hedera. When a contest ends, a Chainlink CRE workflow re-checks it on its own and writes the verdict to Ethereum Sepolia. An agent only gets its Litmus Held certificate if that audit passes.

Live app: https://litmusprotocol.com · API: https://api.litmusprotocol.com

## Why Chainlink

Most of a contest is enforced by the contract on Hedera: payments, payouts, and breaks of the transfer-limit and forbidden-tool rules. The rest depends on the Litmus services that run the contest, the gateway and the runner:

- The gateway decides whether each message is charged, and writes and signs the log of every attempt.
- The agent's system prompt, canary tasks and secrets stay private until the contest ends. Only their hashes go on chain at creation.
- The gateway posts the hash of the final log on chain.

If these services lied about any of these, the contract alone could not tell. A lab or a Breaker would have to trust Litmus. The audit removes that: someone other than the gateway fetches the published data, compares it with what the contract committed to, and records the result where neither the gateway nor the lab can change it.

That check has to read data off chain (the gateway's log and revealed secrets), read contract state on Hedera, and write a result on chain. A smart contract can't make HTTP calls, so it can't do this by itself. A CRE workflow can do all three in one run: its HTTP and chain reads go through Chainlink's capabilities with consensus across nodes, and its result reaches the chain as a signed report that only the Chainlink forwarder can deliver.

Without Chainlink, the certificate would rest on the gateway's word. With it, the certificate means an independent check found the log, canaries and secrets match what was locked on chain.

## How it's used

The auditor is a CRE workflow in TypeScript ([workflows/auditor](workflows/auditor), `@chainlink/cre-sdk` 1.23.0) on a cron trigger. Each run:

1. Asks the gateway for finalized contests (`GET /contests?status=finalized`).
2. Skips contests already attested, by reading `DefectAttestations.attestations(id)` on Sepolia through the EVM capability.
3. Reads each contest from DefectArena on Hedera with `eth_call` over the HTTP capability. CRE doesn't support Hedera as a chain, so this goes through Hedera's JSON-RPC relay.
4. Downloads the published log and the revealed package, canaries and secrets from the gateway.
5. Checks ([workflows/auditor/auditor/audit.ts](workflows/auditor/auditor/audit.ts)):
   - the log hashes to the `logHash` posted on chain;
   - the revealed canary tasks hash to the `canaryHash` locked at creation;
   - every revealed secret hashes to its rule's `secretHash`;
   - the number of charged, deposited messages in the log, against the contract's `messageCount`.
6. Writes a signed report through the Chainlink forwarder to `DefectAttestations` on Sepolia ([packages/contracts/src/DefectAttestations.sol](packages/contracts/src/DefectAttestations.sol)). The contract accepts reports only from the forwarder, and the first report for a contest is final.

The gateway then uses the attestation:
- **Auto-attest.** With `CRE_AUTO_ATTEST=true`, the gateway runs the workflow each time a contest is finalized ([apps/gateway/src/jobs/cre-attest.ts](apps/gateway/src/jobs/cre-attest.ts)) and reads the result back from Sepolia.
- **Certificate.** The Held certificate is minted only after the attestation exists and passed: status Held, log, canary and secret checks true, and the message counts equal ([apps/gateway/src/jobs/lifecycle.ts](apps/gateway/src/jobs/lifecycle.ts)). A failed audit withholds the certificate.
- **Web app.** The contest's Proof section reads the attestation from Sepolia and shows "Independently audited by Chainlink" or "Chainlink audit pending".

### Live attestations

| Contest | Result | Sepolia transaction |
|---|---|---|
| 7 (held, 12 messages) | log, canaries and secrets match; 12 of 12 messages in the log | [`0xae2e8c64…5f9907`](https://sepolia.etherscan.io/tx/0xae2e8c6413b69b91ca3be1f4c117e66c41e93404119def01076c5d4b205f9907) |
| 11 (broken, 3 messages) | log, canaries and secrets match; 3 of 3 messages in the log | [`0x3e6fbd41…0018e2`](https://sepolia.etherscan.io/tx/0x3e6fbd41c9844a8da4e66603f6a4c309a6adafd788a05f2ed2d091df430018e2) |

Read any contest's attestation yourself (needs [Foundry](https://getfoundry.sh)):

```bash
cast call --rpc-url https://ethereum-sepolia-rpc.publicnode.com 0xbde5fe41bccc01724e96403fbbddde265d588cdf 'attestations(uint256)(uint8,bytes32,bool,bool,bool,uint32,uint32,address,uint256)' 7
```

The fields are: status (2 broken, 3 held, 4 void, 5 cancelled), log hash, log matches, canaries match, secrets match, messages on chain, messages in the log, winner, and the time it was attested.

| | Address |
|---|---|
| DefectAttestations (Sepolia) | [`0xbde5fe41bccc01724e96403fbbddde265d588cdf`](https://sepolia.etherscan.io/address/0xbde5fe41bccc01724e96403fbbddde265d588cdf) |
| Chainlink forwarder (Sepolia) | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| DefectArena (Hedera testnet, read by the workflow) | `0x2790b81eedd5eb51d23adfe358a80b326460caaa` |

### Current limits

- The workflow runs through the CRE CLI simulator (`cre workflow simulate --broadcast`), not as a workflow deployed to a Chainlink DON. Its reads run on the machine that starts it, and its report goes through Chainlink's Sepolia simulation forwarder. Moving to a deployed workflow means pointing `DefectAttestations` at the production forwarder (`setForwarderAddress`, or a new deployment with `CRE_FORWARDER` set).
- `DefectAttestations` accepts any report from the forwarder. It doesn't yet pin the workflow ID or owner, which `ReceiverTemplate` supports.
- The package hash is checked and logged but not stored in the attestation.

## Setup

You need:
- [Bun](https://bun.sh) 1.2.21 or later.
- The CRE CLI: `curl -sSL https://app.chain.link/cre/install.sh | bash`, then `cre login`.
- A gateway to audit, with at least one finalized contest: your own local one, or the live one.
- For writes to Sepolia: `CRE_ETH_PRIVATE_KEY` (64 hex characters, no `0x`) funded with Sepolia ETH.

### 1. Install and test the audit logic

```bash
cd workflows/auditor/auditor && bun install && bun test
```

The tests run the audit on real data captured from contest 10 and need no network.

### 2. Point the workflow at a gateway

Edit [workflows/auditor/auditor/config.staging.json](workflows/auditor/auditor/config.staging.json):

| Field | Meaning |
|---|---|
| `gatewayUrl` | The gateway to audit. `http://localhost:8787` works, since the simulation runs on your machine. |
| `hederaRpcUrl` | Hedera JSON-RPC relay |
| `arena` | The DefectArena the gateway uses (`GET /config` → `arena`) |
| `attestations` | DefectAttestations on Sepolia |
| `maxPerRun` | Contests attested per run |
| `contestIds` | Optional list of contests to audit; empty means every finalized contest |

### 3. Run it

A dry run, with no Sepolia write:

```bash
cd workflows/auditor && cre workflow simulate auditor --target staging-settings
```

To write the attestation to Sepolia, export `CRE_ETH_PRIVATE_KEY` and add `--broadcast`:

```bash
cd workflows/auditor && cre workflow simulate auditor --target staging-settings --broadcast
```

In simulation the cron trigger fires once, right away. The log prints each contest's checks and the Sepolia transaction hash.

### 4. Let the gateway run it

To audit every contest automatically when it is finalized, set these in the gateway's env ([apps/gateway/.env.example](apps/gateway/.env.example)) and restart it:

```
CRE_AUTO_ATTEST=true
CRE_ETH_PRIVATE_KEY=<64 hex chars>
```

The gateway needs the `cre` CLI installed and `bun install` run in `workflows/auditor/auditor`. Each attestation is one Sepolia transaction from that key.

### Deploy your own DefectAttestations

```bash
pnpm --filter @defect/contracts deploy:attestations
```

This needs `SEPOLIA_RPC_URL` and `SEPOLIA_DEPLOYER_KEY`, and records the address in [packages/shared/src/deployments.json](packages/shared/src/deployments.json). It uses the simulation forwarder unless `CRE_FORWARDER` is set.

To refresh the test fixture from a live contest: `bun scripts/capture-fixture.ts <contestId>` in `workflows/auditor/auditor`.
