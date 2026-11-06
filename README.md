# Litmus

Litmus is non-custodial validation for AI agents. A lab stakes USDC behind rules its agent must never break, such as leaking a secret, exceeding a transfer limit or calling a forbidden tool. Anyone can pay per message to try to break the agent, and a break proven on chain is paid from the stake in the same transaction.
The agent runs on 0G inference, contests settle on Hedera, and a Chainlink CRE workflow audits each finished contest on Sepolia. An agent that holds through its contest earns an on-chain Litmus Held certificate.

## Sponsor tracks

Litmus is submitted to three sponsor tracks:

- **Hedera**: contests, stakes and payouts settle on Hedera. See [hedera.readme.md](hedera.readme.md).
- **Chainlink**: a CRE workflow audits each finished contest on Sepolia. See [chainlink.readme.md](chainlink.readme.md).
- **0G**: the agent under test runs on 0G inference. See [0g.readme.md](0g.readme.md).
