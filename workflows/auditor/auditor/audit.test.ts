import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, getAbiItem, type AbiParameter } from 'viem'
import { attestationsAbi as sharedAttestationsAbi, defectArenaAbi } from '../../../packages/shared/src/abi.generated'
import { arenaAbi, attestationsAbi, audit, canonicalJson, countChargedDeposited, encodeReport, REPORT_PARAMS, type ContestDetail } from './audit'
import fixture from './fixtures/contest-10.json'

// Contest 10: a real TreasuryBot contest on Hedera testnet, broken via the transfer limit (inv-1), finalized by the gateway.
const onchain = fixture.onchain as Parameters<typeof audit>[1]
const invariants = fixture.invariants as Parameters<typeof audit>[2]
const detail = fixture.detail as ContestDetail

const run = (d: ContestDetail = detail, log = fixture.log) => audit(10, onchain, invariants, d, log)

describe('audit of contest 10 (real data)', () => {
	test('every check passes', () => {
		const r = run()
		expect(r.status).toBe(2)
		expect(r.logHashMatches).toBe(true)
		expect(r.canaryHashMatches).toBe(true)
		expect(r.secretsMatch).toBe(true)
		expect(r.packageHashMatches).toBe(true)
		expect(r.winner.toLowerCase()).toBe('0x4de044483c2d6997cdc70555ae3ade3220e79fa1')
	})

	test('charged messages in the log equal the on-chain message count', () => {
		expect(countChargedDeposited(fixture.log)).toBe(onchain.messageCount)
		expect(run().attemptsInLog).toBe(4)
	})

	test('an edited log fails the log check', () => {
		const edited = fixture.log.replace('"outcome":"charged"', '"outcome":"free_late"')
		expect(edited).not.toBe(fixture.log)
		expect(run(detail, edited).logHashMatches).toBe(false)
	})

	test('swapped canaries fail the canary check', () => {
		const revealed = detail.revealed!
		const canaries = (revealed.canaries as { prompt: string }[]).map((c, i) => (i === 0 ? { ...c, prompt: 'Refuse everything.' } : c))
		expect(run({ ...detail, revealed: { ...revealed, canaries } }).canaryHashMatches).toBe(false)
	})

	test('a different secret fails the secrets check', () => {
		const revealed = detail.revealed!
		const secrets = { ...revealed.secrets, 'inv-2': 'DFT-AAAAAAAAAAAAAAAAAAAAAAAAAA' }
		expect(run({ ...detail, revealed: { ...revealed, secrets } }).secretsMatch).toBe(false)
	})

	test('a missing secret fails the secrets check', () => {
		const revealed = detail.revealed!
		expect(run({ ...detail, revealed: { ...revealed, secrets: {} } }).secretsMatch).toBe(false)
	})

	test('nothing revealed fails every revealed-data check', () => {
		const r = run({ ...detail, revealed: null })
		expect([r.canaryHashMatches, r.secretsMatch, r.packageHashMatches]).toEqual([false, false, false])
	})

	test('an unposted log hash never matches', () => {
		const r = audit(10, { ...onchain, logHash: `0x${'0'.repeat(64)}` }, invariants, detail, fixture.log)
		expect(r.logHashMatches).toBe(false)
	})
})

describe('encoding', () => {
	test('report round-trips through the DefectAttestations Report layout', () => {
		const r = run()
		const decoded = decodeAbiParameters(REPORT_PARAMS, encodeReport(r))
		expect(decoded[0]).toBe(10n)
		expect(decoded[1]).toBe(2)
		expect(decoded[2]).toBe(r.logHash)
		expect(decoded.slice(3, 6)).toEqual([true, true, true])
		expect(decoded[6]).toBe(4)
		expect(decoded[7]).toBe(4)
	})

	test('canonicalJson sorts keys and drops undefined', () => {
		expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}')
	})
})

describe('ABI fragments match the frozen Solidity interfaces', () => {
	const shape = (p: readonly AbiParameter[]): string =>
		p.map((x) => ('components' in x && x.components ? `(${shape(x.components)})${x.type.slice(5)}` : x.type)).join(',')

	for (const name of ['getContest', 'getInvariants'] as const) {
		test(name, () => {
			const mine = getAbiItem({ abi: arenaAbi, name })
			const frozen = getAbiItem({ abi: defectArenaAbi, name })
			expect(shape(mine.inputs)).toBe(shape(frozen.inputs))
			expect(shape(mine.outputs)).toBe(shape(frozen.outputs))
		})
	}

	test('attestations', () => {
		const mine = getAbiItem({ abi: attestationsAbi, name: 'attestations' })
		const frozen = getAbiItem({ abi: sharedAttestationsAbi, name: 'attestations' })
		expect(shape(mine.outputs)).toBe(shape(frozen.outputs))
	})
})
