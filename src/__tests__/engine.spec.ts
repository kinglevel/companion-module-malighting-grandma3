import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import { FeedbackEngine, type EngineHost } from '../feedback/engine.js'
import type { OscMessage } from '../osc/codec.js'

const go = (seq: number, cue: string, dp = 1): OscMessage => ({
	address: `/14.14.${dp}.7.${seq}`,
	types: 'sis',
	args: ['Go+', 1, `Seq ${seq};${cue} Cue ${cue}`],
})
const fader = (seq: number, value: number): OscMessage => ({
	address: `/14.14.1.7.${seq}`,
	types: 'sifs',
	args: ['FaderMaster', 1, value, `Seq ${seq}`],
})

describe('feedback engine', () => {
	let checked: string[][]
	let values: CompanionVariableValues[]
	let defs: CompanionVariableDefinition[][]
	let commands: string[]
	let engine: FeedbackEngine

	const host = (): EngineHost => ({
		log: () => undefined,
		sendCommand: (c) => commands.push(c),
		checkFeedbacksById: (...ids) => checked.push(ids),
		setVariableDefinitions: (d) => defs.push(d),
		setVariableValues: (v) => values.push(v),
		statusChanged: () => undefined,
	})

	beforeEach(() => {
		vi.useFakeTimers()
		checked = []
		values = []
		defs = []
		commands = []
		engine = new FeedbackEngine(host(), {
			outputPrefix: '',
			luaQueries: false,
			assumeAutoStart: true,
			debug: false,
			feedbackPort: 8001,
		})
	})
	afterEach(() => {
		engine.destroy()
		vi.useRealTimers()
	})

	it('re-checks only the feedbacks watching the changed sequence, coalesced', () => {
		engine.watches.set('fbA', '1.5')
		engine.watches.set('fbB', '1.6')
		engine.watches.set('fbC', '1.5')
		for (let i = 0; i < 20; i++) engine.handleMessages([go(5, String(i))])
		vi.advanceTimersByTime(60)
		expect(checked).toHaveLength(1)
		expect(checked[0].sort()).toEqual(['fbA', 'fbC'])
	})

	it('moves a watch when the feedback options change and forgets it on unsubscribe', () => {
		engine.watches.set('fbA', '1.5')
		engine.watches.set('fbA', '1.6')
		engine.handleMessages([go(5, '1')])
		vi.advanceTimersByTime(60)
		expect(checked).toHaveLength(0)
		engine.watches.remove('fbA')
		engine.handleMessages([go(6, '1')])
		vi.advanceTimersByTime(60)
		expect(checked).toHaveLength(0)
	})

	it('defines per-sequence variables once (debounced) and only sends changed values', () => {
		engine.handleMessages([go(5, '1'), go(7, '2', 31)])
		vi.advanceTimersByTime(1100)
		const last = defs[defs.length - 1].map((d) => d.variableId)
		expect(last).toContain('seq_1_5_cue')
		expect(last).toContain('seq_31_7_cue_name')
		vi.advanceTimersByTime(100)
		const merged = Object.assign({}, ...values)
		expect(merged).toMatchObject({ seq_1_5_cue: '1', seq_1_5_running: 'on', seq_31_7_cue: '2', last_seq: '31.7' })
		values = []
		engine.handleMessages([go(5, '1')]) // same state again
		vi.advanceTimersByTime(100)
		const again = Object.assign({}, ...values)
		expect(again.seq_1_5_cue).toBeUndefined()
	})

	it('a full sync marks watched sequences that are not running as off (not unknown)', () => {
		const lua = new FeedbackEngine(host(), {
			outputPrefix: '',
			luaQueries: true,
			assumeAutoStart: true,
			debug: false,
			feedbackPort: 8001,
		})
		lua.watches.set('fbIdle', '1.42')
		lua.watches.set('fbRun', '125.212')
		lua.startQueries()
		const id = () => Number(/,(\d+)\)"$/.exec(commands[commands.length - 1])![1])
		const r = (topic: string, ...args: (string | number)[]) =>
			lua.handleMessages([{ address: `/companion/q/${topic}`, types: '', args }])
		let req = id()
		r('map', req, 'DataPools', '14.14')
		r('map', req, 'Sequences', '14.14.1.7')
		r('boot', req, 1, 100)
		r('end', req, 'boot', 2)
		req = id()
		r('seq', req, 125, 212, 1, 1, '1', '[P1]', 'FR P1', 100)
		r('end', req, 'sync', 1, 652)
		expect(lua.getSequence(1, 42)?.running).toBe('off')
		expect(lua.getSequence(125, 212)?.running).toBe('on')
		expect(lua.addressMap.fromConsole).toBe(true)
		lua.destroy()
	})

	it('attributes rotary encoder moves (no name) to sequences via the address map', () => {
		engine.handleMessages([{ address: '/14.14.1.7.5', types: 'sis', args: ['Off', 1, 'Seq 5'] }])
		engine.handleMessages([{ address: '/14.14.1.7.5', types: 'sifs', args: ['FaderMaster', 1, 0, 'Seq 5'] }])
		engine.handleMessages([{ address: '/14.14.1.7.5', types: 'sii', args: ['FaderMaster', 0, 1] }])
		expect(engine.lastSequence).toMatchObject({ dataPool: 1, sequence: 5 })
		expect(engine.getSequence(1, 5)?.name).toBe('Seq 5')
		// a group encoder is not a sequence
		engine.handleMessages([{ address: '/14.14.1.6.5', types: 'sii', args: ['FaderMaster', 0, 1] }])
		expect(engine.lastSequence).toMatchObject({ dataPool: 1, sequence: 5 })
		vi.advanceTimersByTime(100)
		expect(Object.assign({}, ...values).last_object).toBe('Group 5 (DataPool 1)')
	})

	it('learn source follows the last operated sequence', () => {
		engine.handleMessages([go(12, '4.5', 31)])
		expect(engine.lastSequence).toEqual({ dataPool: 31, sequence: 12, cueNo: '4.5' })
	})

	it('runs without Lua queries (no commands sent) and applies the AutoStart fallback', () => {
		engine.handleMessages([go(5, '1'), { address: '/14.14.1.7.5', types: 'sis', args: ['Off', 1, 'Seq 5'] }])
		engine.handleMessages([fader(5, 0), fader(5, 50)])
		expect(engine.getSequence(1, 5)?.running).toBe('on')
		expect(commands).toEqual([])
	})

	it('ignores garbage without throwing', () => {
		expect(() =>
			engine.handleMessages([
				{ address: '/14.14.1.7.5', types: 'sis', args: [1, 'x', 2] },
				{ address: '/', types: 'si', args: ['Go+', 1] },
				{ address: '/companion/q/seq', types: 'i', args: [123] },
			]),
		).not.toThrow()
	})
})
