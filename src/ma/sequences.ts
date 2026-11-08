/**
 * Per-sequence state derived from grandMA3's event stream and from Lua state queries.
 *
 * MA sends EVENTS, not state, so every field can be "unknown". Rules (verified live on onPC 2.5.1.1):
 *  - Go+ / Go- / Goto / Top / On / Toggle / Kill / >>> / <<< land the sequence on a cue → running.
 *  - Off → off. When Toggle or Kill switch a sequence off MA follows up with an explicit Off,
 *    so processing messages in order gives the right result.
 *  - Flash / Temp / Black / Swap send 1 on press and 0 on release → "held" flags, running unchanged.
 *  - Pause always sends 2 (toggle) → only flipped when the paused state is already known.
 *  - Fader AutoStart/AutoStop change the running state but MA sends ONLY the fader value. This is
 *    handled by an optional assumption plus a Lua check (see `FaderOutcome.crossedZero`).
 */

import type { FaderEvent, KeyEvent } from './messages.js'

export type Tri = 'on' | 'off' | 'unknown'
export type HeldKind = 'flash' | 'temp' | 'black' | 'swap'
export const HELD_KINDS: readonly HeldKind[] = ['flash', 'temp', 'black', 'swap']

export interface SequenceState {
	dataPool: number
	sequence: number
	name: string
	running: Tri
	/** Cue number as MA prints it (`1`, `4.5`), '' when unknown */
	cueNo: string
	cueName: string
	/** Master fader level in percent (0..100), undefined until seen */
	fader: number | undefined
	held: Record<HeldKind, boolean>
	paused: 'yes' | 'no' | 'unknown'
	lastFunction: string
	/** Monotonic counter of the last update, used for eviction */
	touched: number
	/** Time (ms) of the last key event that set running on/off; 0 = never */
	eventAt: number
}

/**
 * A Lua query result is ignored for a sequence whose running state was set by a key event less than
 * this long before the query was sent (or any time after): MA sends the OSC event before its playback
 * engine has activated the sequence, so a query racing an event would report the old state
 * (verified live: a sync triggered by a Go+ reported the sequence as not running).
 */
export const EVENT_GRACE_MS = 1000

export interface StoreOptions {
	/** Treat FaderMaster 0 → >0 as start and → 0 as stop (MA default AutoStart/AutoStop). */
	assumeAutoStartStop: boolean
	/** FaderRange of MA's OSC entry, used to normalise fader values to percent. */
	faderRange: number
	/** Hard cap on tracked sequences (memory bound against garbage input). */
	maxSequences: number
}

export interface ApplyResult {
	key: string
	changed: boolean
	/** True when the fader crossed zero and a Lua check should confirm the real state. */
	crossedZero: boolean
}

/** Functions after which the sequence is running on the cue in the name argument. */
const RUNNING_FUNCTIONS = new Set(['Go+', 'Go-', 'Goto', 'Top', 'On', 'Toggle', 'Kill', '>>>', '<<<'])
const HELD_FUNCTIONS: Record<string, HeldKind> = { Flash: 'flash', Temp: 'temp', Black: 'black', Swap: 'swap' }

/**
 * Lua's CUENAME returns the display name of an unnamed cue (`Cue 2`), while MA's OSC feedback sends
 * just `Cue` for it (explicit names are identical in both, verified live). Normalise to the OSC form
 * so the cue-name variable does not flip depending on which source updated it last.
 */
export function normaliseQueriedCueName(cueNo: string, cueName: string): string {
	return cueName === `Cue ${cueNo}` ? 'Cue' : cueName
}

export function sequenceKey(dataPool: number, sequence: number): string {
	return `${dataPool}.${sequence}`
}

function blank(dataPool: number, sequence: number): SequenceState {
	return {
		dataPool,
		sequence,
		name: '',
		running: 'unknown',
		cueNo: '',
		cueName: '',
		fader: undefined,
		held: { flash: false, temp: false, black: false, swap: false },
		paused: 'unknown',
		lastFunction: '',
		touched: 0,
		eventAt: 0,
	}
}

function snapshot(s: SequenceState): string {
	return JSON.stringify([s.name, s.running, s.cueNo, s.cueName, s.fader, s.held, s.paused])
}

export class SequenceStore {
	readonly #items = new Map<string, SequenceState>()
	#clock = 0
	options: StoreOptions

	constructor(options: StoreOptions) {
		this.options = options
	}

	get size(): number {
		return this.#items.size
	}

	get(dataPool: number, sequence: number): SequenceState | undefined {
		return this.#items.get(sequenceKey(dataPool, sequence))
	}

	getByKey(key: string): SequenceState | undefined {
		return this.#items.get(key)
	}

	values(): IterableIterator<SequenceState> {
		return this.#items.values()
	}

	clear(): void {
		this.#items.clear()
	}

	#obtain(dataPool: number, sequence: number): SequenceState {
		const key = sequenceKey(dataPool, sequence)
		let s = this.#items.get(key)
		if (!s) {
			if (this.#items.size >= this.options.maxSequences) this.#evictOldest()
			s = blank(dataPool, sequence)
			this.#items.set(key, s)
		}
		s.touched = ++this.#clock
		return s
	}

	#evictOldest(): void {
		let oldestKey: string | undefined
		let oldest = Infinity
		for (const [k, v] of this.#items) {
			if (v.touched < oldest) {
				oldest = v.touched
				oldestKey = k
			}
		}
		if (oldestKey !== undefined) this.#items.delete(oldestKey)
	}

	/** Apply a sequence key event. Non-sequence events must be filtered by the caller. */
	applyKey(ev: KeyEvent): ApplyResult | undefined {
		if (!ev.seq) return undefined
		const s = this.#obtain(ev.seq.dataPool, ev.seq.sequence)
		const before = snapshot(s)
		if (ev.seq.name) s.name = ev.seq.name // 2.3 sends no name for Off/Pause/Flash
		s.lastFunction = ev.func

		const held = HELD_FUNCTIONS[ev.func]
		if (held) {
			s.held[held] = ev.state === 1
		} else if (ev.func === 'Off') {
			s.eventAt = Date.now()
			s.running = 'off'
			s.paused = 'no'
			s.cueNo = ''
			s.cueName = ''
			for (const k of HELD_KINDS) s.held[k] = false
		} else if (ev.func === 'Pause') {
			if (s.paused !== 'unknown') s.paused = s.paused === 'yes' ? 'no' : 'yes'
		} else if (RUNNING_FUNCTIONS.has(ev.func)) {
			s.eventAt = Date.now()
			s.running = 'on'
			s.paused = 'no'
			if (ev.seq.cueNo !== undefined) {
				s.cueNo = ev.seq.cueNo
				s.cueName = ev.seq.cueName ?? ''
			}
		}
		return { key: sequenceKey(s.dataPool, s.sequence), changed: snapshot(s) !== before, crossedZero: false }
	}

	/** Apply a sequence fader event. Only FaderMaster drives the level and AutoStart logic. */
	applyFader(ev: FaderEvent): ApplyResult | undefined {
		if (!ev.seq) return undefined
		const s = this.#obtain(ev.seq.dataPool, ev.seq.sequence)
		const before = snapshot(s)
		if (ev.seq.name) s.name = ev.seq.name // encoder moves carry no name
		s.lastFunction = ev.func
		let crossedZero = false

		if (ev.func === 'FaderMaster' && ev.relative) {
			// Rotary encoder step (`,sii`): no absolute level. Turning it up from 0 can AutoStart the
			// sequence, so ask for a check when the level is 0 or unknown.
			crossedZero = ev.value > 0 && (s.fader === undefined || s.fader === 0)
		} else if (ev.func === 'FaderMaster') {
			const range = this.options.faderRange > 0 ? this.options.faderRange : 100
			const level = Math.max(0, Math.min(100, Math.round((ev.value / range) * 1000) / 10))
			const prev = s.fader
			s.fader = level
			const started = level > 0 && prev === 0
			const stopped = level === 0 && prev !== 0
			// Also confirm when we see a fader for a sequence whose state we do not know yet
			crossedZero = started || stopped || (prev === undefined && s.running === 'unknown')
			if (this.options.assumeAutoStartStop) {
				if (started && s.running !== 'on') {
					s.running = 'on'
					s.cueNo = ''
					s.cueName = ''
				} else if (stopped) {
					s.running = 'off'
					s.paused = 'no'
					s.cueNo = ''
					s.cueName = ''
				}
			}
		}
		return { key: sequenceKey(s.dataPool, s.sequence), changed: snapshot(s) !== before, crossedZero }
	}

	/**
	 * Apply an authoritative state read by a Lua query.
	 * Pause and held flags are invisible to Lua and are kept as they are.
	 */
	applyQueried(
		q: {
			dataPool: number
			sequence: number
			exists: boolean
			running: boolean
			cueNo: string
			cueName: string
			name: string
			fader: number | undefined
		},
		/** When the query was sent; fresher key events win over its result */
		sentAt?: number,
	): ApplyResult {
		const key = sequenceKey(q.dataPool, q.sequence)
		const existing = this.#items.get(key)
		if (existing && sentAt !== undefined && existing.eventAt >= sentAt - EVENT_GRACE_MS) {
			if (!q.exists) return { key, changed: false, crossedZero: false }
			const before = snapshot(existing)
			existing.name = q.name || existing.name
			if (q.fader !== undefined && Number.isFinite(q.fader)) existing.fader = Math.max(0, Math.min(100, q.fader))
			return { key, changed: snapshot(existing) !== before, crossedZero: false }
		}
		if (!q.exists) {
			const existed = this.#items.delete(key)
			return { key, changed: existed, crossedZero: false }
		}
		const s = this.#obtain(q.dataPool, q.sequence)
		const before = snapshot(s)
		s.name = q.name
		if (q.running) {
			if (s.running !== 'on') s.paused = 'unknown'
			s.running = 'on'
			s.cueNo = q.cueNo
			s.cueName = normaliseQueriedCueName(q.cueNo, q.cueName)
		} else {
			s.running = 'off'
			s.paused = 'no'
			s.cueNo = ''
			s.cueName = ''
		}
		if (q.fader !== undefined && Number.isFinite(q.fader)) s.fader = Math.max(0, Math.min(100, q.fader))
		return { key, changed: snapshot(s) !== before, crossedZero: false }
	}

	/**
	 * After a complete sync every tracked sequence that was NOT reported as running is off.
	 * @returns keys whose state changed
	 */
	markOthersOff(reportedRunning: ReadonlySet<string>, sentAt?: number): string[] {
		const changed: string[] = []
		for (const [key, s] of this.#items) {
			if (reportedRunning.has(key)) continue
			if (sentAt !== undefined && s.eventAt >= sentAt - EVENT_GRACE_MS) continue
			if (s.running !== 'off') {
				s.running = 'off'
				s.paused = 'no'
				s.cueNo = ''
				s.cueName = ''
				changed.push(key)
			}
		}
		return changed
	}

	/** Mark the last event of a sequence as not authoritative (e.g. an ambiguous 2.3 Toggle). */
	forgetEvent(dataPool: number, sequence: number): void {
		const s = this.#items.get(sequenceKey(dataPool, sequence))
		if (s) s.eventAt = 0
	}

	/** Manual override from the "Set sequence state" action. */
	setManual(dataPool: number, sequence: number, running: Tri, cueNo?: string): ApplyResult {
		const s = this.#obtain(dataPool, sequence)
		const before = snapshot(s)
		s.running = running
		if (running !== 'on') {
			s.cueNo = ''
			s.cueName = ''
		} else if (cueNo !== undefined && cueNo !== '') {
			if (s.cueNo !== cueNo) s.cueName = ''
			s.cueNo = cueNo
		}
		if (running === 'off') s.paused = 'no'
		return { key: sequenceKey(dataPool, sequence), changed: snapshot(s) !== before, crossedZero: false }
	}
}
