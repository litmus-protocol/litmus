// Hand-written from build plan §8 so the web app can be built before the contract.
// Replace with the ABI exported by `forge inspect DefectArena abi` once P2 lands
// (packages/shared/src/abi/DefectArena.json); names and types here match §8 exactly.

const invariantTuple = {
  type: "tuple",
  components: [
    { name: "kind", type: "uint8" },
    { name: "secretHash", type: "bytes32" },
    { name: "maxAmount", type: "uint256" },
  ],
} as const;

export const defectArenaAbi = [
  {
    type: "function",
    name: "createContest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "packageHash", type: "bytes32" },
      { name: "canaryHash", type: "bytes32" },
      { name: "invs", type: "tuple[]", components: invariantTuple.components },
      { name: "startTime", type: "uint64" },
      { name: "messagePrice", type: "uint256" },
      { name: "pool", type: "uint256" },
      { name: "vaultAmount", type: "uint256" },
      { name: "bond", type: "uint256" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "commitBreak",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "commitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revealBreak",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "invariantIndex", type: "uint8" },
      { name: "secret", type: "string" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "closeHeld", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "withdrawable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "commits",
    stateMutability: "view",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "breaker", type: "address" },
    ],
    outputs: [
      { name: "commitment", type: "bytes32" },
      { name: "blockNumber", type: "uint64" },
      { name: "time", type: "uint64" },
    ],
  },
  { type: "function", name: "phase", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "uint8" }] },
  {
    type: "event",
    name: "ContestCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "warden", type: "address", indexed: true },
      { name: "startTime", type: "uint64", indexed: false },
      { name: "endTime", type: "uint64", indexed: false },
      { name: "pool", type: "uint256", indexed: false },
      { name: "vault", type: "uint256", indexed: false },
      { name: "bond", type: "uint256", indexed: false },
      { name: "messagePrice", type: "uint256", indexed: false },
      { name: "packageHash", type: "bytes32", indexed: false },
      { name: "canaryHash", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
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

export const attestationsAbi = [
  {
    type: "function",
    name: "attestations",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "logHash", type: "bytes32" },
      { name: "logHashMatches", type: "bool" },
      { name: "canaryHashMatches", type: "bool" },
      { name: "secretsMatch", type: "bool" },
      { name: "messageCount", type: "uint32" },
      { name: "attemptsInLog", type: "uint32" },
      { name: "winner", type: "address" },
      { name: "attestedAt", type: "uint256" },
    ],
  },
] as const;
