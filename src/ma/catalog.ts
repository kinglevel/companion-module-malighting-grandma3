/**
 * Name catalog: DataPools and the objects inside them, so users can pick or type them by NAME as
 * well as by number. Generic per collection kind (the DataPool child collection's name/class, e.g.
 * `Sequences`), so Groups, Presets, ... can be added later by extending CATALOG_KINDS.
 *
 * Names are resolved inside the module, never sent to grandMA3 (no user text ever reaches a Lua
 * command). Sources:
 *  - the full sync (Lua) reports every DataPool and every object of each catalog kind (`cat`),
 *  - MA's own feedback carries the current sequence name of every operated sequence.
 * Matching is case-insensitive and ignores surrounding whitespace and quotes. An object name is looked
 * up inside the chosen DataPool; if a name exists twice the lowest number wins.
 */

/** DataPool collections listed in the catalog. Order = order in the Lua sync. */
export const CATALOG_KINDS = ['Sequences'] as const
export type CatalogKind = (typeof CATALOG_KINDS)[number]

export interface ResolvedObject {
	dataPool: number
	/** Object number inside its DataPool collection */
	sequence: number
}

export type ResolveResult =
	| { ok: true; ref: ResolvedObject }
	| { ok: false; reason: 'empty' | 'unknown-datapool' | 'unknown-sequence' }

export interface CatalogEntry {
	no: number
	name: string
}

const MAX_ENTRIES = 50_000

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

export function isCatalogKind(kind: string): kind is CatalogKind {
	return (CATALOG_KINDS as readonly string[]).includes(kind)
}

export class NameCatalog {
	/** DataPool number → name */
	readonly #dataPools = new Map<number, string>()
	/** kind → `${dp}.${no}` → name */
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
	setObject(kind: CatalogKind, dataPool: number, no: number, name: string): boolean {
		let map = this.#objects.get(kind)
		if (!map) {
			map = new Map()
			this.#objects.set(kind, map)
		}
		const key = `${dataPool}.${no}`
		if (map.get(key) === name) return false
		if (!map.has(key)) {
			if (this.size >= MAX_ENTRIES) return false
			this.#size++
		}
		map.set(key, name)
		this.#version++
		return true
	}

	removeObject(kind: CatalogKind, dataPool: number, no: number): boolean {
		const removed = this.#objects.get(kind)?.delete(`${dataPool}.${no}`) ?? false
		if (removed) {
			this.#size--
			this.#version++
		}
		return removed
	}

	/** Sequences shortcut (the only kind sent by MA's own feedback) */
	setSequence(dataPool: number, sequence: number, name: string): boolean {
		return this.setObject('Sequences', dataPool, sequence, name)
	}

	removeSequence(dataPool: number, sequence: number): boolean {
		return this.removeObject('Sequences', dataPool, sequence)
	}

	dataPoolName(no: number): string | undefined {
		return this.#dataPools.get(no)
	}

	/** DataPools sorted by number */
	listDataPools(): CatalogEntry[] {
		return [...this.#dataPools].map(([no, name]) => ({ no, name })).sort((a, b) => a.no - b.no)
	}

	/** Objects of a kind inside one DataPool, sorted by number */
	listObjects(kind: CatalogKind, dataPool: number): CatalogEntry[] {
		const prefix = `${dataPool}.`
		const out: CatalogEntry[] = []
		for (const [key, name] of this.#objects.get(kind) ?? []) {
			if (key.startsWith(prefix)) out.push({ no: Number(key.slice(prefix.length)), name })
		}
		return out.sort((a, b) => a.no - b.no)
	}

	/** DataPool numbers that contain at least one object of the kind */
	dataPoolsWith(kind: CatalogKind): number[] {
		const set = new Set<number>()
		for (const key of this.#objects.get(kind)?.keys() ?? []) set.add(Number(key.slice(0, key.indexOf('.'))))
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

	/** Resolve DataPool and object fields that may each be a number or a name. */
	resolveObject(kind: CatalogKind, dataPoolRaw: string, objectRaw: string): ResolveResult {
		if (objectRaw.trim() === '') return { ok: false, reason: 'empty' }
		const dataPool = this.resolveDataPool(dataPoolRaw)
		if (dataPool === undefined) return { ok: false, reason: 'unknown-datapool' }

		const no = parseNumber(objectRaw)
		if (no !== undefined) return { ok: true, ref: { dataPool, sequence: no } }

		const want = normaliseName(objectRaw)
		let best: number | undefined
		const prefix = `${dataPool}.`
		for (const [key, name] of this.#objects.get(kind) ?? []) {
			if (!key.startsWith(prefix) || normaliseName(name) !== want) continue
			const n = Number(key.slice(prefix.length))
			if (best === undefined || n < best) best = n
		}
		if (best === undefined) return { ok: false, reason: 'unknown-sequence' }
		return { ok: true, ref: { dataPool, sequence: best } }
	}

	/** Sequences shortcut */
	resolve(dataPoolRaw: string, sequenceRaw: string): ResolveResult {
		return this.resolveObject('Sequences', dataPoolRaw, sequenceRaw)
	}
}
