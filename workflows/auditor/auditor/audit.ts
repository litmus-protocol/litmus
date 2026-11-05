// Pure audit logic for one finished Defect contest (build plan §13.3). No CRE imports, so it is unit-tested with bun.
import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, toBytes, type Address, type Hex } from 'viem'

/** DefectArena views the auditor reads on Hedera (mirrors packages/contracts/src/interfaces/IDefectArena.sol). */
export const arenaAbi = parseAbi([
	'struct Contest { address warden; uint8 status; uint64 startTime; uint64 endTime; uint32 messageCount; uint8 brokenInvariant; address winner; uint256 messagePrice; uint256 initialPool; uint256 pool; uint256 vault; uint256 bond; uint256 escrow; bytes32 packageHash; bytes32 canaryHash; bytes32 logHash; }',
	'struct Invariant { uint8 kind; bytes32 secretHash; uint256 maxAmount; }',
	'function getContest(uint256 id) view returns (Contest)',
	'function getInvariants(uint256 id) view returns (Invariant[])',
])

/** DefectAttestations view the auditor reads on Sepolia (mirrors IDefectAttestations.sol). */
export const attestationsAbi = parseAbi([
	'function attestations(uint256 contestId) view returns (uint8 status, bytes32 logHash, bool logHashMatches, bool canaryHashMatches, bool secretsMatch, uint32 messageCount, uint32 attemptsInLog, address winner, uint256 attestedAt)',
])

/** The report payload DefectAttestations decodes (its `Report` struct, a flat tuple of static fields). */
export const REPORT_PARAMS = parseAbiParameters(
	'uint256 contestId, uint8 status, bytes32 logHash, bool logHashMatches, bool canaryHashMatches, bool secretsMatch, uint32 messageCount, uint32 attemptsInLog, address winner',
)

/** DefectArena.Status values that mean a contest is over: Broken 2, Held 3, Void 4, Cancelled 5. */
export const ENDED_STATUSES = new Set([2, 3, 4, 5])
/** DefectArena.Kind.Secret */
const KIND_SECRET = 1
const ZERO_HASH: Hex = `0x${'0'.repeat(64)}`

/** Same rules as packages/shared/src/hash.ts (§6.3): keys sorted at every level, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		const out = JSON.stringify(value)
		if (out === undefined) throw new Error('canonicalJson: unsupported value')
		return out
	}
	if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export const hashJson = (value: unknown): Hex => keccak256(toBytes(canonicalJson(value)))

export type OnchainContest = {
	status: number
	messageCount: number
	winner: Address
	packageHash: Hex
	canaryHash: Hex
	logHash: Hex
}

export type OnchainInvariant = { kind: number; secretHash: Hex }

/** The parts of the gateway's GET /contests/:id response the audit uses. */
export type ContestDetail = {
	contestId: number
	invariants: { id: string; type: string }[]
	revealed: {
		package: unknown
		canaries: unknown
		secrets: Record<string, string>
		logHash: Hex | null
	} | null
}

export type AuditResult = {
	contestId: number
	status: number
	logHash: Hex
	logHashMatches: boolean
	canaryHashMatches: boolean
	secretsMatch: boolean
	/** Logged only; not part of the on-chain report (§13.2). */
	packageHashMatches: boolean
	messageCount: number
	attemptsInLog: number
	winner: Address
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Charged messages whose fee reached the contract: the same thing DefectArena's messageCount counts. */
export function countChargedDeposited(logText: string): number {
	let n = 0
	for (const line of logText.split('\n')) {
		if (!line.trim()) continue
		const rec = JSON.parse(line) as { type?: string; outcome?: string; depositStatus?: string }
		if (rec.type === 'attempt' && rec.outcome === 'charged' && rec.depositStatus === 'done') n++
	}
	return n
}

export function audit(
	contestId: number,
	onchain: OnchainContest,
	invariants: OnchainInvariant[],
	detail: ContestDetail,
	logText: string,
): AuditResult {
	const revealed = detail.revealed

	// The log must hash to the fingerprint the operator posted on chain, and that fingerprint must exist.
	const logHashMatches = onchain.logHash !== ZERO_HASH && eq(keccak256(toBytes(logText)), onchain.logHash)

	// The revealed canary tasks must hash to the fingerprint locked when the contest was created.
	const canaryHashMatches = revealed !== null && eq(hashJson(revealed.canaries), onchain.canaryHash)
	const packageHashMatches = revealed !== null && eq(hashJson(revealed.package), onchain.packageHash)

	// Every secret invariant's revealed code must hash to its on-chain secretHash. The gateway lists invariants in
	// on-chain order (§7.3), so index i on chain is detail.invariants[i].
	let secretsMatch = revealed !== null
	if (revealed) {
		invariants.forEach((inv, i) => {
			if (inv.kind !== KIND_SECRET) return
			const id = detail.invariants[i]?.id
			const secret = id ? revealed.secrets[id] : undefined
			if (!secret || !eq(keccak256(toBytes(secret)), inv.secretHash)) secretsMatch = false
		})
	}

	return {
		contestId,
		status: onchain.status,
		logHash: onchain.logHash,
		logHashMatches,
		canaryHashMatches,
		secretsMatch,
		packageHashMatches,
		messageCount: onchain.messageCount,
		attemptsInLog: countChargedDeposited(logText),
		winner: onchain.winner,
	}
}

export function encodeReport(r: AuditResult): Hex {
	return encodeAbiParameters(REPORT_PARAMS, [
		BigInt(r.contestId),
		r.status,
		r.logHash,
		r.logHashMatches,
		r.canaryHashMatches,
		r.secretsMatch,
		r.messageCount,
		r.attemptsInLog,
		r.winner,
	])
}
