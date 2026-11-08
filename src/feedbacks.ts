import type {
	CompanionFeedbackContext,
	CompanionFeedbackDefinitions,
	CompanionFeedbackInfo,
	CompanionOptionValues,
	SomeCompanionFeedbackInputField,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { HELD_KINDS, sequenceKey, type HeldKind, type SequenceState } from './ma/sequences.js'
import { buildPickerFields, pickerValues, resolvePicker, SEQUENCE_PICKER } from './picker/objectPicker.js'

export const SEQUENCE_OPTION = SEQUENCE_PICKER.objectId
export const DATAPOOL_OPTION = SEQUENCE_PICKER.dataPoolId

const COMPARE_CHOICES = [
	{ id: 'eq', label: '=' },
	{ id: 'ne', label: '≠' },
	{ id: 'gt', label: '>' },
	{ id: 'ge', label: '≥' },
	{ id: 'lt', label: '<' },
	{ id: 'le', label: '≤' },
]

/** Key used for feedbacks whose sequence name is not known yet (re-checked when names change). */
const UNRESOLVED_KEY = '?'

/** Compare cue numbers numerically when both are numbers (`4.5` > `4`), else as text. */
export function compareValues(actual: string, op: string, expected: string): boolean {
	const a = actual.trim()
	const e = expected.trim()
	const an = Number(a)
	const en = Number(e)
	const numeric = a !== '' && e !== '' && Number.isFinite(an) && Number.isFinite(en)
	switch (op) {
		case 'eq':
			return numeric ? an === en : a === e
		case 'ne':
			return numeric ? an !== en : a !== e
		case 'gt':
			return numeric && an > en
		case 'ge':
			return numeric && an >= en
		case 'lt':
			return numeric && an < en
		case 'le':
			return numeric && an <= en
		default:
			return false
	}
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	/**
	 * Resolve the watched sequence, register the instance for targeted re-checks, and return its state.
	 * Registration happens in the callback because Companion (base 1.13+) does not call subscribe
	 * again when the user edits the options.
	 */
	const watch = async (
		fb: CompanionFeedbackInfo,
		context: CompanionFeedbackContext,
	): Promise<SequenceState | undefined | null> => {
		const engine = self.engine
		if (!engine) return null
		const { result: r, byName } = await resolvePicker(SEQUENCE_PICKER, fb.options, engine, async (t) =>
			context.parseVariablesInString(t),
		)
		if (!r.ok) {
			// Keep watching: a later name catalog update re-runs it
			engine.watches.set(fb.id, UNRESOLVED_KEY, true)
			return null
		}
		engine.watches.set(fb.id, sequenceKey(r.ref.dataPool, r.ref.sequence), byName)
		return engine.getSequence(r.ref.dataPool, r.ref.sequence)
	}

	const unsubscribe = (fb: CompanionFeedbackInfo): void => {
		self.engine?.watches.remove(fb.id)
	}

	const learnSequence = (fb: CompanionFeedbackInfo, extra: CompanionOptionValues = {}) => {
		const last = self.engine?.lastSequence
		if (!last) return undefined
		return { ...fb.options, ...pickerValues(SEQUENCE_PICKER, last.dataPool, last.sequence), ...extra }
	}

	// DataPool → Sequence dropdowns from the console's name catalog (rebuilt when it changes)
	const sequenceOptions: SomeCompanionFeedbackInputField[] = buildPickerFields(SEQUENCE_PICKER, self.engine?.catalog)

	const defs: CompanionFeedbackDefinitions = {
		sequence_active: {
			type: 'boolean',
			name: 'Sequence: running',
			description:
				'True when the sequence is known to be running. Unknown states (before grandMA3 reported anything) count as not running; combine with "Sequence: state known" to style them.',
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
			options: [
				...sequenceOptions,
				{
					type: 'checkbox',
					label: 'Also active while Flash/Temp is held',
					id: 'include_held',
					default: false,
				},
			],
			callback: async (fb, context) => {
				const s = await watch(fb, context)
				if (!s) return false
				if (s.running === 'on') return true
				return !!fb.options.include_held && (s.held.flash || s.held.temp)
			},
			unsubscribe,
			learn: (fb) => learnSequence(fb),
		},
		seq_state_known: {
			type: 'boolean',
			name: 'Sequence: state known',
			description:
				'True once the running state of the sequence is known (from grandMA3 feedback or a Lua state query). Invert it to style unknown sequences.',
			defaultStyle: { bgcolor: 0x333333, color: 0xffffff },
			options: sequenceOptions,
			callback: async (fb, context) => {
				const s = await watch(fb, context)
				return !!s && s.running !== 'unknown'
			},
			unsubscribe,
			learn: (fb) => learnSequence(fb),
		},
		seq_cue: {
			type: 'boolean',
			name: 'Sequence: current cue',
			description: 'Compare the current cue number of a running sequence (numeric when possible, e.g. 4.5 > 4).',
			defaultStyle: { bgcolor: 0x0000ff, color: 0xffffff },
			options: [
				...sequenceOptions,
				{ type: 'dropdown', label: 'Comparison', id: 'op', default: 'eq', choices: COMPARE_CHOICES },
				{ type: 'textinput', label: 'Cue Number', id: 'cue', default: '1', useVariables: true },
			],
			callback: async (fb, context) => {
				const s = await watch(fb, context)
				if (!s || s.running !== 'on' || s.cueNo === '') return false
				const cue = await context.parseVariablesInString(String(fb.options.cue ?? ''))
				return compareValues(s.cueNo, String(fb.options.op ?? 'eq'), cue)
			},
			unsubscribe,
			learn: (fb) => {
				const last = self.engine?.lastSequence
				return learnSequence(fb, last?.cueNo ? { cue: last.cueNo } : {})
			},
		},
		seq_fader: {
			type: 'boolean',
			name: 'Sequence: master fader level',
			defaultStyle: { bgcolor: 0xffa500, color: 0x000000 },
			options: [
				...sequenceOptions,
				{ type: 'dropdown', label: 'Comparison', id: 'op', default: 'gt', choices: COMPARE_CHOICES },
				{ type: 'number', label: 'Level %', id: 'level', default: 0, min: 0, max: 100, step: 0.1 },
			],
			callback: async (fb, context) => {
				const s = await watch(fb, context)
				if (!s || s.fader === undefined) return false
				return compareValues(String(s.fader), String(fb.options.op ?? 'gt'), String(fb.options.level ?? 0))
			},
			unsubscribe,
			learn: (fb) => learnSequence(fb),
		},
		seq_held: {
			type: 'boolean',
			name: 'Sequence: Flash/Temp/Black/Swap held',
			defaultStyle: { bgcolor: 0xffffff, color: 0x000000 },
			options: [
				...sequenceOptions,
				{
					type: 'dropdown',
					label: 'Function',
					id: 'kind',
					default: 'any',
					choices: [
						{ id: 'any', label: 'Any' },
						...HELD_KINDS.map((k) => ({ id: k, label: k[0].toUpperCase() + k.slice(1) })),
					],
				},
			],
			callback: async (fb, context) => {
				const s = await watch(fb, context)
				if (!s) return false
				const kind = String(fb.options.kind ?? 'any')
				if (kind === 'any') return HELD_KINDS.some((k) => s.held[k])
				return s.held[kind as HeldKind] === true
			},
			unsubscribe,
			learn: (fb) => learnSequence(fb),
		},
		seq_paused: {
			type: 'boolean',
			name: 'Sequence: paused',
			description:
				'True when a Pause was seen after a known start. grandMA3 reports Pause only as a toggle and Lua cannot read it, so this can be unknown (false).',
			defaultStyle: { bgcolor: 0xffff00, color: 0x000000 },
			options: sequenceOptions,
			callback: async (fb, context) => {
				const s = await watch(fb, context)
				return !!s && s.running === 'on' && s.paused === 'yes'
			},
			unsubscribe,
			learn: (fb) => learnSequence(fb),
		},
	}

	self.setFeedbackDefinitions(defs)
}
