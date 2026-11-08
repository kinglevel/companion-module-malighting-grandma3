/**
 * Name catalog: DataPools and the objects inside them, so users can pick objects from dropdowns or
 * type them by NAME as well as by number. Generic over the DataPool collections in OBJECT_KINDS
 * (Sequences, Groups, Presets, Macros, ...), so the same data serves the sequence feedbacks and the
 * "Call Object" action.
 *
 * Object ids are strings: `212` for most objects, `4.1` (pool.preset) for presets.
 *
 * Names are resolved inside the module, never sent to a Lua query (no user text ever reaches Lua).
 * Sources: the full Lua sync (every DataPool and every object of every kind), and MA's own feedback,
 * which carries the current sequence name of every operated sequence.
 * Matching is case-insensitive and ignores surrounding whitespace and quotes. An object name is looked
 * up inside the chosen DataPool; if a name exists twice the lowest id wins.
 */

export interface ObjectKindInfo {
	/** DataPool child collection, by NAME (also its class): `Sequences` */
	kind: string
	/** Command-line keyword: `Sequence` */
	keyword: string
	/** User-facing singular */
	label: string
	/** Objects live one level deeper (PresetPools → pool → preset); id is `pool.no` */
	nested?: boolean
}

/** Object types in the catalog and the object picker. Every keyword resolved live on onPC 2.4.2. */
export const OBJECT_KINDS = [
	{ kind: 'Sequences', keyword: 'Sequence', label: 'Sequence' },
	{ kind: 'Groups', keyword: 'Group', label: 'Group' },
	{ kind: 'PresetPools', keyword: 'Preset', label: 'Preset', nested: true },
	{ kind: 'Macros', keyword: 'Macro', label: 'Macro' },
	{ kind: 'Plugins', keyword: 'Plugin', label: 'Plugin' },
	{ kind: 'Quickeys', keyword: 'Quickey', label: 'Quickey' },
	{ kind: 'MAtricks', keyword: 'MAtricks', label: 'MAtricks' },
	{ kind: 'Timers', keyword: 'Timer', label: 'Timer' },
	{ kind: 'Worlds', keyword: 'World', label: 'World' },
	{ kind: 'Filters', keyword: 'Filter', label: 'Filter' },
	{ kind: 'Layouts', keyword: 'Layout', label: 'Layout' },
	{ kind: 'Timecodes', keyword: 'Timecode', label: 'Timecode' },
	{ kind: 'Pages', keyword: 'Page', label: 'Page' },
] as const satisfies readonly ObjectKindInfo[]

export type CatalogKind = (typeof OBJECT_KINDS)[number]['kind']
export const CATALOG_KINDS: readonly CatalogKind[] = OBJECT_KINDS.map((k) => k.kind)

export function kindInfo(kind: CatalogKind): ObjectKindInfo {
	return OBJECT_KINDS.find((k) => k.kind === kind)!
}

export function isCatalogKind(kind: string): kind is CatalogKind {
	return OBJECT_KINDS.some((k) => k.kind === kind)
}

export interface ResolvedObject {
	dataPool: number
	/** Object id inside its collection (`212`, or `4.1` for presets) */
	id: string
}

/** Sequences are addressed by number throughout the feedback engine */
export interface ResolvedSequence {
	dataPool: number
	sequence: number
}

type Failure = { ok: false; reason: 'empty' | 'unknown-datapool' | 'unknown-sequence' }
export type ResolveResult = { ok: true; ref: ResolvedSequence } | Failure
export type ResolveObjectResult = { ok: true; ref: ResolvedObject } | Failure

export interface CatalogEntry {
	id: string
	name: string
}

const MAX_ENTRIES = 100_000
const OBJECT_ID = /^\d{1,9}(\.\d{1,9})?$/

export function normaliseName(raw: string): string {
	return raw
		.trim()
		.replace(/^(["'])(.*)\1$/, '$2')
		.trim()
		.toLowerCase()
}

/** A plain positive integer (`5`, `012`), else undefined. */
export function parseNumber(raw: string): number | undefined {
	const t = raw.trim()
	if (!/^\d{1,9}$/.test(t)) return undefined
	const n = Number(t)
	return n >= 1 ? n : undefined
}

/** A numeric object id (`212`, `4.1`), normalised (`012` → `12`), else undefined. */
export function parseObjectId(raw: string): string | undefined {
	const t = raw.trim()
	if (!OBJECT_ID.test(t)) return undefined
	const parts = t.split('.').map((p) => String(Number(p)))
	if (parts.some((p) => p === '0')) return undefined
	return parts.join('.')
}

export function compareIds(a: string, b: string): number {
	const pa = a.split('.').map(Number)
	const pb = b.split('.').map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0)
		if (d !== 0) return d
	}
	return 0
}

export class NameCatalog {
	/** DataPool number → name */
	readonly #dataPools = new Map<number, string>()
	/** kind → `${dp}|${id}` → name */
	readonly #objects = new Map<CatalogKind, Map<string, string>>()
	#size = 0
	#version = 0

	/** Increments whenever a name was added, changed or removed. */
	get version(): number {
		return this.#version
	}

	get size(): number {
		return this.#size + this.#dataPools.size
	}

	/** @returns true when something changed */
	setDataPool(no: number, name: string): boolean {
		if (this.#dataPools.get(no) === name) return false
		if (!this.#dataPools.has(no) && this.size >= MAX_ENTRIES) return false
		this.#dataPools.set(no, name)
		this.#version++
		return true
	}

	/** @returns true when something changed */
	setObject(kind: CatalogKind, dataPool: number, id: string, name: string): boolean {
		let map = this.#objects.get(kind)
		if (!map) {
			map = new Map()
			this.#objects.set(kind, map)
		}
		const key = `${dataPool}|${id}`
		if (map.get(key) === name) return false
		if (!map.has(key)) {
			if (this.size >= MAX_ENTRIES) return false
			this.#size++
		}
		map.set(key, name)
		this.#version++
		return true
	}

	removeObject(kind: CatalogKind, dataPool: number, id: string): boolean {
		const removed = this.#objects.get(kind)?.delete(`${dataPool}|${id}`) ?? false
		if (removed) {
			this.#size--
			this.#version++
		}
		return removed
	}

	/** Sequences shortcut (the only kind sent by MA's own feedback) */
	setSequence(dataPool: number, sequence: number, name: string): boolean {
		return this.setObject('Sequences', dataPool, String(sequence), name)
	}

	removeSequence(dataPool: number, sequence: number): boolean {
		return this.removeObject('Sequences', dataPool, String(sequence))
	}

	dataPoolName(no: number): string | undefined {
		return this.#dataPools.get(no)
	}

	objectName(kind: CatalogKind, dataPool: number, id: string): string | undefined {
		return this.#objects.get(kind)?.get(`${dataPool}|${id}`)
	}

	/** DataPools sorted by number */
	listDataPools(): { no: number; name: string }[] {
		return [...this.#dataPools].map(([no, name]) => ({ no, name })).sort((a, b) => a.no - b.no)
	}

	/** Objects of a kind inside one DataPool, sorted by id */
	listObjects(kind: CatalogKind, dataPool: number): CatalogEntry[] {
		const prefix = `${dataPool}|`
		const out: CatalogEntry[] = []
		for (const [key, name] of this.#objects.get(kind) ?? []) {
			if (key.startsWith(prefix)) out.push({ id: key.slice(prefix.length), name })
		}
		return out.sort((a, b) => compareIds(a.id, b.id))
	}

	/** DataPool numbers that contain at least one object of the kind */
	dataPoolsWith(kind: CatalogKind): number[] {
		const set = new Set<number>()
		for (const key of this.#objects.get(kind)?.keys() ?? []) set.add(Number(key.slice(0, key.indexOf('|'))))
		return [...set].sort((a, b) => a - b)
	}

	/** Resolve a DataPool field that may be a number or a name. Empty = DataPool 1. */
	resolveDataPool(raw: string): number | undefined {
		const n = parseNumber(raw.trim() === '' ? '1' : raw)
		if (n !== undefined) return n
		const want = normaliseName(raw)
		for (const { no, name } of this.listDataPools()) if (normaliseName(name) === want) return no
		return undefined
	}

	/** Resolve DataPool and object fields that may each be a number/id or a name. */
	resolveObject(kind: CatalogKind, dataPoolRaw: string, objectRaw: string): ResolveObjectResult {
		if (objectRaw.trim() === '') return { ok: false, reason: 'empty' }
		const dataPool = this.resolveDataPool(dataPoolRaw)
		if (dataPool === undefined) return { ok: false, reason: 'unknown-datapool' }

		const id = parseObjectId(objectRaw)
		if (id !== undefined) return { ok: true, ref: { dataPool, id } }

		const want = normaliseName(objectRaw)
		let best: string | undefined
		const prefix = `${dataPool}|`
		for (const [key, name] of this.#objects.get(kind) ?? []) {
			if (!key.startsWith(prefix) || normaliseName(name) !== want) continue
			const candidate = key.slice(prefix.length)
			if (best === undefined || compareIds(candidate, best) < 0) best = candidate
		}
		if (best === undefined) return { ok: false, reason: 'unknown-sequence' }
		return { ok: true, ref: { dataPool, id: best } }
	}

	/** Sequences shortcut: resolves to a sequence number */
	resolve(dataPoolRaw: string, sequenceRaw: string): ResolveResult {
		const r = this.resolveObject('Sequences', dataPoolRaw, sequenceRaw)
		if (!r.ok) return r
		const sequence = parseNumber(r.ref.id)
		if (sequence === undefined) return { ok: false, reason: 'unknown-sequence' }
		return { ok: true, ref: { dataPool: r.ref.dataPool, sequence } }
	}
}
