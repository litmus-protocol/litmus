import { createPublicClient, http } from 'viem'
import { arenaAbi } from '../audit'
// Saves a finished contest's on-chain state, gateway detail and log as a test fixture.
// Usage: bun scripts/capture-fixture.ts <contestId> [gatewayUrl]
const id = Number(process.argv[2]); const gw = process.argv[3] ?? 'http://localhost:8787'
const cfg = await (await fetch(`${gw}/config`)).json()
const client = createPublicClient({ transport: http('https://testnet.hashio.io/api') })
const c: any = await client.readContract({ address: cfg.arena, abi: arenaAbi, functionName: 'getContest', args: [BigInt(id)] })
const invs: any = await client.readContract({ address: cfg.arena, abi: arenaAbi, functionName: 'getInvariants', args: [BigInt(id)] })
const detail = await (await fetch(`${gw}/contests/${id}`)).json()
const log = await (await fetch(`${gw}/contests/${id}/log`)).text()
const out = { contestId: id, arena: cfg.arena,
  onchain: { status: c.status, messageCount: c.messageCount, winner: c.winner, packageHash: c.packageHash, canaryHash: c.canaryHash, logHash: c.logHash },
  invariants: invs.map((i: any) => ({ kind: i.kind, secretHash: i.secretHash })),
  detail: { contestId: detail.contestId, invariants: detail.invariants.map((i: any) => ({ id: i.id, type: i.type })), revealed: detail.revealed },
  log }
await Bun.write(`${import.meta.dir}/../fixtures/contest-${id}.json`, JSON.stringify(out, null, 2) + '\n')
console.log('saved', { status: c.status, messageCount: c.messageCount, invs: out.invariants.map((i: any) => i.kind) })
