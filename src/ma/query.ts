/**
 * Drives the read-only Lua state queries (see lua.ts): bootstrap, full sync, targeted checks.
 *
 * - One request in flight; every request carries an id and replies with another id are dropped.
 * - A request that is not answered within `timeoutMs` makes the engine re-send the bootstrap once
 *   (MA may have restarted and lost the volatile `CompanionQ` table). If the bootstrap is not answered
 *   either, the engine reports `unavailable` and the module falls back to OSC events only.
 * - While unavailable, automatic bootstrap retries back off (retryMs, ×5 each time) and stop after
 *   `maxAutoRetries`, because every query is visible in the operator's command line. If MA executes
 *   the commands but the replies never arrive (firewall, wrong Destination IP), retrying forever would
 *   keep writing long lines into the command line. An explicit resync or config change always retries.
 */

import { BOOTSTRAP_PARTS, bootCall, execCall, luaCommand, seqsCall, syncCall } from './lua.js'
import { sequenceKey } from './sequences.js'
import type { OscArg } from '../osc/codec.js'

export type QueryStatus = 'idle' | 'booting' | 'ready' | 'unavailable'

export interface SeqRecord {
	dataPool: number
	sequence: number
	exists: boolean
	running: boolean
	cueNo: string
	cueName: string
	name: string
	/** Percent, undefined when MA could not read it */
	fader: number | undefined
}

export interface QueryHandlers {
	sendCommand(command: string): void
	onMap(map: ReadonlyMap<string, string>, faderRange: number): void
	/** `sentAt`: when the query was sent (fresher OSC events win over the result) */
	onRecord(rec: SeqRecord, sentAt: number): void
	/** Name catalog entries from a full sync. Kind `DataPools` = the pools themselves (id = DataPool number). */
	onCatalog?(entries: ReadonlyArray<{ kind: string; dataPool: number; id: string; name: string }>): void
	/** A full sync finished: `running` holds the keys of every running sequence in the show */
	onSyncComplete(running: ReadonlySet<string>, sentAt: number): void
	onStatus(status: QueryStatus): void
	log(level: 'debug' | 'info' | 'warn', message: string): void
}

export interface QueryOptions {
	port: number
	timeoutMs: number
	/** Debounce for targeted checks, so several fader moves become one query */
	checkDelayMs: number
	/** Delay before the first automatic bootstrap retry while unavailable (grows ×5 per failure) */
	retryMs: number
	/** Automatic bootstrap retries before giving up until an explicit resync */
	maxAutoRetries: number
	/** Max sequences per targeted check call */
	maxBatch: number
}

type Kind = 'boot' | 'sync' | 'seqs' | 'exec'

interface InFlight {
	id: number
	kind: Kind
	timer: NodeJS.Timeout
	sentAt: number
	map?: Map<string, string>
	faderRange?: number
	running?: Set<string>
}

export class QueryEngine {
	readonly #h: QueryHandlers
	readonly #o: QueryOptions
	#status: QueryStatus = 'idle'
	// Random start: two connections can share the feedback port and see each other's replies,
	// and late replies to a destroyed engine must not match a new engine's first ids
	#nextId = 1 + Math.floor(Math.random() * 0x3fffffff)
	#inFlight: InFlight | undefined
	#wantSync = false
	readonly #pendingChecks = new Map<string, { dataPool: number; sequence: number }>()
	readonly #pendingExecs = new Map<string, { page: number; executor: number }>()
	#checkTimer: NodeJS.Timeout | undefined
	#bootFailures = 0
	/** Consecutive unanswered sync/seqs calls since the last answered one */
	#callFailures = 0
	#lastBootAt = 0
	#destroyed = false

	constructor(handlers: QueryHandlers, options: QueryOptions) {
		this.#h = handlers
		this.#o = options
	}

	get status(): QueryStatus {
		return this.#status
	}

	/** Bootstrap and run a full sync. `force` bypasses the retry back-off (manual resync). */
	start(force = false): void {
		if (this.#destroyed) return
		this.#wantSync = true
		if (this.#status === 'ready') {
			this.#pump()
			return
		}
		if (this.#status === 'unavailable' && !force && !this.#autoRetryDue()) return
		if (this.#inFlight?.kind === 'boot') return
		this.#boot()
	}

	#autoRetryDue(): boolean {
		if (this.#bootFailures > this.#o.maxAutoRetries) return false
		const delay = this.#o.retryMs * 5 ** Math.max(0, this.#bootFailures - 1)
		return Date.now() - this.#lastBootAt >= delay
	}

	/** Queue a targeted state check for one sequence (debounced and batched). */
	check(dataPool: number, sequence: number): void {
		if (this.#destroyed) return
		this.#pendingChecks.set(sequenceKey(dataPool, sequence), { dataPool, sequence })
		this.#armCheckTimer()
	}

	/**
	 * Queue a check of the sequence assigned to an executor (page 0 = current page), used after
	 * Companion pressed an executor key via direct OSC input, which MA does not report.
	 */
	checkExecutor(page: number, executor: number): void {
		if (this.#destroyed || !Number.isInteger(page) || !Number.isInteger(executor) || page < 0 || executor < 1) return
		this.#pendingExecs.set(`${page}.${executor}`, { page, executor })
		this.#armCheckTimer()
	}

	#armCheckTimer(): void {
		if (this.#checkTimer) return
		this.#checkTimer = setTimeout(() => {
			this.#checkTimer = undefined
			if (this.#status === 'unavailable') {
				// Lua not answering: maybe retry (with back-off), otherwise drop the checks
				this.start()
				if (this.#status === 'unavailable') {
					this.#pendingChecks.clear()
					this.#pendingExecs.clear()
				}
				return
			}
			this.#pump()
		}, this.#o.checkDelayMs)
	}

	/** Handle a `/companion/q/<topic>` reply. */
	handleReply(topic: string, args: readonly OscArg[]): void {
		const f = this.#inFlight
		if (!f || args[0] !== f.id) return // stale, foreign (other Companion instance) or malformed
		switch (topic) {
			case 'map':
				if (f.kind === 'boot' && typeof args[1] === 'string' && typeof args[2] === 'string') {
					f.map?.set(args[1], args[2])
				}
				break
			case 'boot':
				if (f.kind === 'boot' && typeof args[2] === 'number' && args[2] > 0) f.faderRange = args[2]
				break
			case 'seq': {
				const rec = parseRecord(args)
				if (!rec) {
					this.#h.log('debug', 'Lua query: malformed seq record dropped')
					break
				}
				if (f.kind === 'sync' && rec.running) f.running?.add(sequenceKey(rec.dataPool, rec.sequence))
				this.#h.onRecord(rec, f.sentAt)
				break
			}
			case 'cat': {
				if (f.kind !== 'sync' || typeof args[1] !== 'string') break
				const kind = args[1]
				const entries: { kind: string; dataPool: number; id: string; name: string }[] = []
				for (let i = 2; i + 2 < args.length; i += 3) {
					const [dp, id, name] = [args[i], args[i + 1], args[i + 2]]
					if (typeof dp !== 'number' || typeof id !== 'string' || typeof name !== 'string') break
					if (!Number.isInteger(dp) || dp < 1 || !/^\d{1,9}(\.\d{1,9})?$/.test(id)) continue
					entries.push({ kind, dataPool: dp, id, name })
				}
				if (entries.length > 0) this.#h.onCatalog?.(entries)
				break
			}
			case 'end':
				this.#complete(f)
				break
			default:
				break
		}
	}

	destroy(): void {
		this.#destroyed = true
		if (this.#inFlight) clearTimeout(this.#inFlight.timer)
		if (this.#checkTimer) clearTimeout(this.#checkTimer)
		this.#inFlight = undefined
		this.#checkTimer = undefined
		this.#pendingChecks.clear()
		this.#pendingExecs.clear()
	}

	#setStatus(s: QueryStatus): void {
		if (this.#status === s) return
		this.#status = s
		this.#h.onStatus(s)
	}

	#id(): number {
		const id = this.#nextId
		this.#nextId = this.#nextId >= 0x7ffffff0 ? 1 : this.#nextId + 1
		return id
	}

	#send(kind: Kind, id: number, command: string, extra: Partial<InFlight> = {}): void {
		// A full sync walks every sequence of every DataPool and sends one datagram per running one
		const timeout = kind === 'sync' ? this.#o.timeoutMs * 3 : this.#o.timeoutMs
		const timer = setTimeout(() => this.#timeout(), timeout)
		this.#inFlight = { id, kind, timer, sentAt: Date.now(), ...extra }
		this.#h.sendCommand(command)
	}

	#boot(): void {
		if (this.#inFlight) clearTimeout(this.#inFlight.timer)
		this.#inFlight = undefined
		this.#lastBootAt = Date.now()
		this.#setStatus('booting')
		for (const part of BOOTSTRAP_PARTS) this.#h.sendCommand(luaCommand(part))
		const id = this.#id()
		this.#send('boot', id, bootCall(this.#o.port, id), { map: new Map(), faderRange: undefined })
	}

	#pump(): void {
		if (this.#inFlight || this.#status !== 'ready' || this.#destroyed) return
		if (this.#wantSync) {
			this.#wantSync = false
			this.#pendingChecks.clear() // a full sync answers every pending check
			const id = this.#id()
			this.#send('sync', id, syncCall(this.#o.port, id), { running: new Set() })
			return
		}
		if (this.#pendingChecks.size > 0) {
			const batch = [...this.#pendingChecks.values()].slice(0, this.#o.maxBatch)
			for (const s of batch) this.#pendingChecks.delete(sequenceKey(s.dataPool, s.sequence))
			const id = this.#id()
			this.#send('seqs', id, seqsCall(this.#o.port, id, batch))
			return
		}
		const next = this.#pendingExecs.entries().next()
		if (!next.done) {
			const [k, e] = next.value
			this.#pendingExecs.delete(k)
			const id = this.#id()
			this.#send('exec', id, execCall(this.#o.port, id, e.page, e.executor))
		}
	}

	#complete(f: InFlight): void {
		clearTimeout(f.timer)
		this.#inFlight = undefined
		if (f.kind === 'boot') {
			this.#bootFailures = 0
			this.#h.onMap(f.map ?? new Map(), f.faderRange ?? 100)
			this.#setStatus('ready')
		} else {
			this.#callFailures = 0
			if (f.kind === 'sync') this.#h.onSyncComplete(f.running ?? new Set(), f.sentAt)
		}
		this.#pump()
	}

	#timeout(): void {
		const f = this.#inFlight
		this.#inFlight = undefined
		if (!f || this.#destroyed) return
		if (f.kind === 'boot') {
			this.#bootFailures++
			this.#h.log('warn', `Lua state query not answered (bootstrap attempt ${this.#bootFailures})`)
			this.#setStatus('unavailable')
			return
		}
		this.#callFailures++
		if (this.#callFailures > 1) {
			// Bootstrap answers but the call does not (e.g. it errors inside MA): stop instead of looping,
			// every attempt writes visible lines into the operator's command line
			this.#h.log('warn', `Lua ${f.kind} query not answered after re-sending the bootstrap; giving up`)
			this.#callFailures = 0
			this.#bootFailures++
			this.#wantSync = false
			this.#pendingChecks.clear()
			this.#pendingExecs.clear()
			this.#setStatus('unavailable')
			return
		}
		// The call was not answered: CompanionQ may be gone (MA restarted). Re-bootstrap once.
		this.#h.log('debug', `Lua ${f.kind} query timed out, re-sending bootstrap`)
		if (f.kind === 'sync') this.#wantSync = true
		this.#boot()
	}
}

/** Cue object numbers are stored ×1000: 1000 → `1`, 4500 → `4.5`, 3 → `0.003`. */
export function formatCueNumber(raw: number): string {
	const whole = Math.trunc(raw / 1000)
	const frac = String(Math.abs(raw % 1000))
		.padStart(3, '0')
		.replace(/0+$/, '')
	return frac ? `${whole}.${frac}` : String(whole)
}

function parseRecord(args: readonly OscArg[]): SeqRecord | undefined {
	const [, dp, no, exists, running, cueNoRaw, cueName, name, fader, cueRaw] = args
	if (
		typeof dp !== 'number' ||
		typeof no !== 'number' ||
		typeof exists !== 'number' ||
		typeof running !== 'number' ||
		typeof cueNoRaw !== 'string' ||
		typeof cueName !== 'string' ||
		typeof name !== 'string' ||
		typeof fader !== 'number'
	) {
		return undefined
	}
	if (!Number.isInteger(dp) || !Number.isInteger(no) || dp < 1 || no < 1) return undefined
	// 2.4 leaves CUENO empty while a sequence runs (verified live on 2.4.2): use the current cue
	// object's number instead (Cue.no is the cue number × 1000)
	const cueNo = cueNoRaw !== '' ? cueNoRaw : typeof cueRaw === 'number' && cueRaw > 0 ? formatCueNumber(cueRaw) : ''
	return {
		dataPool: dp,
		sequence: no,
		exists: exists === 1,
		running: running === 1,
		cueNo,
		cueName,
		name,
		fader: fader >= 0 ? fader : undefined,
	}
}
