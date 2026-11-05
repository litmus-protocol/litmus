// Defect auditor: a Chainlink CRE workflow that independently checks finished contests (build plan §13).
// Each run: list finalized contests from the gateway, skip ones already attested on Sepolia, read each contest's
// state from DefectArena on Hedera over plain JSON-RPC (CRE cannot read or write Hedera natively), fetch the
// published log and revealed data, compare hashes, and write one attestation per contest to DefectAttestations.
import {
	bytesToHex,
	consensusIdenticalAggregation,
	cre,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	prepareReportRequest,
	TxStatus,
	type HTTPSendRequester,
	type Runtime,
} from '@chainlink/cre-sdk'
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Address, type Hex } from 'viem'
import {
	arenaAbi,
	attestationsAbi,
	audit,
	encodeReport,
	ENDED_STATUSES,
	type ContestDetail,
	type OnchainContest,
	type OnchainInvariant,
} from './audit'

export type Config = {
	schedule: string
	/** Defect gateway base URL, no trailing slash. */
	gatewayUrl: string
	/** Hedera testnet JSON-RPC relay, e.g. https://testnet.hashio.io/api */
	hederaRpcUrl: string
	/** DefectArena address on Hedera (the deployment the gateway uses). */
	arena: Address
	/** CRE chain selector name of the attestation chain. */
	attestationsChain: string
	/** DefectAttestations address on that chain. */
	attestations: Address
	gasLimit: string
	maxPerRun: number
	/** Optional: audit only these contest ids (still skipping ones already attested). */
	contestIds?: number[]
}

type HttpRequest = { url: string; method: 'GET' | 'POST'; body?: string }

/** One HTTP call, returned as text. Runs on each node; results must be identical across nodes. */
const fetchText = (sendRequester: HTTPSendRequester, req: HttpRequest): string => {
	const resp = sendRequester
		.sendRequest({
			url: req.url,
			method: req.method,
			headers: req.body ? { 'Content-Type': 'application/json' } : {},
			...(req.body ? { body: Buffer.from(req.body).toString('base64') } : {}),
		})
		.result()
	if (resp.statusCode < 200 || resp.statusCode >= 300) {
		throw new Error(`HTTP ${resp.statusCode} from ${req.url}`)
	}
	return new TextDecoder().decode(resp.body)
}

const httpText = (runtime: Runtime<Config>, req: HttpRequest): string =>
	new cre.capabilities.HTTPClient()
		.sendRequest(runtime, fetchText, consensusIdenticalAggregation<string>())(req)
		.result()

/** eth_call against Hedera's JSON-RPC relay over the HTTP capability. */
const hederaCall = (runtime: Runtime<Config>, data: Hex): Hex => {
	const body = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'eth_call',
		params: [{ to: runtime.config.arena, data }, 'latest'],
	})
	const res = JSON.parse(httpText(runtime, { url: runtime.config.hederaRpcUrl, method: 'POST', body })) as {
		result?: Hex
		error?: { message?: string }
	}
	if (!res.result) throw new Error(`Hedera eth_call failed: ${res.error?.message ?? 'no result'}`)
	return res.result
}

const readOnchain = (runtime: Runtime<Config>, id: number): { contest: OnchainContest; invariants: OnchainInvariant[] } => {
	const contestRaw = hederaCall(
		runtime,
		encodeFunctionData({ abi: arenaAbi, functionName: 'getContest', args: [BigInt(id)] }),
	)
	const c = decodeFunctionResult({ abi: arenaAbi, functionName: 'getContest', data: contestRaw })
	const invRaw = hederaCall(
		runtime,
		encodeFunctionData({ abi: arenaAbi, functionName: 'getInvariants', args: [BigInt(id)] }),
	)
	const invs = decodeFunctionResult({ abi: arenaAbi, functionName: 'getInvariants', data: invRaw })
	return {
		contest: {
			status: c.status,
			messageCount: c.messageCount,
			winner: c.winner,
			packageHash: c.packageHash,
			canaryHash: c.canaryHash,
			logHash: c.logHash,
		},
		invariants: invs.map((inv) => ({ kind: inv.kind, secretHash: inv.secretHash })),
	}
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
	const cfg = runtime.config

	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: cfg.attestationsChain, isTestnet: true })
	if (!network) throw new Error(`Unknown chain: ${cfg.attestationsChain}`)
	const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)

	const attestedAt = (id: number): bigint => {
		const res = evm
			.callContract(runtime, {
				call: encodeCallMsg({
					from: zeroAddress,
					to: cfg.attestations,
					data: encodeFunctionData({ abi: attestationsAbi, functionName: 'attestations', args: [BigInt(id)] }),
				}),
				blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
			})
			.result()
		const out = decodeFunctionResult({ abi: attestationsAbi, functionName: 'attestations', data: bytesToHex(res.data) })
		return out[8]
	}

	// 1. Candidates: finalized contests (log published and its hash posted on chain).
	const listed = JSON.parse(
		httpText(runtime, { url: `${cfg.gatewayUrl}/contests?status=finalized`, method: 'GET' }),
	) as { contestId: number }[]
	let ids = listed.map((c) => c.contestId)
	if (cfg.contestIds && cfg.contestIds.length > 0) ids = ids.filter((id) => cfg.contestIds!.includes(id))

	// 2. Skip contests already attested; cap the work per run.
	const todo = ids.filter((id) => attestedAt(id) === 0n).slice(0, cfg.maxPerRun)
	runtime.log(`Finalized contests: [${ids.join(', ')}]; to audit now: [${todo.join(', ')}]`)
	if (todo.length === 0) return 'Nothing to audit'

	const results: string[] = []
	for (const id of todo) {
		// 3. Independent reads: chain state from Hedera, published data from the gateway.
		const { contest, invariants } = readOnchain(runtime, id)
		if (!ENDED_STATUSES.has(contest.status)) {
			runtime.log(`Contest ${id}: on-chain status ${contest.status} is not an ended state; skipping`)
			continue
		}
		const logText = httpText(runtime, { url: `${cfg.gatewayUrl}/contests/${id}/log`, method: 'GET' })
		const detail = JSON.parse(
			httpText(runtime, { url: `${cfg.gatewayUrl}/contests/${id}`, method: 'GET' }),
		) as ContestDetail

		// 4. Compare.
		const r = audit(id, contest, invariants, detail, logText)
		runtime.log(
			`Contest ${id}: status=${r.status} log=${r.logHashMatches} canaries=${r.canaryHashMatches} ` +
				`secrets=${r.secretsMatch} package=${r.packageHashMatches} messages=${r.messageCount} ` +
				`chargedInLog=${r.attemptsInLog} winner=${r.winner}`,
		)

		// 5. Signed report → DefectAttestations on Sepolia.
		const report = runtime.report(prepareReportRequest(encodeReport(r))).result()
		const write = evm
			.writeReport(runtime, { receiver: cfg.attestations, report, gasConfig: { gasLimit: cfg.gasLimit } })
			.result()
		if (write.txStatus !== TxStatus.SUCCESS) {
			throw new Error(`Attestation tx for contest ${id} failed: ${write.errorMessage || write.txStatus}`)
		}
		if (write.receiverContractExecutionStatus !== undefined && write.receiverContractExecutionStatus !== 0) {
			throw new Error(`DefectAttestations rejected the report for contest ${id}: status ${write.receiverContractExecutionStatus}`)
		}
		const txHash = bytesToHex(write.txHash || new Uint8Array(32))
		runtime.log(`Contest ${id}: attested on ${cfg.attestationsChain}, tx ${txHash}`)
		results.push(`${id}:${txHash}`)
	}
	return `Attested ${results.length}: ${results.join(' ')}`
}

export function initWorkflow(config: Config) {
	const cron = new cre.capabilities.CronCapability()
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}
