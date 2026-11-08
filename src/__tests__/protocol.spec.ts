import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodePacket, encodeMessage, type OscMessage } from '../osc/codec.js'
import { decodeMaMessage, parseSequenceName, splitAddress } from '../ma/messages.js'
import { AddressMap } from '../ma/addressMap.js'
import { BOOTSTRAP_PARTS, bootCall, luaCommand, seqsCall, syncCall } from '../ma/lua.js'

interface Fixture extends OscMessage {
	src: string
	step: string
}

const fixtures: Fixture[] = readFileSync(
	fileURLToPath(new URL('./fixtures/ma3-feedback.jsonl', import.meta.url)),
	'utf8',
)
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l) as Fixture)

/** Encode a fixture the way MA puts it on the wire (only i/f/s occur in captures). */
function wire(m: OscMessage): Buffer {
	return encodeMessage(m.address, m.types, m.args)
}

describe('OSC codec', () => {
	it('round-trips every captured grandMA3 message', () => {
		for (const f of fixtures) {
			const [m] = decodePacket(wire(f))
			expect(m.address).toBe(f.address)
			expect(m.types).toBe(f.types)
			m.args.forEach((a, i) => {
				if (typeof a === 'number' && f.types[i] === 'f') expect(a).toBeCloseTo(f.args[i] as number, 3)
				else expect(a).toEqual(f.args[i])
			})
		}
	})

	it('never throws on garbage and returns nothing for malformed packets', () => {
		const good = encodeMessage('/14.14.1.7.1', 'sis', ['Go+', 1, 'Seq;1 Cue'])
		for (let cut = 0; cut < good.length; cut++) {
			expect(() => decodePacket(good.subarray(0, cut))).not.toThrow()
		}
		expect(decodePacket(Buffer.from('not osc at all'))).toEqual([])
		expect(decodePacket(Buffer.alloc(0))).toEqual([])
		// unknown type tag
		expect(decodePacket(Buffer.concat([encodeMessage('/a', '', []).subarray(0, 4), Buffer.from(',x\0\0')]))).toEqual([])
	})

	it('decodes datagrams delivered as a plain Uint8Array (Companion shared UDP socket over EJSON IPC)', () => {
		const wireBytes = encodeMessage('/14.14.1.7.1', 'sis', ['Go+', 1, 'Seq;1 Cue'])
		const plain = new Uint8Array(wireBytes) // copy, not a Buffer
		expect(Buffer.isBuffer(plain)).toBe(false)
		expect(decodePacket(plain)).toEqual([{ address: '/14.14.1.7.1', types: 'sis', args: ['Go+', 1, 'Seq;1 Cue'] }])
		// a Uint8Array view into a larger buffer
		const big = new Uint8Array(wireBytes.length + 8)
		big.set(wireBytes, 4)
		expect(decodePacket(big.subarray(4, 4 + wireBytes.length))[0].address).toBe('/14.14.1.7.1')
	})

	it('decodes bundles, including nested ones', () => {
		const a = encodeMessage('/a', 'i', [1])
		const b = encodeMessage('/b', 's', ['x'])
		const bundle = (parts: Buffer[]) =>
			Buffer.concat([
				Buffer.from('#bundle\0'),
				Buffer.alloc(8),
				...parts.flatMap((p) => {
					const len = Buffer.alloc(4)
					len.writeInt32BE(p.length)
					return [len, p]
				}),
			])
		const msgs = decodePacket(bundle([a, bundle([b])]))
		expect(msgs.map((m) => m.address)).toEqual(['/a', '/b'])
	})
})

describe('grandMA3 message decoding', () => {
	it('detects sequences only by message shape (172 named messages, all x.x.DP.7.n on 2.5)', () => {
		let named = 0
		for (const f of fixtures) {
			const res = decodeMaMessage(f, '')
			const hasName = f.types === 'sis' || f.types === 'sifs'
			if (!res.ok) {
				// Only SendOSC test traffic and pool-level `/` addresses are not object feedback
				expect(hasName).toBe(false)
				continue
			}
			const ev = res.event
			if (ev.kind === 'reply') continue
			if (hasName) {
				named++
				expect(ev.seq, f.address).toBeDefined()
				expect(ev.path).toHaveLength(5)
				expect(ev.path[3]).toBe(7)
				expect(ev.seq!.dataPool).toBe(ev.path[2])
				expect(ev.seq!.sequence).toBe(ev.path[4])
			} else {
				expect(ev.seq).toBeUndefined()
			}
		}
		expect(named).toBeGreaterThanOrEqual(172)
	})

	it('parses the sequence name argument (first ; then first space)', () => {
		expect(parseSequenceName('FR P2;1 [Fronts/P1]')).toEqual({ name: 'FR P2', cueNo: '1', cueName: '[Fronts/P1]' })
		expect(parseSequenceName('OSCTest')).toEqual({ name: 'OSCTest' })
		expect(parseSequenceName('A;B;4.5 Big look here')).toEqual({ name: 'A', cueNo: 'B;4.5', cueName: 'Big look here' })
		expect(parseSequenceName('S;3')).toEqual({ name: 'S', cueNo: '3', cueName: '' })
	})

	it('handles prefixes', () => {
		const msg = { address: '/oscfb/14.14.1.7.999', types: 'sis', args: ['Go+', 1, 'X;1 Cue'] }
		expect(decodeMaMessage(msg, '').ok).toBe(true)
		expect(decodeMaMessage(msg, 'oscfb').ok).toBe(true)
		expect(decodeMaMessage(msg, '/oscfb/').ok).toBe(true)
		expect(decodeMaMessage(msg, 'other')).toEqual({ ok: false, reason: 'prefix' })
		expect(decodeMaMessage({ ...msg, address: '/14.14.1.7.999' }, 'oscfb')).toEqual({ ok: false, reason: 'prefix' })
		expect(splitAddress('/a/b/14.1')).toEqual({ prefix: 'a/b', dotted: '14.1' })
	})

	it('decodes key and fader events with their arguments', () => {
		const key = decodeMaMessage({ address: '/14.14.1.7.1', types: 'sis', args: ['Pause', 2, 'S'] }, '')
		expect(key).toMatchObject({ ok: true, event: { kind: 'key', func: 'Pause', state: 2 } })
		const fader = decodeMaMessage({ address: '/14.13.2.1', types: 'sif', args: ['FaderMaster', 1, 50] }, '')
		expect(fader).toMatchObject({ ok: true, event: { kind: 'fader', value: 50, relative: false, seq: undefined } })
		const knob = decodeMaMessage({ address: '/13.13.1.6.1', types: 'sii', args: ['FaderMaster', 0, -1] }, '')
		expect(knob).toMatchObject({ ok: true, event: { kind: 'fader', relative: true, value: -1 } })
		const part = decodeMaMessage({ address: '/14.14.1.7.999.-1.1', types: 'si', args: ['Go+', 1] }, '')
		expect(part).toMatchObject({ ok: true, event: { kind: 'key', path: [14, 14, 1, 7, 999, -1, 1], seq: undefined } })
	})

	it('rejects malformed shapes and addresses', () => {
		expect(decodeMaMessage({ address: '/14.x.1', types: 'si', args: ['Go+', 1] }, '').ok).toBe(false)
		expect(decodeMaMessage({ address: '/14.14.1.7.1', types: 's', args: ['Go+'] }, '').ok).toBe(false)
		expect(decodeMaMessage({ address: '/14.14.1.7.1', types: 'ii', args: [1, 1] }, '').ok).toBe(false)
		expect(decodeMaMessage({ address: '/14.14.1.7.1', types: 'sif', args: ['F', 1, NaN] }, '').ok).toBe(false)
		expect(decodeMaMessage({ address: '/companion/q/BAD!', types: 'i', args: [1] }, '').ok).toBe(false)
		expect(decodeMaMessage({ address: '/companion/q/seq', types: 'i', args: [1] }, 'pfx')).toMatchObject({
			ok: true,
			event: { kind: 'reply', topic: 'seq' },
		})
	})
})

describe('address map', () => {
	it('describes addresses with the built-in 2.5 fallback', () => {
		const m = new AddressMap()
		expect(m.fromConsole).toBe(false)
		expect(m.sequencesSlot()).toBe(7)
		expect(m.describe([14, 14, 31, 6, 4])).toBe('Group 4 (DataPool 31)')
		expect(m.describe([14, 14, 1, 5, 4, 2])).toBe('Preset 4.2 (DataPool 1)')
		expect(m.describe([14, 13, 2, 1])).toBe('Master Grand 1')
		expect(m.describe([14, 2, 6, 1])).toBe('14.2.6.1')
	})

	it('follows a firmware that moved collections (2.4 layout: Sequences at slot 6)', () => {
		const m = new AddressMap()
		const ok = m.update(
			new Map([
				['DataPools', '14.14'],
				['Groups', '14.14.1.5'],
				['Sequences', '14.14.1.6'],
				['MasterPoolGrand', '14.13.2'],
			]),
		)
		expect(ok).toBe(true)
		expect(m.fromConsole).toBe(true)
		expect(m.sequencesSlot()).toBe(6)
		expect(m.describe([14, 14, 1, 6, 3])).toBe('Sequence 3 (DataPool 1)')
		expect(m.describe([14, 14, 1, 5, 3])).toBe('Group 3 (DataPool 1)')
	})

	it('keeps the fallback when the console answer is incomplete', () => {
		const m = new AddressMap()
		expect(m.update(new Map([['Groups', '14.14.1.6']]))).toBe(false)
		expect(m.fromConsole).toBe(false)
	})
})

describe('Lua templates', () => {
	it('are single-line and free of double quotes and backslashes', () => {
		for (const part of BOOTSTRAP_PARTS) {
			expect(part).not.toMatch(/["\\\r\n]/)
			expect(() => luaCommand(part)).not.toThrow()
		}
	})

	it('navigate the tree by name, never by position', () => {
		const all = BOOTSTRAP_PARTS.join(' ')
		expect(all).toContain('Root().ShowData.DataPools')
		expect(all).toContain('Root().ShowData.OSCBase')
		expect(all).toContain('d.Sequences')
		expect(all).not.toMatch(/:Ptr\(|ShowData\(\)|ObjectList\(/)
	})

	it('only interpolate validated integers', () => {
		expect(syncCall(8001, 17)).toBe('Lua "CompanionQ.sync(8001,17)"')
		expect(bootCall(8001, 1)).toBe('Lua "CompanionQ.boot(8001,1)"')
		expect(
			seqsCall(8001, 3, [
				{ dataPool: 1, sequence: 999 },
				{ dataPool: 31, sequence: 12 },
			]),
		).toBe('Lua "CompanionQ.seqs(8001,3,1,999,31,12)"')
		expect(() => seqsCall(8001, 3, [{ dataPool: 1.5, sequence: 1 }])).toThrow()
		expect(() => syncCall(-1, 1)).toThrow()
		expect(() => luaCommand('x="y"')).toThrow()
	})
})
