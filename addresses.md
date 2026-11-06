# Addresses

Everything Litmus runs on testnets: Hedera testnet (chain ID 296) and Ethereum Sepolia. The live app uses the demo deployment. The source of truth for contract addresses is [packages/shared/src/deployments.json](packages/shared/src/deployments.json), and the live gateway reports what it uses at https://api.litmusprotocol.com/config.

## Hedera testnet contracts

| Contract | EVM address | Hedera ID |
|---|---|---|
| DefectArena, demo (15-minute contests, used by the live app) | [`0x2790b81eedd5eb51d23adfe358a80b326460caaa`](https://hashscan.io/testnet/contract/0x2790b81eedd5eb51d23adfe358a80b326460caaa) | [`0.0.11334163`](https://hashscan.io/testnet/contract/0.0.11334163) |
| Litmus Held Certificate, demo | [`0xefee55ecf5e9e2da2c439051b23691f8edfc3c1e`](https://hashscan.io/testnet/contract/0xefee55ecf5e9e2da2c439051b23691f8edfc3c1e) | [`0.0.11338452`](https://hashscan.io/testnet/contract/0.0.11338452) |
| DefectArena, prod (8-hour contests) | [`0x102c3e209081759a1a226c3e3c206c1f465ea354`](https://hashscan.io/testnet/contract/0x102c3e209081759a1a226c3e3c206c1f465ea354) | [`0.0.11334164`](https://hashscan.io/testnet/contract/0.0.11334164) |
| Held Certificate, prod | [`0x2d0fe13ae7f0ca587d5681b4f03f5b05c61342ea`](https://hashscan.io/testnet/contract/0x2d0fe13ae7f0ca587d5681b4f03f5b05c61342ea) | [`0.0.11334168`](https://hashscan.io/testnet/contract/0.0.11334168) |
| ERC-8004 identity registry | [`0x380243140fc5bbabaca8f9bd055796e42d1b17a0`](https://hashscan.io/testnet/contract/0x380243140fc5bbabaca8f9bd055796e42d1b17a0) | [`0.0.11334176`](https://hashscan.io/testnet/contract/0.0.11334176) |
| ERC-8004 reputation registry | [`0x93a0eed86a4df71c054d0c3e485d3d4442e730e3`](https://hashscan.io/testnet/contract/0x93a0eed86a4df71c054d0c3e485d3d4442e730e3) | [`0.0.11334178`](https://hashscan.io/testnet/contract/0.0.11334178) |

The prod certificate is still the earlier version, named "Defect Held Certificate".

## Hedera testnet token

| Token | EVM address | Hedera ID |
|---|---|---|
| USDC (Circle testnet USDC, 6 decimals) | `0x0000000000000000000000000000000000068cda` | [`0.0.429274`](https://hashscan.io/testnet/token/0.0.429274) |

## Hedera testnet accounts

| Role | EVM address | Hedera ID |
|---|---|---|
| Breaker bot: the account behind the app's Run breaker bot button | `0x4de044483c2d6997cdc70555ae3ade3220e79fa1` | [`0.0.11227693`](https://hashscan.io/testnet/account/0.0.11227693) |

Outside accounts that show up in Litmus transactions:

| Account | Hedera ID |
|---|---|
| x402 facilitator (x402.org): pays the network fee of every settled x402 payment | [`0.0.9185802`](https://hashscan.io/testnet/account/0.0.9185802) |
| Hashio JSON-RPC relay: the payer of every contract call sent through `testnet.hashio.io` | [`0.0.7314364`](https://hashscan.io/testnet/account/0.0.7314364) |

## Ethereum Sepolia

| Contract or account | Address |
|---|---|
| DefectAttestations: stores the Chainlink CRE audit of each finished contest | [`0xbde5fe41bccc01724e96403fbbddde265d588cdf`](https://sepolia.etherscan.io/address/0xbde5fe41bccc01724e96403fbbddde265d588cdf) |
| Chainlink CRE simulation forwarder: the only caller DefectAttestations accepts | [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://sepolia.etherscan.io/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88) |
| Auditor sender: the key that broadcasts the CRE reports | [`0x841380638cb4ccb3910651330fa0be26b55dd1bc`](https://sepolia.etherscan.io/address/0x841380638cb4ccb3910651330fa0be26b55dd1bc) |

## 0G

| What | Address |
|---|---|
| 0G provider that served every reply in contest 7 | [`0xD179F4526064846dE9a9E9D93683AF75CB72E503`](https://chainscan.0g.ai/address/0xD179F4526064846dE9a9E9D93683AF75CB72E503) |

Contests use the 0G Compute Router at `https://router-api.0g.ai/v1`, which picks a provider per call unless the contest pins one. The providers available right now are listed at https://api.litmusprotocol.com/config under `models`.

## Retired

| Contract | Address |
|---|---|
| Earlier demo certificate. It still holds the soulbound tokens minted before the Litmus Held Certificate replaced it. | [`0xfeceb569c315397f91ceadd4498f8c398a23ca4a`](https://hashscan.io/testnet/contract/0xfeceb569c315397f91ceadd4498f8c398a23ca4a) |
