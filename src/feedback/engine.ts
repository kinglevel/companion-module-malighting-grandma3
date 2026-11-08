/**
 * Glue between grandMA3's OSC feedback / Lua query replies and Companion feedbacks + variables.
 *
 * Hot path rules: no per-message logging (unless debug is enabled), feedback re-checks only for
 * the feedback instances watching a sequence that actually changed, at most every FLUSH_MS, and
 * variables only sent when their value changed.
 */

import type { CompanionVariableDefinition, CompanionVariableValues } from '@companion-module/base'
import type { OscMessage } from '../osc/codec.js'
import { AddressMap } from '../ma/addressMap.js'
import {
	isCatalogKind,
	NameCatalog,
	type CatalogKind,
	type ResolveObjectResult,
	type ResolveResult,
} from '../ma/catalog.js'
import { decodeMaMessage, splitLegacyName, type FaderEvent, type KeyEvent } from '../ma/messages.js'
import { QueryEngine, type QueryStatus, type SeqRecord } from '../ma/query.js'
import { SequenceStore, sequenceKey, type SequenceState, type Tri } from '../ma/sequences.js'

export interface EngineHost {
	log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
	sendCommand(command: string): void
	checkFeedbacksById(...ids: string[]): void
	setVariableDefinitions(defs: CompanionVariableDefinition[]): void
	setVariableValues(values: CompanionVariableValues): void
	/** Called whenever something that influences the connection status changed */
	statusChanged(): void
	/** The name catalog changed (debounced): rebuild dropdown choices */
	catalogChanged?(): void
}

/** Rebuilding feedback/action definitions is heavier: batch catalog changes */
const CATALOG_NOTIFY_MS = 2000

export interface EngineConfig {
	outputPrefix: string
	luaQueries: boolean
	assumeAutoStart: boolean
	debug: boolean
	feedbackPort: number
}

const FLUSH_MS = 50
const VARIABLE_DEFS_DEBOUNCE_MS = 1000
const MAX_SEQUENCES = 4096
const MAX_SEQUENCE_VARIABLES = 512
/** Unknown names may trigger a catalog refresh (a visible sync in MA) at most this often */
const NAME_REFRESH_MS = 60_000
/** Functions that land on a cue: 2.5 always sends `<Seq>;<Cue> <Name>` for them */
const CUE_LANDING = new Set(['Go+', 'Go-', 'Goto', 'Top', 'On', 'Toggle'])

const STATIC_VARIABLES: CompanionVariableDefinition[] = [
	{ variableId: 'last_function', name: 'Feedback: last function (e.g. Go+)' },
	{ variableId: 'last_object', name: 'Feedback: last object (e.g. Sequence 5 (DataPool 1))' },
	{ variableId: 'last_address', name: 'Feedback: last raw address' },
	{ variableId: 'last_seq', name: 'Feedback: last sequence (DataPool.Sequence)' },
	{ variableId: 'last_seq_name', name: 'Feedback: last sequence name' },
	{ variableId: 'last_cue', name: 'Feedback: last cue number' },
	{ variableId: 'last_cue_name', name: 'Feedback: last cue name' },
	{ variableId: 'feedback_last_rx', name: 'Feedback: seconds since last message from grandMA3' },
	{ variableId: 'lua_query_status', name: 'Feedback: Lua query status (ready/unavailable/...)' },
]

export function seqVarPrefix(dataPool: number, sequence: number): string {
	return `seq_${dataPool}_${sequence}`
}

/** Feedback instance id ↔ watched sequence key (rebuilt from feedback callbacks). */
export class WatchRegistry {
	readonly #byId = new Map<string, string>()
	readonly #byKey = new Map<string, Set<string>>()
	/** Feedbacks that address their sequence or DataPool by name (or are still unresolved) */
	readonly #byName = new Set<string>()

	/** @param byName the feedback uses a name, so it must re-run when names change */
	set(id: string, key: string, byName = false): void {
		if (byName) this.#byName.add(id)
		else this.#byName.delete(id)
		const prev = this.#byId.get(id)
		if (prev === key) return
		if (prev !== undefined) this.remove(id)
		this.#byId.set(id, key)
		let set = this.#byKey.get(key)
		if (!set) {
			set = new Set()
			this.#byKey.set(key, set)
		}
		set.add(id)
	}

	remove(id: string): void {
		this.#byName.delete(id)
		const key = this.#byId.get(id)
		if (key === undefined) return
		this.#byId.delete(id)
		const set = this.#byKey.get(key)
		set?.delete(id)
		if (set && set.size === 0) this.#byKey.delete(key)
	}

	idsFor(key: string): ReadonlySet<string> | undefined {
		return this.#byKey.get(key)
	}

	allIds(): string[] {
		return [...this.#byId.keys()]
	}

	namedIds(): string[] {
		return [...this.#byName]
	}

	/** Sequence keys watched by at least one feedback */
	keys(): string[] {
		return [...this.#byKey.keys()]
	}

	clear(): void {
		this.#byId.clear()
		this.#byKey.clear()
		this.#byName.clear()
	}
}

export class FeedbackEngine {
	readonly #host: EngineHost
	#cfg: EngineConfig
	readonly store: SequenceStore
	readonly addressMap = new AddressMap()
	readonly catalog = new NameCatalog()
	readonly watches = new WatchRegistry()
	#lastNameRefresh = 0
	/** grandMA3 2.3 names: `<Seq> <CueNo> <CueName>` without `;` (detected from the first cue event) */
	#legacyNames = false
	#query: QueryEngine | undefined

	readonly #dirty = new Set<string>()
	#dirtyAll = false
	#dirtyNamed = false
	#catalogTimer: NodeJS.Timeout | undefined
	#flushTimer: NodeJS.Timeout | undefined
	#lastFlush = 0

	readonly #sentValues = new Map<string, string>()
	#definedSeqKeys = new Set<string>()
	#defsTimer: NodeJS.Timeout | undefined
	#lastRxAt = 0
	#rxTicker: NodeJS.Timeout | undefined
	#lastEvent: { func: string; object: string; address: string } | undefined
	/** Most recent sequence MA reported, used by the Learn buttons */
	lastSequence: { dataPool: number; sequence: number; cueNo: string } | undefined
	#everReceived = false
	#destroyed = false

	constructor(host: EngineHost, cfg: EngineConfig) {
		this.#host = host
		this.#cfg = cfg
		this.store = new SequenceStore({
			assumeAutoStartStop: cfg.assumeAutoStart,
			faderRange: 100,
			maxSequences: MAX_SEQUENCES,
		})
		this.#publishDefinitions()
		this.#rxTicker = setInterval(() => this.#tickRx(), 1000)
	}

	get everReceived(): boolean {
		return this.#everReceived
	}

	get queryStatus(): QueryStatus | 'disabled' {
		return this.#query ? this.#query.status : 'disabled'
	}

	/** Start (or restart) the Lua query engine; call once the listener is bound. */
	startQueries(): void {
		this.#query?.destroy()
		this.#query = undefined
		if (!this.#cfg.luaQueries || this.#destroyed) {
			this.#host.statusChanged()
			return
		}
		this.#query = new QueryEngine(
			{
				sendCommand: (c) => this.#host.sendCommand(c),
				onMap: (map, faderRange) => this.#onMap(map, faderRange),
				onRecord: (rec, sentAt) => this.#onRecord(rec, sentAt),
				onCatalog: (entries) => {
					let changed = false
					for (const e of entries) {
						if (e.kind === 'DataPools') changed = this.catalog.setDataPool(e.dataPool, e.name) || changed
						else if (isCatalogKind(e.kind))
							changed = this.catalog.setObject(e.kind, e.dataPool, e.id, e.name) || changed
					}
					if (changed) this.#recheckNamed()
				},
				onSyncComplete: (running, sentAt) => this.#onSyncComplete(running, sentAt),
				onStatus: (s) => {
					this.#setVar('lua_query_status', s)
					this.#host.statusChanged()
				},
				log: (level, msg) => this.#host.log(level, msg),
			},
			{
				port: this.#cfg.feedbackPort,
				timeoutMs: 2000,
				checkDelayMs: 300,
				retryMs: 60_000,
				maxAutoRetries: 3,
				maxBatch: 32,
			},
		)
		this.#setVar('lua_query_status', this.#query.status)
		this.#query.start(true)
	}

	/** Manual resync (action). */
	resync(): void {
		if (this.#query) this.#query.start(true)
		else this.startQueries()
	}

	/** Process the messages of one received datagram. */
	handleMessages(msgs: readonly OscMessage[]): void {
		if (this.#destroyed) return
		for (const msg of msgs) {
			let res
			try {
				res = decodeMaMessage(msg, this.#cfg.outputPrefix)
			} catch (e) {
				this.#host.log('debug', `Feedback decode failed: ${e instanceof Error ? e.message : String(e)}`)
				continue
			}
			if (!res.ok) {
				if (this.#cfg.debug) this.#host.log('debug', `Feedback dropped (${res.reason}): ${msg.address} ,${msg.types}`)
				continue
			}
			this.#markReceived()
			const ev = res.event
			if (ev.kind === 'reply') {
				this.#query?.handleReply(ev.topic, ev.args)
				continue
			}
			if (this.#cfg.debug) {
				this.#host.log('debug', `Feedback: ${msg.address} ,${msg.types} ${JSON.stringify(msg.args)}`)
			}
			this.#onObjectEvent(ev)
		}
		if (this.#query?.status === 'unavailable') this.#query.start() // respects the retry back-off
	}

	/**
	 * Companion pressed an executor key with direct OSC input (`/PageX/KeyY`), which MA does not report:
	 * read the state of the sequence on that executor (page 0 = current page).
	 */
	checkExecutor(page: number, executor: number): void {
		if (this.#query && this.#query.status !== 'unavailable') this.#query.checkExecutor(page, executor)
	}

	/** "Set sequence state" action. */
	setManual(dataPool: number, sequence: number, running: Tri, cueNo?: string): void {
		const r = this.store.setManual(dataPool, sequence, running, cueNo)
		this.#ensureDefined(r.key)
		if (r.changed) this.#markDirty(r.key)
	}

	/**
	 * Resolve user input (numbers or names) to a sequence. An unknown name asks for a catalog refresh
	 * (rate limited, because it is a visible command in MA); feedbacks re-run when names change.
	 */
	resolve(dataPoolRaw: string, sequenceRaw: string): ResolveResult {
		const r = this.catalog.resolve(dataPoolRaw, sequenceRaw)
		if (!r.ok) this.#maybeRefreshNames(r.reason)
		return r
	}

	/** Same as resolve() for any object type in the catalog (Groups, Presets, ...). */
	resolveObject(kind: CatalogKind, dataPoolRaw: string, objectRaw: string): ResolveObjectResult {
		const r = this.catalog.resolveObject(kind, dataPoolRaw, objectRaw)
		if (!r.ok) this.#maybeRefreshNames(r.reason)
		return r
	}

	#maybeRefreshNames(reason: string): void {
		if (reason === 'empty' || this.#query?.status !== 'ready') return
		const now = Date.now()
		if (now - this.#lastNameRefresh < NAME_REFRESH_MS) return
		this.#lastNameRefresh = now
		this.#host.log('debug', `Unknown name (${reason}): refreshing the name catalog`)
		this.#query.start()
	}

	getSequence(dataPool: number, sequence: number): SequenceState | undefined {
		return this.store.get(dataPool, sequence)
	}

	destroy(): void {
		this.#destroyed = true
		this.#query?.destroy()
		if (this.#flushTimer) clearTimeout(this.#flushTimer)
		if (this.#defsTimer) clearTimeout(this.#defsTimer)
		if (this.#catalogTimer) clearTimeout(this.#catalogTimer)
		if (this.#rxTicker) clearInterval(this.#rxTicker)
		this.watches.clear()
	}

	// ---------------------------------------------------------------- events

	#onObjectEvent(ev: KeyEvent | FaderEvent): void {
		if (ev.seq) this.addressMap.observeSequence(ev.path)
		else ev = this.#attributeByAddress(ev)
		let learnName = true
		if (ev.seq && ev.seq.cueNo === undefined && ev.seq.name) {
			// 2.5 always separates the cue with ';' for these functions; its absence means the 2.3 dialect
			if (CUE_LANDING.has(ev.func)) this.#legacyNames = true
			if (this.#legacyNames && ev.seq.name.includes(' ')) {
				const known =
					this.catalog.objectName('Sequences', ev.seq.dataPool, String(ev.seq.sequence)) ??
					this.store.get(ev.seq.dataPool, ev.seq.sequence)?.name
				const split = splitLegacyName(ev.seq.name, known)
				learnName = split.confident
				ev = { ...ev, seq: { ...ev.seq, name: split.name, cueNo: split.cueNo, cueName: split.cueName } }
			}
		}
		this.#lastEvent = { func: ev.func, object: this.#describe(ev), address: ev.address }
		if (!ev.seq) {
			this.#markDirty(undefined)
			return
		}
		const r = ev.kind === 'key' ? this.store.applyKey(ev) : this.store.applyFader(ev)
		if (!r) return
		// MA reports the current sequence name with every event: keeps renames resolvable
		if (learnName && ev.seq.name && this.catalog.setSequence(ev.seq.dataPool, ev.seq.sequence, ev.seq.name))
			this.#recheckNamed()
		// 2.3 sends `Toggle` both when switching on and off (no following Off): ask the console
		if (this.#legacyNames && ev.func === 'Toggle' && this.#query && this.#query.status !== 'unavailable') {
			this.store.forgetEvent(ev.seq.dataPool, ev.seq.sequence)
			this.#query.check(ev.seq.dataPool, ev.seq.sequence)
		}
		const s = this.store.get(ev.seq.dataPool, ev.seq.sequence)
		this.lastSequence = { dataPool: ev.seq.dataPool, sequence: ev.seq.sequence, cueNo: s?.cueNo ?? '' }
		this.#ensureDefined(r.key)
		if (r.crossedZero && this.#query && this.#query.status !== 'unavailable') {
			this.#query.check(ev.seq.dataPool, ev.seq.sequence)
		}
		this.#markDirty(r.changed ? r.key : undefined)
	}

	/**
	 * Messages without a sequence name: rotary encoders (`,sii`) on every firmware, and on 2.3 also
	 * Off / Pause / Flash and all fader messages. Use the address map (console-reported or learned from
	 * a named message): `<DataPools>.<dp>.<Sequences slot>.<no>`.
	 */
	#attributeByAddress<T extends KeyEvent | FaderEvent>(ev: T): T {
		const at = this.addressMap.sequenceAt(ev.path)
		return at ? { ...ev, seq: { ...at, name: '' } } : ev
	}

	#describe(ev: KeyEvent | FaderEvent): string {
		if (ev.seq) return `Sequence ${ev.seq.sequence} (DataPool ${ev.seq.dataPool})`
		return this.addressMap.describe(ev.path)
	}

	#onMap(map: ReadonlyMap<string, string>, faderRange: number): void {
		if (!this.addressMap.update(map)) this.#host.log('debug', 'Lua address map incomplete, keeping built-in map')
		this.store.options.faderRange = faderRange
	}

	#onRecord(rec: SeqRecord, sentAt: number): void {
		const r = this.store.applyQueried(rec, sentAt)
		if (rec.exists) {
			if (rec.name && this.catalog.setSequence(rec.dataPool, rec.sequence, rec.name)) this.#recheckNamed()
		} else if (this.catalog.removeSequence(rec.dataPool, rec.sequence)) {
			this.#recheckNamed()
		}
		if (rec.exists) this.#ensureDefined(r.key)
		else if (r.changed) this.#scheduleDefinitions() // sequence was deleted in MA: drop its variables
		if (r.changed) this.#markDirty(r.key)
	}

	#onSyncComplete(running: ReadonlySet<string>, sentAt: number): void {
		// A full sync is authoritative for "not running": that includes watched sequences the module
		// has never seen an event for (otherwise they would stay "unknown" until first operated)
		for (const key of this.watches.keys()) {
			if (running.has(key) || this.store.getByKey(key)) continue
			const [dp, no] = key.split('.').map(Number)
			this.store.setManual(dp, no, 'off')
			this.#ensureDefined(key)
		}
		for (const key of this.store.markOthersOff(running, sentAt)) this.#markDirty(key)
		this.#host.log('debug', `Lua sync complete: ${running.size} running sequence(s)`)
	}

	#markReceived(): void {
		this.#lastRxAt = Date.now()
		if (!this.#everReceived) {
			this.#everReceived = true
			this.#host.statusChanged()
		}
	}

	#tickRx(): void {
		if (!this.#lastRxAt) return
		this.#setVar('feedback_last_rx', String(Math.floor((Date.now() - this.#lastRxAt) / 1000)))
	}

	// ---------------------------------------------------------------- flush

	#markDirty(key: string | undefined): void {
		if (key !== undefined) this.#dirty.add(key)
		if (this.#flushTimer || this.#destroyed) return
		const wait = Math.max(0, FLUSH_MS - (Date.now() - this.#lastFlush))
		this.#flushTimer = setTimeout(() => this.#flush(), wait)
	}

	/** Re-check every placed feedback (e.g. after options changed in bulk). */
	recheckAll(): void {
		this.#dirtyAll = true
		this.#markDirty(undefined)
	}

	/** Names changed: re-run only feedbacks that use names (number-addressed ones cannot be affected). */
	#recheckNamed(): void {
		this.#dirtyNamed = true
		this.#markDirty(undefined)
		if (this.#catalogTimer || this.#destroyed) return
		this.#catalogTimer = setTimeout(() => {
			this.#catalogTimer = undefined
			this.#host.catalogChanged?.()
		}, CATALOG_NOTIFY_MS)
	}

	#flush(): void {
		this.#flushTimer = undefined
		this.#lastFlush = Date.now()
		const ids = new Set<string>()
		if (this.#dirtyAll) {
			for (const id of this.watches.allIds()) ids.add(id)
			this.#dirtyAll = false
		}
		if (this.#dirtyNamed) {
			for (const id of this.watches.namedIds()) ids.add(id)
			this.#dirtyNamed = false
		}
		const values: CompanionVariableValues = {}
		for (const key of this.#dirty) {
			for (const id of this.watches.idsFor(key) ?? []) ids.add(id)
			const [dp, no] = key.split('.').map(Number)
			const s = this.store.get(dp, no)
			if (this.#definedSeqKeys.has(key)) this.#collectSeqValues(values, dp, no, s)
		}
		this.#dirty.clear()
		if (this.#lastEvent) {
			this.#collect(values, 'last_function', this.#lastEvent.func)
			this.#collect(values, 'last_object', this.#lastEvent.object)
			this.#collect(values, 'last_address', this.#lastEvent.address)
		}
		const last = this.lastSequence
		if (last) {
			const s = this.store.get(last.dataPool, last.sequence)
			this.#collect(values, 'last_seq', sequenceKey(last.dataPool, last.sequence))
			this.#collect(values, 'last_seq_name', s?.name ?? '')
			this.#collect(values, 'last_cue', s?.cueNo ?? '')
			this.#collect(values, 'last_cue_name', s?.cueName ?? '')
		}
		if (Object.keys(values).length > 0) this.#host.setVariableValues(values)
		if (ids.size > 0) this.#host.checkFeedbacksById(...ids)
	}

	#collectSeqValues(values: CompanionVariableValues, dp: number, no: number, s: SequenceState | undefined): void {
		const p = seqVarPrefix(dp, no)
		this.#collect(values, `${p}_running`, s?.running ?? 'unknown')
		this.#collect(values, `${p}_cue`, s?.cueNo ?? '')
		this.#collect(values, `${p}_cue_name`, s?.cueName ?? '')
		this.#collect(values, `${p}_name`, s?.name ?? '')
		this.#collect(values, `${p}_fader`, s?.fader === undefined ? '' : String(s.fader))
	}

	#collect(values: CompanionVariableValues, id: string, value: string): void {
		if (this.#sentValues.get(id) === value) return
		this.#sentValues.set(id, value)
		values[id] = value
	}

	#setVar(id: string, value: string): void {
		const values: CompanionVariableValues = {}
		this.#collect(values, id, value)
		if (Object.keys(values).length > 0) this.#host.setVariableValues(values)
	}

	// ---------------------------------------------------------------- variable definitions

	#ensureDefined(key: string): void {
		if (this.#definedSeqKeys.has(key)) return
		this.#scheduleDefinitions()
	}

	#scheduleDefinitions(): void {
		if (this.#defsTimer || this.#destroyed) return
		this.#defsTimer = setTimeout(() => {
			this.#defsTimer = undefined
			this.#publishDefinitions()
		}, VARIABLE_DEFS_DEBOUNCE_MS)
	}

	#publishDefinitions(): void {
		// Most recently touched sequences first, capped
		const seqs = [...this.store.values()].sort((a, b) => b.touched - a.touched).slice(0, MAX_SEQUENCE_VARIABLES)
		const next = new Set(seqs.map((s) => sequenceKey(s.dataPool, s.sequence)))
		const defs: CompanionVariableDefinition[] = [...STATIC_VARIABLES]
		for (const s of seqs.sort((a, b) => a.dataPool - b.dataPool || a.sequence - b.sequence)) {
			const p = seqVarPrefix(s.dataPool, s.sequence)
			const label = `Seq ${s.sequence}${s.dataPool === 1 ? '' : ` (DP ${s.dataPool})`}`
			defs.push(
				{ variableId: `${p}_running`, name: `${label}: running (on/off/unknown)` },
				{ variableId: `${p}_cue`, name: `${label}: cue number` },
				{ variableId: `${p}_cue_name`, name: `${label}: cue name` },
				{ variableId: `${p}_name`, name: `${label}: sequence name` },
				{ variableId: `${p}_fader`, name: `${label}: master fader %` },
			)
		}
		this.#host.setVariableDefinitions(defs)
		// Values of ids that disappeared are deleted by Companion; forget them so they are re-sent later
		for (const key of this.#definedSeqKeys) {
			if (next.has(key)) continue
			const [dp, no] = key.split('.').map(Number)
			const p = seqVarPrefix(dp, no)
			for (const suffix of ['_running', '_cue', '_cue_name', '_name', '_fader']) this.#sentValues.delete(p + suffix)
		}
		const added = [...next].filter((k) => !this.#definedSeqKeys.has(k))
		this.#definedSeqKeys = next
		for (const key of added) this.#dirty.add(key)
		this.#markDirty(undefined)
	}
}
