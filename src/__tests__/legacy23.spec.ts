import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FeedbackEngine, type EngineHost } from '../feedback/engine.js'
import { splitLegacyName } from '../ma/messages.js'
import type { OscMessage } from '../osc/codec.js'

/** Captured live from grandMA3 onPC 2.3.2 and 2.4.2 (Sequence 999 "Show Seq 9", cue 2 "Big look 2 warm"). */
interface Fixture extends OscMessage {
	step: string
}
const load = (version: string): Fixture[] =>
	readFileSync(fileURLToPath(new URL(`./fixtures/ma3-feedback-${version}.jsonl`, import.meta.url)), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Fixture)

describe('grandMA3 2.3 name format', () => {
	it('splits "<Seq> <CueNo> <CueName>" with a known sequence name exactly', () => {
		expect(splitLegacyName('Show Seq 9 2 Big look 2 warm', 'Show Seq 9')).toEqual({
			name: 'Show Seq 9',
			cueNo: '2',
			cueName: 'Big look 2 warm',
			confident: true,
		})
	})

	it('falls back to a digit-aware heuristic without a known name', () => {
		expect(splitLegacyName('Sequence 1 1 Cue')).toMatchObject({ name: 'Sequence 1', cueNo: '1', cueName: 'Cue' })
		expect(splitLegacyName('Show Seq 9 2 Big look 2 warm')).toMatchObject({
			name: 'Show Seq 9',
			cueNo: '2',
			cueName: 'Big look 2 warm',
		})
		expect(splitLegacyName('VizCamera 17 Studio Wide')).toMatchObject({
			name: 'VizCamera',
			cueNo: '17',
			cueName: 'Studio Wide',
		})
		expect(splitLegacyName('FR P2 1 [Fronts]')).toMatchObject({ name: 'FR P2', cueNo: '1', cueName: '[Fronts]' })
		expect(splitLegacyName('Show 4.5 Fade')).toMatchObject({ name: 'Show', cueNo: '4.5' })
		expect(splitLegacyName('NoCueHere')).toEqual({ name: 'NoCueHere', confident: false })
	})
})

for (const version of ['2.3.2', '2.4.2']) {
	const fixtures = load(version)
	const steps = [...new Set(fixtures.map((f) => f.step))]
	const messagesOf = (step: string) => fixtures.filter((f) => f.step === step)

	describe(`replaying the live ${version} capture through the engine (no Lua)`, () => {
		let engine: FeedbackEngine
		const host = (): EngineHost => ({
			log: () => undefined,
			sendCommand: () => undefined,
			checkFeedbacksById: () => undefined,
			setVariableDefinitions: () => undefined,
			setVariableValues: () => undefined,
			statusChanged: () => undefined,
		})
		beforeEach(() => {
			vi.useFakeTimers()
			engine = new FeedbackEngine(host(), {
				outputPrefix: '',
				luaQueries: false,
				assumeAutoStart: true,
				debug: false,
				feedbackPort: 8031,
			})
		})
		afterEach(() => {
			engine.destroy()
			vi.useRealTimers()
		})

		it('has the expected steps', () => {
			expect(steps).toContain('Go+')
			expect(steps).toContain('Off')
		})

		it('follows the sequence through every captured step, including nameless Off/Pause/Flash/fader', () => {
			const seq = () => engine.getSequence(1, 999)
			const expectations: Record<string, (s: ReturnType<typeof seq>) => void> = {
				'Go+': (s) => expect(s).toMatchObject({ running: 'on', cueNo: '1', cueName: 'Cue', name: 'Show Seq 9' }),
				'Go+ (cue 2, named with digits)': (s) =>
					expect(s).toMatchObject({ running: 'on', cueNo: '2', cueName: 'Big look 2 warm' }),
				'Goto Cue 1': (s) => expect(s).toMatchObject({ running: 'on', cueNo: '1' }),
				'Pause, Pause': (s) => expect(s?.paused).toBe('no'), // known after Go+: paused twice → back to no
				'Flash On/Off': (s) => expect(s?.held.flash).toBe(false),
				Off: (s) => expect(s).toMatchObject({ running: 'off', name: 'Show Seq 9' }), // ",si Off" has no name
				On: (s) => expect(s).toMatchObject({ running: 'on', cueNo: '1' }),
				'FaderMaster 50': (s) => expect(s?.fader).toBe(50), // ",sif" without name, attributed by address
				'FaderMaster 0 (autostop)': (s) => expect(s).toMatchObject({ fader: 0, running: 'off' }),
				'FaderMaster 70 (autostart)': (s) => expect(s).toMatchObject({ fader: 70, running: 'on' }),
				'Off Page 999': (s) => expect(s?.running).toBe('off'),
				'Go+ via executor': (s) => expect(s?.running).toBe('on'),
			}
			for (const step of steps) {
				engine.handleMessages(messagesOf(step))
				expectations[step]?.(seq())
			}
			// the Sequences slot (6 on 2.3) was learned from the first named message
			expect(engine.addressMap.sequencesSlot()).toBe(6)
			// a Group (slot 5 on 2.3) is not mistaken for a sequence
			expect(engine.getSequence(1, 1)).toBeUndefined()
		})

		it('does not treat nameless messages as sequences before the layout is known', () => {
			engine.handleMessages([{ address: '/14.14.1.7.3', types: 'si', args: ['Off', 1] }]) // 2.3 slot 7 = Plugins
			expect(engine.getSequence(1, 3)).toBeUndefined()
		})
	})
}
