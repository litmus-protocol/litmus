# Litmus Protocol

Trustless validation of agents. A lab publishes an AI agent along with the rules it must never break. Anyone can then pay per message, in USDC on Hedera over x402, to try to make it break one. Every attempt grows a prize pool, and whoever breaks a rule takes it. If the agent holds until the window closes, a Chainlink CRE workflow re-checks the run and the agent earns an on-chain certificate.

Live app: https://litmusprotocol.com · API: https://api.litmusprotocol.com

## 0G: where the agent actually thinks

Every reply from the agent under test is an inference on 0G compute. The runner ([apps/runner/src/llm.ts](apps/runner/src/llm.ts)) calls the 0G Compute Router (`https://router-api.0g.ai/v1`) for each step of the agent's tool loop. It reads the `x_0g_trace` block from each response and keeps its request ID, provider and cost. That evidence then travels with the message:

- **In the app**, every agent reply has a `Ran on 0G · req …` badge. Hover it to see the full request ID; click it to copy.
- **In the signed log**, each attempt record carries an `og` array of request IDs. The gateway signs the record and the log is published when the contest ends, so request IDs can't be added or changed afterwards.

**What breaks without 0G:** the agent under test has nothing to think with, so no attempt gets a reply or a charge, no contest can be held or broken, and the signed log loses the request IDs that prove each answer came from a real inference.

### Live request IDs

These come from contest 7 (VaultKeeper) on the live deployment, 12 paid messages, each answered by one 0G call. The full signed log is at https://api.litmusprotocol.com/contests/7/log.

| # | 0G request ID | Payment |
|---|---|---|
| 1 | `ce266ac6-44ae-4b00-bea5-d73a55a61ba6` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958139-476336643) |
| 2 | `c1756d4f-af7f-47cd-84da-1bbbebfadac7` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958213-132836390) |
| 3 | `fc21c09b-ae10-477f-8b79-c3c2f3412072` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958245-494688417) |
| 4 | `cdc57acb-803b-4cb9-91d9-53cd6a5cba00` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958275-360754519) |
| 5 | `f7fa9631-f920-429a-866a-c05882d90c42` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958356-470454751) |
| 6 | `35442bb4-5624-4a99-b75b-b1a104e3848f` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958441-082784323) |
| 7 | `25e6c701-3303-44ff-8a0d-99ff3c64bbdd` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958503-712064539) |
| 8 | `ff9c4950-85a9-47b9-a70c-0558d9fd88cf` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958536-751114759) |
| 9 | `dc11ce4c-f1c5-46db-a334-aed26ad1f63f` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958557-489160000) |
| 10 | `a21d93d0-9ec4-433b-bfba-af555f731343` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958781-731420584) |
| 11 | `67ba22eb-26c7-48a4-86dc-8a4045afb33b` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958806-745696761) |
| 12 | `daabeadd-8247-46f0-8885-79be53708156` | [HashScan](https://hashscan.io/testnet/transaction/0.0.9185802-1793958981-916562899) |

All twelve were served by provider `0xD179F4526064846dE9a9E9D93683AF75CB72E503`. To pull the request IDs of any ended contest yourself:

```bash
curl -s https://api.litmusprotocol.com/contests/7/attempts | jq -r '.[].og[].requestId'
```

## Deployed contracts

Hedera testnet:

| Contract | Address |
|---|---|
| Arena (demo) | `0x2790b81eedd5eb51d23adfe358a80b326460caaa` |
| Certificate (demo) | `0xfeceb569c315397f91ceadd4498f8c398a23ca4a` |
| Arena (prod) | `0x102c3e209081759a1a226c3e3c206c1f465ea354` |
| Certificate (prod) | `0x2d0fe13ae7f0ca587d5681b4f03f5b05c61342ea` |
| ERC-8004 identity registry | `0x380243140fc5bbabaca8f9bd055796e42d1b17a0` |
| ERC-8004 reputation registry | `0x93a0eed86a4df71c054d0c3e485d3d4442e730e3` |

Ethereum Sepolia:

| Contract | Address |
|---|---|
| Attestations (Chainlink CRE) | `0xbde5fe41bccc01724e96403fbbddde265d588cdf` |

The source of truth is [packages/shared/src/deployments.json](packages/shared/src/deployments.json).
