/**
 * Object pickers for feedback and action options, built from the console's name catalog.
 *
 * Companion cannot filter one dropdown by another, so an object dropdown is defined per DataPool
 * (and per object type for the multi-type picker), each visible only while its DataPool (and type)
 * is selected (`isVisibleExpression`):
 *
 *   DataPool:     [ 125: Show       v ]   ← the console's DataPools
 *   Object type:  [ Sequence        v ]   ← multi-type picker only
 *   Sequence:     [ 212: FR P1      v ]   ← the dropdown belonging to DataPool 125 + Sequences
 *
 * Every dropdown accepts a typed value too (`allowCustom`: number, name or variable), so the pickers
 * keep working without a catalog (feedback or Lua queries off): the dropdowns are then (nearly) empty
 * and the user types into them. Rebuild the fields when the catalog changes.
 */

import type {
	CompanionInputFieldDropdown,
	CompanionInputFieldTextInput,
	CompanionOptionValues,
	DropdownChoice,
} from '@companion-module/base'
import { isCatalogKind, OBJECT_KINDS, type CatalogKind, type NameCatalog, type ResolveResult } from '../ma/catalog.js'

/** Limits keep option definitions small for huge shows; typing a value always works. */
const MAX_POOLS_WITH_DROPDOWN = 64
const MAX_CHOICES_PER_POOL = 1000

type PickerField = CompanionInputFieldDropdown | CompanionInputFieldTextInput

function label(id: string | number, name: string): string {
	return name ? `${id}: ${name}` : String(id)
}

function dataPoolField(id: string, catalog: NameCatalog | undefined): CompanionInputFieldDropdown {
	const choices: DropdownChoice[] = (catalog?.listDataPools() ?? []).map((p) => ({
		id: String(p.no),
		label: label(p.no, p.name),
	}))
	if (!choices.some((c) => c.id === '1')) choices.unshift({ id: '1', label: '1' })
	return {
		type: 'dropdown',
		id,
		label: 'DataPool',
		choices,
		default: '1',
		allowCustom: true,
		minChoicesForSearch: 8,
		tooltip: 'Pick a DataPool or type its number or name (variables allowed).',
	}
}

function objectChoices(catalog: NameCatalog, kind: CatalogKind, dataPool: number): DropdownChoice[] {
	return catalog
		.listObjects(kind, dataPool)
		.slice(0, MAX_CHOICES_PER_POOL)
		.map((o) => ({ id: o.id, label: label(o.id, o.name) }))
}

// ------------------------------------------------------------------ single-type picker (feedbacks)

/** What the sequence picker needs: the catalog plus a resolver that may refresh unknown names. */
export interface PickerResolver {
	readonly catalog: NameCatalog
	resolve(dataPoolRaw: string, objectRaw: string): ResolveResult
}

export interface PickerConfig {
	kind: CatalogKind
	/** Singular, user-facing: `Sequence` */
	objectLabel: string
	/** Option id of the DataPool dropdown */
	dataPoolId: string
	/** Option id of the free-text object field (fallback, and pre-dropdown option values) */
	objectId: string
	/** Prefix of the per-DataPool dropdown ids: `${prefix}${dataPoolNumber}` */
	perPoolPrefix: string
}

/** The sequence picker used by every feedback. Option ids are stable (saved buttons depend on them). */
export const SEQUENCE_PICKER: PickerConfig = {
	kind: 'Sequences',
	objectLabel: 'Sequence',
	dataPoolId: 'datapool',
	objectId: 'sequence_number',
	perPoolPrefix: 'seq_dp',
}

/** Build the single-type picker's option fields from the current catalog. */
export function buildPickerFields(cfg: PickerConfig, catalog: NameCatalog | undefined): PickerField[] {
	const fields: PickerField[] = [dataPoolField(cfg.dataPoolId, catalog)]
	const withObjects = (catalog?.dataPoolsWith(cfg.kind) ?? []).slice(0, MAX_POOLS_WITH_DROPDOWN)
	for (const dp of withObjects) {
		fields.push({
			type: 'dropdown',
			id: `${cfg.perPoolPrefix}${dp}`,
			label: cfg.objectLabel,
			choices: objectChoices(catalog!, cfg.kind, dp),
			default: '',
			allowCustom: true,
			minChoicesForSearch: 8,
			isVisibleExpression: `$(options:${cfg.dataPoolId}) == '${dp}'`,
			tooltip: `Pick a ${cfg.objectLabel.toLowerCase()} or type its number or name.`,
		})
	}
	fields.push({
		type: 'textinput',
		id: cfg.objectId,
		label: `${cfg.objectLabel} (number or name)`,
		default: '1',
		useVariables: true,
		isVisibleExpression:
			withObjects.length > 0
				? withObjects.map((dp) => `$(options:${cfg.dataPoolId}) != '${dp}'`).join(' && ')
				: undefined,
		tooltip: `A number (5) or the ${cfg.objectLabel.toLowerCase()} name (case-insensitive).`,
	})
	return fields
}

/**
 * Read the single-type picker's raw DataPool and object values (variables parsed), choosing the
 * per-DataPool dropdown of the resolved DataPool when it has a value, else the free-text field.
 */
export async function readPicker(
	cfg: PickerConfig,
	options: CompanionOptionValues,
	catalog: NameCatalog,
	parse: (text: string) => Promise<string>,
): Promise<{ dataPoolRaw: string; objectRaw: string }> {
	const dataPoolRaw = await parse(String(options[cfg.dataPoolId] ?? '1'))
	const dp = catalog.resolveDataPool(dataPoolRaw)
	const perPool = dp === undefined ? undefined : options[`${cfg.perPoolPrefix}${dp}`]
	const fromDropdown = perPool === undefined || perPool === null ? '' : String(perPool).trim()
	const objectRaw = fromDropdown !== '' ? await parse(fromDropdown) : await parse(String(options[cfg.objectId] ?? ''))
	return { dataPoolRaw, objectRaw }
}

/** Resolve the sequence picker's selection through the catalog. */
export async function resolvePicker(
	cfg: PickerConfig,
	options: CompanionOptionValues,
	resolver: PickerResolver,
	parse: (text: string) => Promise<string>,
): Promise<{ result: ResolveResult; byName: boolean }> {
	const { dataPoolRaw, objectRaw } = await readPicker(cfg, options, resolver.catalog, parse)
	const result = resolver.resolve(dataPoolRaw, objectRaw)
	const byName = !/^\s*\d+\s*$/.test(objectRaw) || !/^\s*\d*\s*$/.test(dataPoolRaw)
	return { result, byName }
}

/** Option values selecting a specific sequence (for Learn): sets the dropdown and the text fallback. */
export function pickerValues(cfg: PickerConfig, dataPool: number, no: number): CompanionOptionValues {
	return {
		[cfg.dataPoolId]: String(dataPool),
		[`${cfg.perPoolPrefix}${dataPool}`]: String(no),
		[cfg.objectId]: String(no),
	}
}

// ------------------------------------------------------------------ multi-type picker (Call Object)

/** Option ids of the DataPool → object type → object picker. Stable: saved buttons depend on them. */
export const OBJECT_PICKER = {
	dataPoolId: 'datapool',
	kindId: 'objtype',
	/** Fallback dropdown when the catalog lists no objects for the DataPool + type */
	objectId: 'object',
	/** Per (DataPool, type) dropdown: `obj_dp${dataPool}_${kind}` */
	pairId: (dataPool: number, kind: CatalogKind): string => `obj_dp${dataPool}_${kind}`,
} as const

/**
 * Fields for the multi-type picker, in the order the user picks: DataPool, object type, object.
 * One object dropdown exists per (DataPool, type) pair with catalog entries; a fallback object
 * dropdown without entries (typed values only) is shown for every other combination.
 */
export function buildObjectPickerFields(catalog: NameCatalog | undefined): CompanionInputFieldDropdown[] {
	const P = OBJECT_PICKER
	const fields: CompanionInputFieldDropdown[] = [
		dataPoolField(P.dataPoolId, catalog),
		{
			type: 'dropdown',
			id: P.kindId,
			label: 'Object type',
			choices: OBJECT_KINDS.map((k) => ({ id: k.kind, label: k.label })),
			default: 'Sequences',
		},
	]
	const pairClauses: string[] = []
	for (const k of OBJECT_KINDS) {
		const pools = (catalog?.dataPoolsWith(k.kind) ?? []).slice(0, MAX_POOLS_WITH_DROPDOWN)
		if (pools.length === 0) continue
		for (const dp of pools) {
			fields.push({
				type: 'dropdown',
				id: P.pairId(dp, k.kind),
				label: k.label,
				choices: objectChoices(catalog!, k.kind, dp),
				default: '',
				allowCustom: true,
				minChoicesForSearch: 8,
				isVisibleExpression: `$(options:${P.dataPoolId}) == '${dp}' && $(options:${P.kindId}) == '${k.kind}'`,
				tooltip: `Pick a ${k.label.toLowerCase()} or type its number or name.`,
			})
		}
		pairClauses.push(
			`($(options:${P.kindId}) == '${k.kind}' && (${pools.map((dp) => `$(options:${P.dataPoolId}) == '${dp}'`).join(' || ')}))`,
		)
	}
	fields.push({
		type: 'dropdown',
		id: P.objectId,
		label: 'Object',
		choices: [],
		default: '',
		allowCustom: true,
		isVisibleExpression: pairClauses.length > 0 ? `!(${pairClauses.join(' || ')})` : undefined,
		tooltip:
			'No objects of this type are known in this DataPool (or feedback is off): type the number (5, presets 4.1) or the name.',
	})
	return fields
}

/** Read the multi-type picker: object type, raw DataPool and raw object (variables parsed). */
export async function readObjectPicker(
	options: CompanionOptionValues,
	catalog: NameCatalog | undefined,
	parse: (text: string) => Promise<string>,
): Promise<{ kind: CatalogKind; dataPoolRaw: string; objectRaw: string }> {
	const P = OBJECT_PICKER
	const kindRaw = String(options[P.kindId] ?? 'Sequences')
	const kind: CatalogKind = isCatalogKind(kindRaw) ? kindRaw : 'Sequences'
	const dataPoolRaw = (await parse(String(options[P.dataPoolId] ?? '1'))).trim()
	const dp = catalog?.resolveDataPool(dataPoolRaw) ?? (/^\d+$/.test(dataPoolRaw) ? Number(dataPoolRaw) : undefined)
	const pair = dp === undefined ? undefined : options[P.pairId(dp, kind)]
	const fromPair = pair === undefined || pair === null ? '' : String(pair).trim()
	const objectRaw = (await parse(fromPair !== '' ? fromPair : String(options[P.objectId] ?? ''))).trim()
	return { kind, dataPoolRaw, objectRaw }
}

/** Option values selecting a specific object (for Learn). */
export function objectPickerValues(dataPool: number, kind: CatalogKind, id: string): CompanionOptionValues {
	const P = OBJECT_PICKER
	return {
		[P.dataPoolId]: String(dataPool),
		[P.kindId]: kind,
		[P.pairId(dataPool, kind)]: id,
		[P.objectId]: id,
	}
}
