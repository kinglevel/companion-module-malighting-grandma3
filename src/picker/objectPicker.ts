/**
 * Unified DataPool → object picker for feedback and action options.
 *
 * Companion cannot filter one dropdown by another, so the picker uses one object dropdown per
 * DataPool, each visible only while that DataPool is selected (`isVisibleExpression`):
 *
 *   DataPool:  [ 125: Show            v ]   ← dropdown of the console's DataPools
 *   Sequence:  [ 212: FR P1           v ]   ← the dropdown belonging to DataPool 125
 *
 * Every dropdown also accepts a typed value (number, name or variable). A plain text field is shown
 * for DataPools the module does not know yet (no Lua catalog, or a typed/variable DataPool); it is
 * also the fallback when the per-DataPool dropdown is left empty, which keeps option values created
 * before the dropdowns existed working.
 *
 * Choices come from the NameCatalog; call the builder again when the catalog changes. Reuse it for
 * any DataPool collection by passing another `kind` (see CATALOG_KINDS).
 */

import type {
	CompanionInputFieldDropdown,
	CompanionInputFieldTextInput,
	CompanionOptionValues,
	DropdownChoice,
} from '@companion-module/base'
import type { CatalogKind, NameCatalog, ResolveResult } from '../ma/catalog.js'

/** What the picker needs to resolve: the catalog plus a resolver that may refresh unknown names. */
export interface PickerResolver {
	readonly catalog: NameCatalog
	resolve(dataPoolRaw: string, objectRaw: string, kind?: CatalogKind): ResolveResult
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

export const SEQUENCE_PICKER: PickerConfig = {
	kind: 'Sequences',
	objectLabel: 'Sequence',
	dataPoolId: 'datapool',
	objectId: 'sequence_number',
	perPoolPrefix: 'seq_dp',
}

/** Limits keep option definitions small for huge shows; typing a value always works. */
const MAX_POOLS_WITH_DROPDOWN = 64
const MAX_CHOICES_PER_POOL = 1000

type PickerField = CompanionInputFieldDropdown | CompanionInputFieldTextInput

function label(no: number, name: string): string {
	return name ? `${no}: ${name}` : String(no)
}

/** Build the picker's option fields from the current catalog. */
export function buildPickerFields(cfg: PickerConfig, catalog: NameCatalog | undefined): PickerField[] {
	const pools = catalog?.listDataPools() ?? []
	const poolChoices: DropdownChoice[] = pools.map((p) => ({ id: String(p.no), label: label(p.no, p.name) }))
	if (!poolChoices.some((c) => c.id === '1')) poolChoices.unshift({ id: '1', label: '1' })

	const withObjects = (catalog?.dataPoolsWith(cfg.kind) ?? []).slice(0, MAX_POOLS_WITH_DROPDOWN)

	const fields: PickerField[] = [
		{
			type: 'dropdown',
			id: cfg.dataPoolId,
			label: 'DataPool',
			choices: poolChoices,
			default: '1',
			allowCustom: true,
			minChoicesForSearch: 8,
			tooltip:
				'Pick a DataPool or type its number or name (variables allowed). "Sequence 5" on the command line means sequence 5 of the operator\'s selected DataPool.',
		},
	]

	for (const dp of withObjects) {
		const choices = catalog!
			.listObjects(cfg.kind, dp)
			.slice(0, MAX_CHOICES_PER_POOL)
			.map((o) => ({ id: String(o.no), label: label(o.no, o.name) }))
		fields.push({
			type: 'dropdown',
			id: `${cfg.perPoolPrefix}${dp}`,
			label: cfg.objectLabel,
			choices,
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
 * Read the picker's raw DataPool and object values (variables parsed), choosing the per-DataPool
 * dropdown of the resolved DataPool when it has a value, else the free-text field.
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

/** Resolve the picker's selection through the catalog. */
export async function resolvePicker(
	cfg: PickerConfig,
	options: CompanionOptionValues,
	resolver: PickerResolver,
	parse: (text: string) => Promise<string>,
): Promise<{ result: ResolveResult; byName: boolean }> {
	const { dataPoolRaw, objectRaw } = await readPicker(cfg, options, resolver.catalog, parse)
	const result = resolver.resolve(dataPoolRaw, objectRaw, cfg.kind)
	const byName = !/^\s*\d+\s*$/.test(objectRaw) || !/^\s*\d*\s*$/.test(dataPoolRaw)
	return { result, byName }
}

/** Option values selecting a specific object (for Learn): sets the dropdown and the text fallback. */
export function pickerValues(cfg: PickerConfig, dataPool: number, no: number): CompanionOptionValues {
	return {
		[cfg.dataPoolId]: String(dataPool),
		[`${cfg.perPoolPrefix}${dataPool}`]: String(no),
		[cfg.objectId]: String(no),
	}
}
