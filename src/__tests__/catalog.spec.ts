import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NameCatalog, normaliseName } from '../ma/catalog.js'
import { FeedbackEngine, type EngineHost } from '../feedback/engine.js'
import type { OscArg } from '../osc/codec.js'
import { BOOTSTRAP_PARTS } from '../ma/lua.js'

describe('name catalog', () => {
	function catalog() {
		const c = new NameCatalog()
		c.setDataPool(1, 'Default')
		c.setDataPool(2, 'Stadshuset')
		c.setDataPool(125, 'Show')
		c.setSequence(1, 1, 'Sequence 1')
		c.setSequence(1, 5, 'House Lights')
		c.setSequence(125, 212, 'FR P1')
		c.setSequence(125, 76, 'BUMP')
		c.setSequence(2, 7, 'FR P1')
		return c
	}

	it('accepts numbers for both fields', () => {
		expect(catalog().resolve('125', '212')).toEqual({ ok: true, ref: { dataPool: 125, sequence: 212 } })
		expect(catalog().resolve('', '5')).toEqual({ ok: true, ref: { dataPool: 1, sequence: 5 } })
		// numbers do not need to be in the catalog (the sequence may not exist yet)
		expect(catalog().resolve('1', '999')).toEqual({ ok: true, ref: { dataPool: 1, sequence: 999 } })
	})

	it('resolves names case-insensitively, inside the chosen DataPool', () => {
		const c = catalog()
		expect(c.resolve('Show', 'fr p1')).toEqual({ ok: true, ref: { dataPool: 125, sequence: 212 } })
		expect(c.resolve('stadshuset', 'FR P1')).toEqual({ ok: true, ref: { dataPool: 2, sequence: 7 } })
		expect(c.resolve('125', ' "BUMP" ')).toEqual({ ok: true, ref: { dataPool: 125, sequence: 76 } })
		expect(c.resolve('1', 'house lights')).toEqual({ ok: true, ref: { dataPool: 1, sequence: 5 } })
		expect(c.resolve('Default', 'FR P1')).toEqual({ ok: false, reason: 'unknown-sequence' })
		expect(c.resolve('Nope', '1')).toEqual({ ok: false, reason: 'unknown-datapool' })
		expect(c.resolve('1', '  ')).toEqual({ ok: false, reason: 'empty' })
	})

	it('prefers the lowest number when a name exists twice in a DataPool', () => {
		const c = catalog()
		c.setSequence(125, 300, 'BUMP')
		c.setSequence(125, 10, 'BUMP')
		expect(c.resolve('125', 'bump')).toEqual({ ok: true, ref: { dataPool: 125, sequence: 10 } })
	})

	it('follows renames and deletions and reports changes via version', () => {
		const c = catalog()
		const v = c.version
		expect(c.setSequence(1, 5, 'House Lights')).toBe(false)
		expect(c.version).toBe(v)
		expect(c.setSequence(1, 5, 'Worklight')).toBe(true)
		expect(c.resolve('1', 'House Lights').ok).toBe(false)
		expect(c.resolve('1', 'worklight')).toEqual({ ok: true, ref: { dataPool: 1, sequence: 5 } })
		expect(c.removeSequence(1, 5)).toBe(true)
		expect(c.resolve('1', 'worklight').ok).toBe(false)
	})

	it('normalises names', () => {
		expect(normaliseName('  "FR P1" ')).toBe('fr p1')
		expect(normaliseName("'x'")).toBe('x')
	})
})

describe('names through the engine', () => {
	let commands: string[]
	let checked: string[][]
	let engine: FeedbackEngine
	const host = (): EngineHost => ({
		log: () => undefined,
		sendCommand: (c) => commands.push(c),
		checkFeedbacksById: (...ids) => checked.push(ids),
		setVariableDefinitions: () => undefined,
		setVariableValues: () => undefined,
		statusChanged: () => undefined,
	})
	const id = () => Number(/,(\d+)\)"$/.exec(commands[commands.length - 1])![1])
	const reply = (topic: string, types: string, ...args: OscArg[]) =>
		engine.handleMessages([{ address: `/companion/q/${topic}`, types, args }])

	beforeEach(() => {
		vi.useFakeTimers()
		commands = []
		checked = []
		engine = new FeedbackEngine(host(), {
			outputPrefix: '',
			luaQueries: true,
			assumeAutoStart: true,
			debug: false,
			feedbackPort: 8001,
		})
		engine.startQueries()
		const boot = id()
		reply('map', 'iss', boot, 'DataPools', '14.14')
		reply('map', 'iss', boot, 'Sequences', '14.14.1.7')
		reply('end', 'isi', boot, 'boot', 2)
	})
	afterEach(() => {
		engine.destroy()
		vi.useRealTimers()
	})

	it('learns names from the sync catalog and re-checks watched feedbacks', () => {
		engine.watches.set('fbX', '?', true) // a feedback waiting for a name
		engine.watches.set('fbNum', '1.1') // addressed by number: unaffected by name changes
		const sync = id()
		reply('cat', 'isiis', sync, 'DataPools', 125, 125, 'Show')
		reply('cat', 'is' + 'iis'.repeat(2), sync, 'Sequences', 125, 212, 'FR P1', 125, 76, 'BUMP')
		reply('end', 'isii', sync, 'sync', 0, 2)
		vi.advanceTimersByTime(60)
		expect(checked.flat()).toContain('fbX')
		expect(checked.flat()).not.toContain('fbNum')
		expect(engine.resolve('Show', 'FR P1')).toEqual({ ok: true, ref: { dataPool: 125, sequence: 212 } })
	})

	it('learns sequence names from MA feedback (renames included)', () => {
		reply('end', 'isii', id(), 'sync', 0, 0)
		engine.handleMessages([{ address: '/14.14.1.7.5', types: 'sis', args: ['Go+', 1, 'House;1 Cue'] }])
		expect(engine.resolve('1', 'house')).toEqual({ ok: true, ref: { dataPool: 1, sequence: 5 } })
		engine.handleMessages([{ address: '/14.14.1.7.5', types: 'sis', args: ['Off', 1, 'Worklight'] }])
		expect(engine.resolve('1', 'worklight').ok).toBe(true)
		expect(engine.resolve('1', 'house').ok).toBe(false)
	})

	it('an unknown name requests at most one catalog refresh per minute', () => {
		reply('end', 'isii', id(), 'sync', 0, 0)
		const syncs = () => commands.filter((c) => c.includes('CompanionQ.sync')).length
		const before = syncs()
		engine.resolve('1', 'does not exist')
		engine.resolve('1', 'does not exist')
		expect(syncs()).toBe(before + 1)
		reply('end', 'isii', id(), 'sync', 0, 0)
		engine.resolve('1', 'still missing')
		expect(syncs()).toBe(before + 1)
		vi.advanceTimersByTime(60_000)
		engine.resolve('1', 'still missing')
		expect(syncs()).toBe(before + 2)
	})

	it('never puts user text into a Lua command', () => {
		engine.resolve('1', `x') os.execute('rm -rf') --`)
		vi.advanceTimersByTime(60_000)
		engine.resolve('Default"; Cmd("Off Page 1")', 'FR P1')
		const parts = new Set(BOOTSTRAP_PARTS.map((p) => `Lua "${p}"`))
		for (const c of commands) {
			if (parts.has(c)) continue
			expect(c).toMatch(/^Lua "CompanionQ\.(sync|seqs|boot|exec)\([\d,]+\)"$/)
		}
	})
})
