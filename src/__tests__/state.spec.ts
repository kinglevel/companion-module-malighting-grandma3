import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeMaMessage, type FaderEvent, type KeyEvent } from '../ma/messages.js'
import { SequenceStore } from '../ma/sequences.js'
import { QueryEngine, type QueryHandlers, type QueryStatus } from '../ma/query.js'
import { compareValues } from '../feedbacks.js'
import type { OscArg } from '../osc/codec.js'

function store(assumeAutoStartStop = true) {
	return new SequenceStore({ assumeAutoStartStop, faderRange: 100, maxSequences: 100 })
}

/** Build an event from MA's wire shape, e.g. key('Go+', 1, 'SM999;1 Cue'). */
function key(func: string, state: number, name: string, seq = 999, dp = 1): KeyEvent {
	const r = decodeMaMessage({ address: `/14.14.${dp}.7.${seq}`, types: 'sis', args: [func, state, name] }, '')
	if (!r.ok || r.event.kind !== 'key') throw new Error('bad key')
	return r.event
}
function fader(value: number, name = 'SM999', seq = 999, dp = 1): FaderEvent {
	const r = decodeMaMessage(
		{ address: `/14.14.${dp}.7.${seq}`, types: 'sifs', args: ['FaderMaster', 1, value, name] },
		'',
	)
	if (!r.ok || r.event.kind !== 'fader') throw new Error('bad fader')
	return r.event
}

describe('sequence state machine (sequences replayed from the live onPC test)', () => {
	it('starts unknown and follows Go+ / cue changes / Off', () => {
		const s = store()
		s.applyKey(key('Go+', 1, 'SM999;0.003 Cue'))
		expect(s.get(1, 999)).toMatchObject({ running: 'on', cueNo: '0.003', cueName: 'Cue', name: 'SM999' })
		s.applyKey(key('Go+', 1, 'SM999;1 Cue'))
		expect(s.get(1, 999)?.cueNo).toBe('1')
		s.applyKey(key('Off', 1, 'SM999'))
		expect(s.get(1, 999)).toMatchObject({ running: 'off', cueNo: '', cueName: '' })
	})

	it('Toggle followed by Off ends off; Toggle alone ends on', () => {
		const s = store()
		s.applyKey(key('Toggle', 1, 'FR P2;1 [Fronts/P1]'))
		expect(s.get(1, 999)?.running).toBe('on')
		s.applyKey(key('Off', 1, 'FR P2'))
		expect(s.get(1, 999)?.running).toBe('off')
	})

	it('held functions do not change the running state', () => {
		const s = store()
		s.applyKey(key('Flash', 1, 'SM999'))
		expect(s.get(1, 999)).toMatchObject({ running: 'unknown', held: { flash: true } })
		s.applyKey(key('Flash', 0, 'SM999'))
		expect(s.get(1, 999)?.held.flash).toBe(false)
		s.applyKey(key('Temp', 1, 'SM999'))
		s.applyKey(key('Off', 1, 'SM999'))
		expect(s.get(1, 999)?.held.temp).toBe(false)
	})

	it('Pause only flips a known paused state; Go+ resumes', () => {
		const s = store()
		s.applyKey(key('Pause', 2, 'SM999'))
		expect(s.get(1, 999)?.paused).toBe('unknown')
		s.applyKey(key('Go+', 1, 'SM999;0.003 Cue'))
		s.applyKey(key('Pause', 2, 'SM999'))
		expect(s.get(1, 999)?.paused).toBe('yes')
		s.applyKey(key('Pause', 2, 'SM999'))
		expect(s.get(1, 999)?.paused).toBe('no')
		s.applyKey(key('Pause', 2, 'SM999'))
		s.applyKey(key('Go+', 1, 'SM999;1 Cue'))
		expect(s.get(1, 999)).toMatchObject({ paused: 'no', cueNo: '1' })
	})

	it('fader AutoStart/AutoStop: MA sends only FaderMaster; assumption + check request', () => {
		const s = store(true)
		s.applyKey(key('Off', 1, 'SM999'))
		expect(s.applyFader(fader(0))?.crossedZero).toBe(true) // first fader of a known seq: 0 is a change from undefined
		const up = s.applyFader(fader(59.999996))
		expect(up?.crossedZero).toBe(true)
		expect(s.get(1, 999)).toMatchObject({ running: 'on', fader: 60, cueNo: '' })
		expect(s.applyFader(fader(80))?.crossedZero).toBe(false) // ride: no query
		const down = s.applyFader(fader(0))
		expect(down?.crossedZero).toBe(true)
		expect(s.get(1, 999)).toMatchObject({ running: 'off', fader: 0 })
	})

	it('asks for a check when a rotary encoder turns a sequence up from 0', () => {
		const s = store()
		s.applyKey(key('Off', 1, 'SM999'))
		s.applyFader(fader(0))
		const r = decodeMaMessage({ address: '/14.14.1.7.999', types: 'sii', args: ['FaderMaster', 0, 1] }, '')
		if (!r.ok || r.event.kind !== 'fader') throw new Error('bad')
		// the engine attributes the encoder to the sequence via the address map
		const ev: FaderEvent = { ...r.event, seq: { dataPool: 1, sequence: 999, name: '' } }
		expect(s.applyFader(ev)?.crossedZero).toBe(true)
		expect(s.get(1, 999)?.name).toBe('SM999')
		s.applyFader(fader(40))
		expect(s.applyFader(ev)?.crossedZero).toBe(false) // already up: a step changes nothing
	})

	it('without the assumption faders never change the running state', () => {
		const s = store(false)
		s.applyKey(key('Off', 1, 'SM999'))
		s.applyFader(fader(0))
		expect(s.applyFader(fader(60))?.crossedZero).toBe(true)
		expect(s.get(1, 999)?.running).toBe('off')
	})

	it('normalises fader values by the OSC entry FaderRange', () => {
		const s = new SequenceStore({ assumeAutoStartStop: true, faderRange: 255, maxSequences: 10 })
		s.applyFader(fader(127.5))
		expect(s.get(1, 999)?.fader).toBe(50)
	})

	it('applies query results and marks everything else off after a full sync', () => {
		const s = store()
		s.applyKey(key('Go+', 1, 'A;1 Cue', 1))
		s.applyKey(key('Go+', 1, 'B;2 Cue', 2))
		s.applyQueried({
			dataPool: 125,
			sequence: 212,
			exists: true,
			running: true,
			cueNo: '1',
			cueName: '[P1]',
			name: 'FR P1',
			fader: 100,
		})
		const changed = s.markOthersOff(new Set(['125.212', '1.1']))
		expect(changed).toEqual(['1.2'])
		expect(s.get(1, 1)?.running).toBe('on')
		expect(s.get(1, 2)?.running).toBe('off')
		expect(s.get(125, 212)).toMatchObject({ running: 'on', cueName: '[P1]', paused: 'unknown' })
		// a query reporting a deleted sequence removes it
		expect(
			s.applyQueried({
				dataPool: 1,
				sequence: 1,
				exists: false,
				running: false,
				cueNo: '',
				cueName: '',
				name: '',
				fader: undefined,
			}).changed,
		).toBe(true)
		expect(s.get(1, 1)).toBeUndefined()
	})

	it('a query racing a fresher key event does not overwrite it (MA activates playback after sending OSC)', () => {
		vi.useFakeTimers()
		const s = store()
		s.applyKey(key('Off', 1, 'SM999'))
		vi.advanceTimersByTime(5000)
		s.applyKey(key('Go+', 1, 'SM999;0.003 Cue'))
		const sentAt = Date.now() + 20 // sync sent right after the Go+ event
		const q = {
			dataPool: 1,
			sequence: 999,
			exists: true,
			running: false,
			cueNo: '',
			cueName: '',
			name: 'SM999',
			fader: 70,
		}
		s.applyQueried(q, sentAt)
		expect(s.get(1, 999)).toMatchObject({ running: 'on', cueNo: '0.003', fader: 70 })
		expect(s.markOthersOff(new Set(), sentAt)).toEqual([])
		expect(s.get(1, 999)?.running).toBe('on')
		// a query sent well after the event is authoritative again
		vi.advanceTimersByTime(3000)
		s.applyQueried(q, Date.now())
		expect(s.get(1, 999)?.running).toBe('off')
		vi.useRealTimers()
	})

	it('fader assumptions do not block the confirming Lua check', () => {
		vi.useFakeTimers()
		const s = store()
		s.applyKey(key('Off', 1, 'SM999'))
		vi.advanceTimersByTime(5000)
		s.applyFader(fader(0))
		s.applyFader(fader(60)) // assumed on
		vi.advanceTimersByTime(300)
		s.applyQueried(
			{ dataPool: 1, sequence: 999, exists: true, running: false, cueNo: '', cueName: '', name: 'SM999', fader: 60 },
			Date.now(),
		)
		expect(s.get(1, 999)?.running).toBe('off') // AutoStart disabled in MA: the check corrects it
		vi.useRealTimers()
	})

	it('normalises unnamed cue names from Lua to the OSC form', () => {
		const s = store()
		const q = { dataPool: 1, sequence: 9, exists: true, running: true, name: 'S', fader: 100 }
		s.applyQueried({ ...q, cueNo: '0.003', cueName: 'Cue 0.003' })
		expect(s.get(1, 9)?.cueName).toBe('Cue')
		s.applyQueried({ ...q, cueNo: '0.003', cueName: 'Cue 7' })
		expect(s.get(1, 9)?.cueName).toBe('Cue 7')
		s.applyQueried({ ...q, cueNo: '2', cueName: 'Big look warm' })
		expect(s.get(1, 9)?.cueName).toBe('Big look warm')
	})

	it('is memory bounded', () => {
		const s = new SequenceStore({ assumeAutoStartStop: true, faderRange: 100, maxSequences: 5 })
		for (let i = 1; i <= 50; i++) s.applyKey(key('Go+', 1, `S${i};1 Cue`, i))
		expect(s.size).toBe(5)
		expect(s.get(1, 50)).toBeDefined()
		expect(s.get(1, 1)).toBeUndefined()
	})

	it('reports unchanged when MA repeats the same state', () => {
		const s = store()
		expect(s.applyKey(key('Go+', 1, 'S;1 Cue'))?.changed).toBe(true)
		expect(s.applyKey(key('Go+', 1, 'S;1 Cue'))?.changed).toBe(false)
	})
})

describe('cue comparison', () => {
	it('compares numerically when possible', () => {
		expect(compareValues('4.5', 'gt', '4')).toBe(true)
		expect(compareValues('10', 'gt', '9')).toBe(true)
		expect(compareValues('1', 'eq', '1.0')).toBe(true)
		expect(compareValues('0.003', 'lt', '1')).toBe(true)
		expect(compareValues('abc', 'eq', 'abc')).toBe(true)
		expect(compareValues('abc', 'gt', '1')).toBe(false)
		expect(compareValues('', 'eq', '')).toBe(true)
		expect(compareValues('', 'lt', '1')).toBe(false)
	})
})

describe('Lua query engine', () => {
	let sent: string[]
	let statuses: QueryStatus[]
	let records: number
	let synced: ReadonlySet<string> | undefined
	let mapSeen: ReadonlyMap<string, string> | undefined
	let engine: QueryEngine

	const handlers = (): QueryHandlers => ({
		sendCommand: (c) => sent.push(c),
		onMap: (m) => (mapSeen = m),
		onRecord: () => records++,
		onSyncComplete: (r) => (synced = r),
		onStatus: (s) => statuses.push(s),
		log: () => undefined,
	})
	const lastId = () => Number(/,(\d+)[,)]/.exec(sent[sent.length - 1])![1])
	const reply = (topic: string, ...args: OscArg[]) => engine.handleReply(topic, args)

	beforeEach(() => {
		vi.useFakeTimers()
		sent = []
		statuses = []
		records = 0
		synced = undefined
		mapSeen = undefined
		engine = new QueryEngine(handlers(), {
			port: 8001,
			timeoutMs: 2000,
			checkDelayMs: 300,
			retryMs: 60_000,
			maxAutoRetries: 2,
			maxBatch: 2,
		})
	})
	afterEach(() => {
		engine.destroy()
		vi.useRealTimers()
	})

	function boot() {
		engine.start(true)
		expect(sent.slice(0, 3).every((c) => c.startsWith('Lua "'))).toBe(true)
		const id = lastId()
		reply('map', id, 'Sequences', '14.14.1.7')
		reply('map', id, 'DataPools', '14.14')
		reply('boot', id, 1, 100)
		reply('end', id, 'boot', 2)
	}

	it('bootstraps, reports the map and syncs', () => {
		boot()
		expect(mapSeen?.get('Sequences')).toBe('14.14.1.7')
		expect(statuses).toEqual(['booting', 'ready'])
		expect(sent[sent.length - 1]).toMatch(/^Lua "CompanionQ\.sync\(8001,\d+\)"$/)
		const id = lastId()
		reply('seq', id, 125, 212, 1, 1, '1', '[P1]', 'FR P1', 100)
		reply('end', id, 'sync', 1, 652)
		expect(records).toBe(1)
		expect([...synced!]).toEqual(['125.212'])
	})

	it('takes the cue number from the cue object when CUENO is empty (2.4)', () => {
		const recs: { cueNo: string; cueName: string }[] = []
		engine.destroy()
		engine = new QueryEngine(
			{ ...handlers(), onRecord: (r) => recs.push(r) },
			{ port: 8001, timeoutMs: 2000, checkDelayMs: 300, retryMs: 60_000, maxAutoRetries: 2, maxBatch: 2 },
		)
		boot()
		const id = lastId()
		reply('seq', id, 1, 999, 1, 1, '', 'Big look', 'S', 100, 2000)
		reply('seq', id, 1, 998, 1, 1, '4.5', 'x', 'S', 100, 4500)
		reply('seq', id, 1, 997, 1, 1, '', 'Cue 0.003', 'S', 100, 3)
		reply('seq', id, 1, 996, 1, 1, '', 'Old', 'S', 100) // 2.5-era reply without the extra field
		expect(recs.map((r) => r.cueNo)).toEqual(['2', '4.5', '0.003', ''])
	})

	it('drops replies with a stale or foreign request id and malformed records', () => {
		boot()
		const id = lastId()
		reply('seq', id + 99, 1, 1, 1, 1, '1', '', 'X', 100)
		reply('end', id + 99, 'sync', 1, 1)
		reply('seq', id, 'bad')
		expect(records).toBe(0)
		expect(synced).toBeUndefined()
	})

	it('batches and debounces targeted checks', () => {
		boot()
		reply('end', lastId(), 'sync', 0, 0)
		const before = sent.length
		engine.check(1, 1)
		engine.check(1, 1)
		engine.check(1, 2)
		engine.check(31, 12)
		expect(sent.length).toBe(before)
		vi.advanceTimersByTime(300)
		expect(sent[sent.length - 1]).toMatch(/CompanionQ\.seqs\(8001,\d+,1,1,1,2\)/)
		reply('end', lastId(), 'seqs', 2)
		expect(sent[sent.length - 1]).toMatch(/CompanionQ\.seqs\(8001,\d+,31,12\)/)
	})

	it('re-bootstraps once when a call is not answered (MA restarted), then gives up', () => {
		boot()
		vi.advanceTimersByTime(6000) // sync unanswered (sync gets 3× the timeout)
		expect(statuses).toEqual(['booting', 'ready', 'booting'])
		vi.advanceTimersByTime(2000) // bootstrap unanswered
		expect(statuses[statuses.length - 1]).toBe('unavailable')
		const count = sent.length
		engine.start() // within retry back-off: nothing sent (every query is visible in MA's command line)
		expect(sent.length).toBe(count)
		engine.start(true) // manual resync forces it
		expect(sent.length).toBeGreaterThan(count)
	})

	it('gives up instead of looping when the bootstrap answers but the sync never does', () => {
		boot() // ready, sync sent
		vi.advanceTimersByTime(6000) // sync timeout → re-bootstrap
		const id = lastId()
		reply('boot', id, 1, 100)
		reply('end', id, 'boot', 0) // bootstrap answered again → sync re-sent
		expect(sent[sent.length - 1]).toMatch(/CompanionQ\.sync/)
		const count = sent.length
		vi.advanceTimersByTime(6000) // second sync timeout → unavailable, nothing more sent
		expect(engine.status).toBe('unavailable')
		expect(sent.length).toBe(count)
		vi.advanceTimersByTime(30_000)
		expect(sent.length).toBe(count)
	})

	it('uses request ids that do not start at a fixed value', () => {
		const other = new QueryEngine(handlers(), {
			port: 8001,
			timeoutMs: 2000,
			checkDelayMs: 300,
			retryMs: 60_000,
			maxAutoRetries: 2,
			maxBatch: 2,
		})
		engine.start(true)
		const a = lastId()
		other.start(true)
		const b = lastId()
		other.destroy()
		expect(a).not.toBe(b)
	})

	it('backs off automatic bootstrap retries and stops after maxAutoRetries', () => {
		const boots = () => sent.filter((c) => c.includes('CompanionQ.boot')).length
		engine.start(true)
		vi.advanceTimersByTime(2000) // failure 1
		expect(boots()).toBe(1)
		vi.advanceTimersByTime(57_000)
		engine.start()
		expect(boots()).toBe(1) // < 60 s since the bootstrap
		vi.advanceTimersByTime(1_000)
		engine.start()
		expect(boots()).toBe(2) // retry 1 after 60 s
		vi.advanceTimersByTime(2000) // failure 2
		vi.advanceTimersByTime(297_000)
		engine.start()
		expect(boots()).toBe(2) // < 5 min
		vi.advanceTimersByTime(1_000)
		engine.start()
		expect(boots()).toBe(3) // retry 2 after 5 min
		vi.advanceTimersByTime(2000) // failure 3 > maxAutoRetries (2)
		vi.advanceTimersByTime(24 * 3600_000)
		engine.start()
		expect(boots()).toBe(3) // gave up automatically
		engine.start(true)
		expect(boots()).toBe(4) // an explicit resync always retries
	})

	it('checks the sequence on an executor after Companion pressed it (MA reports no feedback)', () => {
		boot()
		reply('end', lastId(), 'sync', 0, 0)
		engine.checkExecutor(999, 101)
		engine.checkExecutor(999, 101) // push + release → one query
		engine.checkExecutor(0, 201) // current page
		vi.advanceTimersByTime(300)
		expect(sent[sent.length - 1]).toMatch(/^Lua "CompanionQ\.exec\(8001,\d+,999,101\)"$/)
		reply('end', lastId(), 'exec', 1)
		expect(sent[sent.length - 1]).toMatch(/^Lua "CompanionQ\.exec\(8001,\d+,0,201\)"$/)
		const count = sent.length
		engine.checkExecutor(-1, 5)
		engine.checkExecutor(1, 0)
		vi.advanceTimersByTime(300)
		reply('end', lastId(), 'exec', 0)
		expect(sent.length).toBe(count)
	})

	it('drops checks while unavailable instead of queueing them forever', () => {
		engine.start(true)
		vi.advanceTimersByTime(2000)
		expect(engine.status).toBe('unavailable')
		const count = sent.length
		engine.check(1, 1)
		vi.advanceTimersByTime(300)
		expect(sent.length).toBe(count)
	})
})
