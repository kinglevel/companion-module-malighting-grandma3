/**
 * Turns decoded OSC messages from grandMA3 into typed events.
 *
 * Two sources share the feedback port:
 *  - MA's native "Object Playback Feedback" (`/[prefix/]<dotted handle address> ,si[f][s] ...`)
 *  - replies to our own Lua state queries (`/companion/q/<kind> ...`)
 *
 * Sequences are recognised by message SHAPE, not by a hardcoded pool slot: only sequences carry a
 * trailing name string (`,sis` / `,sifs`), and their address is always `<a>.<b>.<DataPool>.<pool>.<no>`
 * (verified on 172/172 captured sequence messages, and no other object ever sends a name). The pool
 * slot moved between firmware versions (6 on 2.3/2.4, 7 on 2.5), so it is never assumed.
 */

import type { OscMessage } from '../osc/codec.js'

export const QUERY_NAMESPACE = '/companion/q/'

export interface SequenceRef {
	dataPool: number
	sequence: number
	/** Sequence name as MA reported it */
	name: string
	/** Present only when the action landed on a cue */
	cueNo?: string
	cueName?: string
}

export interface ObjectEventBase {
	/** Dotted handle address without prefix, e.g. `14.14.1.7.1` */
	address: string
	path: number[]
	/** The key/fader function that actually ran, e.g. `Go+`, `FaderMaster` */
	func: string
	seq?: SequenceRef
}

export interface KeyEvent extends ObjectEventBase {
	kind: 'key'
	/** 1 press/on, 0 release/off, 2 toggle (Pause, Time) */
	state: number
}

export interface FaderEvent extends ObjectEventBase {
	kind: 'fader'
	/** 1 = on-screen/software, 0 = rotary knob, 3 = physical fader */
	handle: number
	/** Raw value, scaled by the OSC entry's FaderRange. For `relative` moves it is a delta. */
	value: number
	/** `,sii` rotary knob move: `value` is a relative step, not a level */
	relative: boolean
}

export interface QueryReply {
	kind: 'reply'
	/** `boot`, `map`, `seq`, `end`, ... */
	topic: string
	args: OscMessage['args']
}

export type MaEvent = KeyEvent | FaderEvent | QueryReply

export type DecodeResult = { ok: true; event: MaEvent } | { ok: false; reason: 'prefix' | 'shape' | 'address' }

/**
 * Split `/prefix/14.14.1.7.1` into prefix and dotted path.
 * MA sends the bare `/` for pool-level objects (e.g. the Gobo pool itself).
 */
export function splitAddress(address: string): { prefix: string; dotted: string } {
	const trimmed = address.replace(/^\/+/, '')
	const slash = trimmed.lastIndexOf('/')
	if (slash < 0) return { prefix: '', dotted: trimmed }
	return { prefix: trimmed.slice(0, slash), dotted: trimmed.slice(slash + 1) }
}

/** Parse a dotted handle address. Segments can be negative (cue parts, e.g. `.-1.1`). */
export function parseDotted(dotted: string): number[] | undefined {
	if (dotted === '') return undefined
	const parts = dotted.split('.')
	const out: number[] = []
	for (const p of parts) {
		if (!/^-?\d{1,9}$/.test(p)) return undefined
		out.push(Number(p))
	}
	return out
}

/**
 * Parse MA's sequence name argument: `"<Seq>;<CueNo> <CueName>"` or just `"<Seq>"`.
 * Split on the FIRST `;`, then on the FIRST space (cue names may contain spaces; nothing is escaped).
 */
export function parseSequenceName(raw: string): { name: string; cueNo?: string; cueName?: string } {
	const semi = raw.indexOf(';')
	if (semi < 0) return { name: raw }
	const name = raw.slice(0, semi)
	const rest = raw.slice(semi + 1)
	const space = rest.indexOf(' ')
	if (space < 0) return { name, cueNo: rest, cueName: '' }
	return { name, cueNo: rest.slice(0, space), cueName: rest.slice(space + 1) }
}

const CUE_NO = /^\d+(\.\d+)?$/

/**
 * grandMA3 2.3 (verified live on onPC 2.3.2) sends `"<Seq> <CueNo> <CueName>"` separated by SPACES,
 * not `;`, so a name containing digits is ambiguous. With the sequence name known (Lua catalog or an
 * earlier message) the split is exact (`confident`); otherwise the cue number is the first numeric
 * token that follows another numeric token ("Sequence 1 1 Cue", "Show Seq 9 2 Big look 2 warm"),
 * else the first numeric token after the first word ("VizCamera 17 Studio Wide").
 */
export function splitLegacyName(
	raw: string,
	knownName?: string,
): { name: string; cueNo?: string; cueName?: string; confident: boolean } {
	if (knownName && raw.length > knownName.length && raw.toLowerCase().startsWith(knownName.toLowerCase() + ' ')) {
		const rest = raw.slice(knownName.length + 1)
		const space = rest.indexOf(' ')
		const cueNo = space < 0 ? rest : rest.slice(0, space)
		if (CUE_NO.test(cueNo)) {
			return {
				name: raw.slice(0, knownName.length),
				cueNo,
				cueName: space < 0 ? '' : rest.slice(space + 1),
				confident: true,
			}
		}
	}
	const t = raw.split(' ')
	let idx = -1
	for (let i = 1; i < t.length && idx < 0; i++) if (CUE_NO.test(t[i]) && CUE_NO.test(t[i - 1])) idx = i
	for (let i = 1; i < t.length && idx < 0; i++) if (CUE_NO.test(t[i])) idx = i
	if (idx < 0) return { name: raw, confident: false }
	return { name: t.slice(0, idx).join(' '), cueNo: t[idx], cueName: t.slice(idx + 1).join(' '), confident: false }
}

function asSequence(path: number[], nameArg: unknown): SequenceRef | undefined {
	if (typeof nameArg !== 'string' || path.length !== 5) return undefined
	const dataPool = path[2]
	const sequence = path[4]
	if (dataPool < 1 || sequence < 1) return undefined
	return { dataPool, sequence, ...parseSequenceName(nameArg) }
}

/**
 * Decode one OSC message.
 * @param expectedPrefix the configured output prefix; empty accepts any (or no) prefix
 */
export function decodeMaMessage(msg: OscMessage, expectedPrefix: string): DecodeResult {
	if (msg.address.startsWith(QUERY_NAMESPACE)) {
		const topic = msg.address.slice(QUERY_NAMESPACE.length)
		if (!/^[a-z]{1,16}$/.test(topic)) return { ok: false, reason: 'address' }
		return { ok: true, event: { kind: 'reply', topic, args: msg.args } }
	}

	const { prefix, dotted } = splitAddress(msg.address)
	const want = expectedPrefix.replace(/^\/+|\/+$/g, '')
	if (want && prefix !== want) return { ok: false, reason: 'prefix' }

	const path = parseDotted(dotted)
	if (!path) return { ok: false, reason: 'address' }

	const [func, arg2] = msg.args
	if (typeof func !== 'string' || typeof arg2 !== 'number') return { ok: false, reason: 'shape' }

	const t = msg.types
	if (t === 'si' || t === 'sis') {
		return {
			ok: true,
			event: { kind: 'key', address: dotted, path, func, state: arg2, seq: asSequence(path, msg.args[2]) },
		}
	}
	if (t === 'sif' || t === 'sifs' || t === 'sii') {
		const value = msg.args[2]
		if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'shape' }
		return {
			ok: true,
			event: {
				kind: 'fader',
				address: dotted,
				path,
				func,
				handle: arg2,
				value,
				relative: t === 'sii',
				seq: asSequence(path, msg.args[3]),
			},
		}
	}
	return { ok: false, reason: 'shape' }
}
