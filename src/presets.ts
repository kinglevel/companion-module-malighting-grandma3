import {
	combineRgb,
	type CompanionButtonPresetDefinition,
	type CompanionPresetDefinitions,
	type CompanionPresetFeedback,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { seqVarPrefix } from './feedback/engine.js'
import { objectPickerValues } from './picker/objectPicker.js'
import type { CatalogKind } from './ma/catalog.js'

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)

/** Preset examples address object 1 in DataPool 1; users re-pick them in the action's dropdowns. */
const DP = 1
const SEQ = 1

function callObject(kind: CatalogKind, id: string, fn: string) {
	return { actionId: 'call_object', options: { ...objectPickerValues(DP, kind, id), function: fn } }
}

function button(
	category: string,
	name: string,
	text: string,
	down: ReturnType<typeof callObject>[],
	opts: { up?: ReturnType<typeof callObject>[]; feedbacks?: CompanionPresetFeedback[]; size?: '14' | 'auto' } = {},
): CompanionButtonPresetDefinition {
	return {
		type: 'button',
		category,
		name,
		style: { text, size: opts.size ?? '14', color: WHITE, bgcolor: BLACK },
		steps: [{ down, up: opts.up ?? [] }],
		feedbacks: opts.feedbacks ?? [],
	}
}

export function UpdatePresets(self: ModuleInstance): void {
	const presets: CompanionPresetDefinitions = {}
	// Variables are referenced through the connection's current label, never a hardcoded one
	const v = (id: string) => `$(${self.label}:${id})`
	const p = seqVarPrefix(DP, SEQ)
	const seqOpts = { sequence_number: String(SEQ), datapool: String(DP), [`seq_dp${DP}`]: String(SEQ) }

	// ---------------------------------------------------------------- objects (work without feedback)
	presets.group_select = button('Groups', 'Select group', 'Group 1\\nSelect', [callObject('Groups', '1', 'Select')])
	presets.preset_call = button('Presets', 'Call preset', 'Preset 1.1', [callObject('PresetPools', '1.1', 'Call')])
	presets.macro_go = button('Macros', 'Run macro', 'Macro 1', [callObject('Macros', '1', 'Go+')])
	presets.plugin_call = button('Plugins', 'Call plugin', 'Plugin 1', [callObject('Plugins', '1', 'Call')])
	presets.quickey_call = button('Quickeys', 'Run quickey', 'Quickey 1', [callObject('Quickeys', '1', 'Call')])
	presets.matricks_call = button('MAtricks', 'Call MAtricks', 'MAtricks 1', [callObject('MAtricks', '1', 'Call')])
	presets.world_call = button('Worlds', 'Call world', 'World 1', [callObject('Worlds', '1', 'Call')])
	presets.timer_start = button('Timers', 'Start timer', 'Timer 1\\nStart', [callObject('Timers', '1', 'Go+')])
	presets.timer_stop = button('Timers', 'Stop timer', 'Timer 1\\nStop', [callObject('Timers', '1', 'Off')])
	presets.timer_reset = button('Timers', 'Reset timer', 'Timer 1\\nReset', [callObject('Timers', '1', 'Top')])

	// ---------------------------------------------------------------- sequences (with feedback when enabled)
	const fb = self.config.feedbackEnabled
	const running = (bgcolor: number): CompanionPresetFeedback => ({
		feedbackId: 'sequence_active',
		options: { ...seqOpts, include_held: false },
		style: { bgcolor, color: WHITE },
	})
	const unknown: CompanionPresetFeedback = {
		feedbackId: 'seq_state_known',
		options: seqOpts,
		isInverted: true,
		style: { bgcolor: combineRgb(60, 60, 60), color: combineRgb(160, 160, 160) },
	}
	const paused: CompanionPresetFeedback = {
		feedbackId: 'seq_paused',
		options: seqOpts,
		style: { bgcolor: combineRgb(200, 160, 0), color: BLACK },
	}

	presets.seq_go = button(
		'Sequences',
		'Go+ (lit while running, shows cue)',
		fb ? `Seq ${SEQ}\\n${v(`${p}_cue`)}` : `Seq ${SEQ}\\nGo+`,
		[callObject('Sequences', String(SEQ), 'Go+')],
		{ feedbacks: fb ? [unknown, running(combineRgb(0, 150, 0)), paused] : [] },
	)
	presets.seq_goback = button('Sequences', 'Go-', `Seq ${SEQ}\\nGo-`, [callObject('Sequences', String(SEQ), 'Go-')], {
		feedbacks: fb ? [running(combineRgb(0, 90, 0))] : [],
	})
	presets.seq_off = button(
		'Sequences',
		'Off (lit while running)',
		`Seq ${SEQ}\\nOff`,
		[callObject('Sequences', String(SEQ), 'Off')],
		{ feedbacks: fb ? [running(combineRgb(160, 0, 0))] : [] },
	)
	presets.seq_toggle = button(
		'Sequences',
		'Toggle',
		`Seq ${SEQ}\\nToggle`,
		[callObject('Sequences', String(SEQ), 'Toggle')],
		{ feedbacks: fb ? [unknown, running(combineRgb(0, 150, 0))] : [] },
	)
	presets.seq_flash = button(
		'Sequences',
		'Flash (while pressed)',
		`Seq ${SEQ}\\nFlash`,
		[callObject('Sequences', String(SEQ), 'Flash On')],
		{
			up: [callObject('Sequences', String(SEQ), 'Flash Off')],
			feedbacks: fb
				? [{ feedbackId: 'seq_held', options: { ...seqOpts, kind: 'flash' }, style: { bgcolor: WHITE, color: BLACK } }]
				: [],
		},
	)

	if (fb) {
		presets.seq_cue_display = button(
			'Sequences',
			'Cue number and name',
			`${v(`${p}_cue`)}\\n${v(`${p}_cue_name`)}`,
			[],
			{
				size: 'auto',
				feedbacks: [running(combineRgb(0, 0, 120))],
			},
		)
		presets.seq_fader_display = button('Sequences', 'Master fader level', `Seq ${SEQ}\\n${v(`${p}_fader`)}%`, [], {
			feedbacks: [
				{
					feedbackId: 'seq_fader',
					options: { ...seqOpts, op: 'gt', level: 0 },
					style: { bgcolor: combineRgb(170, 110, 0), color: BLACK },
				},
			],
		})
		presets.last_event = button(
			'Feedback',
			'Last grandMA3 event',
			`${v('last_function')}\\n${v('last_seq_name')}\\n${v('last_cue')}`,
			[],
			{ size: 'auto' },
		)
		presets.resync = {
			type: 'button',
			category: 'Feedback',
			name: 'Resync states from grandMA3',
			style: { text: 'Resync\\nMA3', size: '14', color: WHITE, bgcolor: BLACK },
			steps: [{ down: [{ actionId: 'feedback_resync', options: {} }], up: [] }],
			feedbacks: [],
		}
	}

	self.setPresetDefinitions(presets)
}
