import type {
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
} from '@companion-module/base'
import { CONFIG_DEFAULTS, type ModuleConfig } from './config.js'

function updateExecButtonPageFromDropdownToInteger(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig>,
): CompanionStaticUpgradeResult<ModuleConfig> {
	const result: CompanionStaticUpgradeResult<ModuleConfig> = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	for (const action of props.actions) {
		if (
			action.actionId === 'exec_button' &&
			typeof action.options.page === 'string' &&
			!isNaN(parseInt(action.options.page))
		) {
			action.options.page = parseInt(action.options.page)
			result.updatedActions.push(action)
		}
	}

	return result
}

function migratePrefixAndPorts(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig>,
): CompanionStaticUpgradeResult<ModuleConfig> {
	const result: CompanionStaticUpgradeResult<ModuleConfig> = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}
	const cfg = props.config as (ModuleConfig & { prefix?: string }) | null
	if (!cfg) return result

	let changed = false
	if (cfg.inputPrefix === undefined) {
		cfg.inputPrefix = cfg.prefix ?? ''
		delete cfg.prefix
		changed = true
	}
	if (cfg.outputPrefix === undefined) {
		cfg.outputPrefix = ''
		changed = true
	}
	if (cfg.feedbackPort === undefined) {
		cfg.feedbackPort = '8082'
		changed = true
	}

	if (changed) result.updatedConfig = cfg
	return result
}

/**
 * OSC feedback rework:
 *  - new config fields; feedback stays OFF for existing send-only connections, but ON when the
 *    connection already uses the old `sequence_active` feedback
 *  - `sequence_active`: sequence number becomes a text field (variables allowed) + DataPool option
 */
function addOscFeedbackOptions(
	_context: CompanionUpgradeContext<ModuleConfig>,
	props: CompanionStaticUpgradeProps<ModuleConfig>,
): CompanionStaticUpgradeResult<ModuleConfig> {
	const result: CompanionStaticUpgradeResult<ModuleConfig> = {
		updatedActions: [],
		updatedConfig: null,
		updatedFeedbacks: [],
	}

	let usesSequenceFeedback = false
	for (const fb of props.feedbacks) {
		if (fb.feedbackId !== 'sequence_active') continue
		usesSequenceFeedback = true
		let changed = false
		if (typeof fb.options.sequence_number === 'number') {
			fb.options.sequence_number = String(fb.options.sequence_number)
			changed = true
		}
		if (fb.options.datapool === undefined) {
			fb.options.datapool = '1'
			changed = true
		}
		if (fb.options.include_held === undefined) {
			fb.options.include_held = false
			changed = true
		}
		if (changed) result.updatedFeedbacks.push(fb)
	}

	const cfg = props.config
	if (cfg && cfg.feedbackEnabled === undefined) {
		cfg.feedbackEnabled = usesSequenceFeedback
		cfg.luaQueries = CONFIG_DEFAULTS.luaQueries
		cfg.assumeAutoStart = CONFIG_DEFAULTS.assumeAutoStart
		// The old listener accepted packets from any sender; keep that for connections already using it
		cfg.feedbackAnySource = usesSequenceFeedback ? true : CONFIG_DEFAULTS.feedbackAnySource
		cfg.feedbackDebug = CONFIG_DEFAULTS.feedbackDebug
		result.updatedConfig = cfg
	}
	return result
}

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	updateExecButtonPageFromDropdownToInteger,
	migratePrefixAndPorts,
	addOscFeedbackOptions,
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */
	// function (context, props) {
	// 	return {
	// 		updatedConfig: null,
	// 		updatedActions: [],
	// 		updatedFeedbacks: [],
	// 	}
	// },
]
