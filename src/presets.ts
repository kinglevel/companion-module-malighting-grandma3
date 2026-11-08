import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { seqVarPrefix } from './feedback/engine.js'

export function UpdatePresets(self: ModuleInstance): void {
	const presets: CompanionPresetDefinitions = {}
	if (!self.config.feedbackEnabled) {
		self.setPresetDefinitions(presets)
		return
	}
	// Variables are referenced through the connection's current label, never a hardcoded one
	const v = (id: string) => `$(${self.label}:${id})`
	const seq = 1
	const dp = 1
	const p = seqVarPrefix(dp, seq)

	presets.seq_go = {
		type: 'button',
		category: 'Sequence feedback',
		name: 'Sequence Go+ with running and cue feedback',
		style: {
			text: `Seq ${seq}\\n${v(`${p}_cue`)}`,
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'command', options: { command: `Go+ Sequence ${seq}` } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'seq_state_known',
				options: { sequence_number: String(seq), datapool: String(dp) },
				isInverted: true,
				style: { bgcolor: combineRgb(60, 60, 60), color: combineRgb(160, 160, 160) },
			},
			{
				feedbackId: 'sequence_active',
				options: { sequence_number: String(seq), datapool: String(dp), include_held: false },
				style: { bgcolor: combineRgb(0, 160, 0), color: combineRgb(255, 255, 255) },
			},
			{
				feedbackId: 'seq_paused',
				options: { sequence_number: String(seq), datapool: String(dp) },
				style: { bgcolor: combineRgb(200, 160, 0), color: combineRgb(0, 0, 0) },
			},
		],
	}

	presets.seq_off = {
		type: 'button',
		category: 'Sequence feedback',
		name: 'Sequence Off, lit while running',
		style: {
			text: `Seq ${seq}\\nOff`,
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'command', options: { command: `Off Sequence ${seq}` } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'sequence_active',
				options: { sequence_number: String(seq), datapool: String(dp), include_held: false },
				style: { bgcolor: combineRgb(160, 0, 0), color: combineRgb(255, 255, 255) },
			},
		],
	}

	presets.seq_cue_display = {
		type: 'button',
		category: 'Sequence feedback',
		name: 'Current cue number and name',
		style: {
			text: `${v(`${p}_cue`)}\\n${v(`${p}_cue_name`)}`,
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [
			{
				feedbackId: 'sequence_active',
				options: { sequence_number: String(seq), datapool: String(dp), include_held: false },
				style: { bgcolor: combineRgb(0, 0, 120) },
			},
		],
	}

	presets.last_event = {
		type: 'button',
		category: 'Sequence feedback',
		name: 'Last grandMA3 event',
		style: {
			text: `${v('last_function')}\\n${v('last_seq_name')}\\n${v('last_cue')}`,
			size: 'auto',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [],
		feedbacks: [],
	}

	presets.resync = {
		type: 'button',
		category: 'Sequence feedback',
		name: 'Resync states from grandMA3',
		style: {
			text: 'Resync\\nMA3',
			size: '14',
			color: combineRgb(255, 255, 255),
			bgcolor: combineRgb(0, 0, 0),
		},
		steps: [{ down: [{ actionId: 'feedback_resync', options: {} }], up: [] }],
		feedbacks: [],
	}

	self.setPresetDefinitions(presets)
}
