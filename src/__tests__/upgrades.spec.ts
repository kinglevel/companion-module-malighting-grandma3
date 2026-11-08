import { describe, expect, it } from 'vitest'
import type { CompanionMigrationFeedback, CompanionStaticUpgradeProps } from '@companion-module/base'
import { UpgradeScripts } from '../upgrades.js'
import type { ModuleConfig } from '../config.js'

const legacyConfig = (): ModuleConfig =>
	({
		host: '192.168.1.10',
		port: 8081,
		inputPrefix: '',
		outputPrefix: '',
		feedbackPort: '8082',
	}) as ModuleConfig

function run(config: ModuleConfig, feedbacks: CompanionMigrationFeedback[]) {
	const props: CompanionStaticUpgradeProps<ModuleConfig> = { config, secrets: null, actions: [], feedbacks }
	// The feedback upgrade is the last script
	return UpgradeScripts[UpgradeScripts.length - 1]({} as never, props)
}

describe('upgrade to OSC feedback', () => {
	it('keeps send-only connections send-only', () => {
		const res = run(legacyConfig(), [])
		expect(res.updatedConfig).toMatchObject({ feedbackEnabled: false, luaQueries: true, feedbackAnySource: false })
	})

	it('keeps existing sequence_active users working (feedback on, any sender like before)', () => {
		const fb = {
			id: 'f1',
			controlId: 'c1',
			feedbackId: 'sequence_active',
			options: { sequence_number: 5 },
		} as unknown as CompanionMigrationFeedback
		const res = run(legacyConfig(), [fb])
		expect(res.updatedConfig).toMatchObject({ feedbackEnabled: true, feedbackAnySource: true })
		expect(res.updatedFeedbacks).toHaveLength(1)
		expect(res.updatedFeedbacks[0].options).toEqual({ sequence_number: '5', datapool: '1', include_held: false })
	})

	it('is idempotent on already upgraded configs', () => {
		const cfg = { ...legacyConfig(), feedbackEnabled: true } as ModuleConfig
		expect(run(cfg, []).updatedConfig).toBeNull()
	})
})
