// Contract ABIs. DefectArena and DefectAttestations come from the frozen Solidity interfaces
// (packages/contracts/src/interfaces) via abi.generated.ts; regenerate with `pnpm --filter @defect/contracts abi`.
// Only the USDC token ABI below is hand-written (ERC-20 facade + HIP-719 associate).
export { defectArenaAbi, attestationsAbi, certificateAbi } from "./abi.generated";

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  // HIP-719 token facade: associates msg.sender with the token.
  { type: "function", name: "associate", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
