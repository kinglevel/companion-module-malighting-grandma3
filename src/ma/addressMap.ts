/**
 * Name → numeric address map of the running firmware.
 *
 * MA's feedback addresses are numeric handle paths (`14.14.1.7.12`) whose numbers changed between
 * firmware versions. The module never hardcodes them: at connect a Lua query reports the address of
 * every NAMED collection (`Sequences` → `14.14.1.7`, `MasterPoolGrand` → `14.13.2`, ...). Until that
 * answer arrives (or when Lua queries are unavailable) the 2.5 layout below is used as a fallback.
 * Sequence detection itself never depends on this map (it uses the message shape).
 */

/** grandMA3 2.5.x layout, as reported by the boot query on onPC 2.5.1.1. Fallback only. */
const FALLBACK_2_5: ReadonlyArray<[string, string]> = [
	['DataPools', '14.14'],
	['Worlds', '14.14.1.1'],
	['Filters', '14.14.1.2'],
	['GeneratorTypes', '14.14.1.3'],
	['Shapes', '14.14.1.4'],
	['PresetPools', '14.14.1.5'],
	['Groups', '14.14.1.6'],
	['Sequences', '14.14.1.7'],
	['Plugins', '14.14.1.8'],
	['Macros', '14.14.1.9'],
	['Quickeys', '14.14.1.10'],
	['MAtricks', '14.14.1.11'],
	['Configurations', '14.14.1.12'],
	['Pages', '14.14.1.13'],
	['Layouts', '14.14.1.14'],
	['Timecodes', '14.14.1.15'],
	['Timers', '14.14.1.16'],
	['MasterPoolSelected', '14.13.1'],
	['MasterPoolGrand', '14.13.2'],
	['MasterPoolSpeed', '14.13.3'],
	['MasterPoolPlayback', '14.13.4'],
	['MasterPoolTiming', '14.13.5'],
]

/** Collections that live inside every DataPool: class name → user-facing singular. */
const DATAPOOL_COLLECTIONS: Record<string, string> = {
	Worlds: 'World',
	Filters: 'Filter',
	GeneratorTypes: 'Generator',
	Shapes: 'Shape',
	PresetPools: 'Preset',
	Groups: 'Group',
	Sequences: 'Sequence',
	Plugins: 'Plugin',
	Macros: 'Macro',
	Quickeys: 'Quickey',
	MAtricks: 'MAtricks',
	Configurations: 'Configuration',
	Pages: 'Page',
	Layouts: 'Layout',
	Timecodes: 'Timecode',
	Timers: 'Timer',
}

const MASTER_POOLS: Record<string, string> = {
	MasterPoolSelected: 'Selected',
	MasterPoolGrand: 'Grand',
	MasterPoolSpeed: 'Speed',
	MasterPoolPlayback: 'Playback',
	MasterPoolTiming: 'Timing',
}

function toPath(addr: string): number[] | undefined {
	if (!/^\d+(\.\d+)*$/.test(addr)) return undefined
	return addr.split('.').map(Number)
}

export class AddressMap {
	#dataPools: number[] = []
	/** Slot of a collection inside a DataPool, by class name */
	readonly #collectionSlot = new Map<number, string>()
	readonly #masterPools = new Map<string, string>()
	#fromConsole = false
	/** The Sequences slot was confirmed by the console map or by an observed named sequence message */
	#sequencesConfirmed = false

	constructor() {
		this.update(new Map(FALLBACK_2_5), false)
	}

	/** True once the map came from the console instead of the built-in fallback. */
	get fromConsole(): boolean {
		return this.#fromConsole
	}

	/** Apply a map reported by the boot query. Incomplete answers keep the fallback. */
	update(map: ReadonlyMap<string, string>, fromConsole = true): boolean {
		const dp = toPath(map.get('DataPools') ?? '')
		const seq = toPath(map.get('Sequences') ?? '')
		if (!dp || !seq || seq.length !== dp.length + 2) return false
		this.#dataPools = dp
		this.#collectionSlot.clear()
		this.#masterPools.clear()
		for (const [cls, addr] of map) {
			const path = toPath(addr)
			if (!path) continue
			if (cls in DATAPOOL_COLLECTIONS && path.length === dp.length + 2) {
				this.#collectionSlot.set(path[path.length - 1], cls)
			} else if (cls in MASTER_POOLS) {
				this.#masterPools.set(addr, MASTER_POOLS[cls])
			}
		}
		this.#fromConsole = fromConsole
		this.#sequencesConfirmed = fromConsole
		return true
	}

	/** True when sequence addresses can be trusted (console map, or learned from a named message). */
	get sequencesConfirmed(): boolean {
		return this.#sequencesConfirmed
	}

	/**
	 * A named sequence message (only sequences carry a name) reveals the Sequences slot of this
	 * firmware: 7 on 2.5, 6 on 2.3/2.4. Used when the Lua map is not available.
	 */
	observeSequence(path: readonly number[]): void {
		if (this.#fromConsole) return
		const dp = path.slice(0, path.length - 3)
		const slot = path[path.length - 2]
		if (this.#sequencesConfirmed && this.sequencesSlot() === slot) return
		this.#dataPools = dp
		for (const [s, cls] of this.#collectionSlot) if (cls === 'Sequences' || s === slot) this.#collectionSlot.delete(s)
		this.#collectionSlot.set(slot, 'Sequences')
		this.#sequencesConfirmed = true
	}

	/** DataPool and sequence number of a sequence address, when the layout is confirmed. */
	sequenceAt(path: readonly number[]): { dataPool: number; sequence: number } | undefined {
		if (!this.#sequencesConfirmed) return undefined
		const slot = this.sequencesSlot()
		const dp = this.#dataPools
		if (slot === undefined || path.length !== dp.length + 3) return undefined
		if (!dp.every((v, i) => path[i] === v) || path[dp.length + 1] !== slot) return undefined
		const dataPool = path[dp.length]
		const sequence = path[dp.length + 2]
		return dataPool >= 1 && sequence >= 1 ? { dataPool, sequence } : undefined
	}

	/** Numeric path of ShowData.DataPools, e.g. `[14, 14]`. */
	dataPoolsPath(): readonly number[] {
		return this.#dataPools
	}

	/** Slot of the Sequences collection inside a DataPool (7 on 2.5, 6 on 2.3/2.4). */
	sequencesSlot(): number | undefined {
		for (const [slot, cls] of this.#collectionSlot) if (cls === 'Sequences') return slot
		return undefined
	}

	/** Human readable description of a feedback address, e.g. `Sequence 12 (DataPool 31)`. */
	describe(path: readonly number[]): string {
		const dp = this.#dataPools
		const inDataPools = path.length > dp.length && dp.every((v, i) => path[i] === v)
		if (inDataPools && path.length >= dp.length + 3) {
			const pool = path[dp.length]
			const cls = this.#collectionSlot.get(path[dp.length + 1])
			const rest = path.slice(dp.length + 2).join('.')
			if (cls) return `${DATAPOOL_COLLECTIONS[cls]} ${rest} (DataPool ${pool})`
		}
		for (const [addr, name] of this.#masterPools) {
			const p = toPath(addr)
			if (p && path.length === p.length + 1 && p.every((v, i) => path[i] === v)) {
				return `Master ${name} ${path[path.length - 1]}`
			}
		}
		return path.join('.')
	}
}
