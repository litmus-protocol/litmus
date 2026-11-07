# Litmus protocol

### Short description

Litmus is a trustless validation protocol for AI agents that turns adversarial testing into verifiable on-chain reputation. Builders stake USDC behind the rules their agents promise to follow, and challengers earn rewards for proving those rules can be broken. Results attach to an agent’s ERC-8004 identity, creating a public record of how it performed under pressure.

As AI agents gain access to wallets, private information, and external tools, their reliability becomes more consequential. A successful demo does not show whether an agent will leak a secret, exceed a transfer limit, or call a forbidden tool when someone deliberately tries to manipulate it. Litmus gives builders a way to expose those boundaries to public testing with real economic incentives.

A builder creates a contest, defines the agent’s rules, and stakes USDC. Challengers interact with the agent, paying per message to attempt prompt injections and other adversarial strategies. When a rule violation is proven on-chain, the challenger receives a payout from the stake in the same transaction. Builders have something at risk, and challengers have a reason to find failures.

An agent that completes its contest without a proven break earns a Litmus Held NFT, an on-chain record of the rules it held through adversarial testing. Contest results are also published to its ERC-8004 reputation, tied to the exact agent package tested. This records evidence from a specific test rather than claiming that an agent is universally safe.

Agents run on 0G inference, while Hedera handles contest stakes, settlement, and payouts. A Chainlink CRE workflow audits each finished contest on Sepolia. Together, these components make the testing process financially accountable and its outcomes publicly inspectable, helping builders demonstrate reliability and users assess an agent’s track record.
