import { describe, expect, it } from 'vitest'
import type { CompanionInputFieldDropdown, CompanionOptionValues } from '@companion-module/base'
import { NameCatalog } from '../ma/catalog.js'
import { buildPickerFields, pickerValues, readPicker, resolvePicker, SEQUENCE_PICKER } from '../picker/objectPicker.js'

function catalog() {
	const c = new NameCatalog()
	c.setDataPool(1, 'Default')
	c.setDataPool(2, 'Stadshuset')
	c.setDataPool(125, 'Show')
	c.setSequence(1, 1, 'Sequence 1')
	c.setSequence(1, 999, 'Companion E2E')
	c.setSequence(125, 212, 'FR P1')
	c.setSequence(125, 76, 'BUMP')
	return c
}
const id = async (t: string) => t
const resolver = (c: NameCatalog) => ({ catalog: c, resolve: c.resolveObject.bind(c, 'Sequences') as never })

describe('DataPool → object picker', () => {
	it('builds a DataPool dropdown and one object dropdown per DataPool', () => {
		const fields = buildPickerFields(SEQUENCE_PICKER, catalog())
		expect(fields.map((f) => f.id)).toEqual(['datapool', 'seq_dp1', 'seq_dp125', 'sequence_number'])
		const dp = fields[0] as CompanionInputFieldDropdown
		expect(dp.choices).toEqual([
			{ id: '1', label: '1: Default' },
			{ id: '2', label: '2: Stadshuset' },
			{ id: '125', label: '125: Show' },
		])
		expect(dp.allowCustom).toBe(true)
		const seq125 = fields[2] as CompanionInputFieldDropdown
		expect(seq125.isVisibleExpression).toBe("$(options:datapool) == '125'")
		expect(seq125.choices).toEqual([
			{ id: '76', label: '76: BUMP' },
			{ id: '212', label: '212: FR P1' },
		])
		// free-text fallback only for DataPools without a dropdown (here: 2, or anything typed)
		expect(fields[3].isVisibleExpression).toBe("$(options:datapool) != '1' && $(options:datapool) != '125'")
	})

	it('still works without a catalog (no Lua): DataPool 1 choice + free text', () => {
		const fields = buildPickerFields(SEQUENCE_PICKER, undefined)
		expect(fields.map((f) => f.id)).toEqual(['datapool', 'sequence_number'])
		expect(fields[1].isVisibleExpression).toBeUndefined()
	})

	it('reads the dropdown of the selected DataPool, falling back to the free-text field', async () => {
		const c = catalog()
		const opts: CompanionOptionValues = { datapool: '125', seq_dp125: '212', seq_dp1: '999', sequence_number: '5' }
		expect(await readPicker(SEQUENCE_PICKER, opts, c, id)).toEqual({ dataPoolRaw: '125', objectRaw: '212' })
		expect(await readPicker(SEQUENCE_PICKER, { ...opts, datapool: '1' }, c, id)).toEqual({
			dataPoolRaw: '1',
			objectRaw: '999',
		})
		// DataPool typed by name selects its dropdown too
		expect((await readPicker(SEQUENCE_PICKER, { ...opts, datapool: 'show' }, c, id)).objectRaw).toBe('212')
		// empty dropdown (e.g. options created before the dropdowns existed) → free text
		expect((await readPicker(SEQUENCE_PICKER, { ...opts, seq_dp125: '' }, c, id)).objectRaw).toBe('5')
		// DataPool without a dropdown → free text
		expect((await readPicker(SEQUENCE_PICKER, { ...opts, datapool: '2' }, c, id)).objectRaw).toBe('5')
	})

	it('resolves typed names in dropdowns and flags name-based selections', async () => {
		const c = catalog()
		const byNum = await resolvePicker(SEQUENCE_PICKER, { datapool: '125', seq_dp125: '212' }, resolver(c), id)
		expect(byNum).toEqual({ result: { ok: true, ref: { dataPool: 125, sequence: 212 } }, byName: false })
		const byName = await resolvePicker(SEQUENCE_PICKER, { datapool: 'Show', seq_dp125: 'bump' }, resolver(c), id)
		expect(byName).toEqual({ result: { ok: true, ref: { dataPool: 125, sequence: 76 } }, byName: true })
	})

	it('Learn values select the dropdown entry and keep the text fallback in sync', () => {
		expect(pickerValues(SEQUENCE_PICKER, 125, 212)).toEqual({
			datapool: '125',
			seq_dp125: '212',
			sequence_number: '212',
		})
	})

	it('variables are parsed in every field', async () => {
		const c = catalog()
		const parse = async (t: string) => t.replace('$(internal:dp)', '125').replace('$(internal:seq)', 'FR P1')
		const r = await resolvePicker(
			SEQUENCE_PICKER,
			{ datapool: '$(internal:dp)', seq_dp125: '$(internal:seq)' },
			resolver(c),
			parse,
		)
		expect(r.result).toEqual({ ok: true, ref: { dataPool: 125, sequence: 212 } })
	})
})
