import { Runner } from '@chainlink/cre-sdk'
import { initWorkflow, type Config } from './workflow'

export async function main() {
	const runner = await Runner.newRunner<Config>()
	await runner.run(initWorkflow)
}

main()
