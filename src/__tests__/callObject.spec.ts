import { describe, expect, it } from 'vitest'
import type { CompanionInputFieldDropdown, CompanionOptionValues } from '@companion-module/base'
import { NameCatalog, OBJECT_KINDS, parseObjectId } from '../ma/catalog.js'
import { buildObjectCommand, CALL_FUNCTIONS, FUNCTION_PATTERN } from '../ma/commands.js'
import { BOOTSTRAP_PARTS } from '../ma/lua.js'
import { buildObjectPickerFields, objectPickerValues, OBJECT_PICKER, readObjectPicker } from '../picker/objectPicker.js'

const id = async (t: string) => t

function catalog() {
	const c = new NameCatalog()
	c.setDataPool(1, 'Default')
	c.setDataPool(2, 'Stadshuset')
	c.setDataPool(125, 'Show')
	c.setObject('Sequences', 1, '1', 'Sequence 1')
	c.setObject('Sequences', 125, '212', 'FR P1')
	c.setObject('Groups', 1, '1', 'F230II')
	c.setObject('PresetPools', 1, '4.1', 'White')
	c.setObject('PresetPools', 1, '4.10', 'Red')
	c.setObject('PresetPools', 1, '4.2', 'Blue')
	return c
}

describe('Call Object command', () => {
	it('builds <Function> DataPool <dp> <Keyword> <object> (forms verified live on 2.4.2)', () => {
		expect(buildObjectCommand('Go+', 'Sequences', '125', '212')).toEqual({
			ok: true,
			command: 'Go+ DataPool 125 Sequence 212',
		})
		expect(buildObjectCommand('Go+', 'Sequences', '125', 'FR P1')).toEqual({
			ok: true,
			command: 'Go+ DataPool 125 Sequence "FR P1"',
		})
		expect(buildObjectCommand('Off', 'Sequences', 'Stadshuset', '1')).toEqual({
			ok: true,
			command: 'Off DataPool "Stadshuset" Sequence 1',
		})
		expect(buildObjectCommand('Call', 'PresetPools', '1', '4.1')).toEqual({
			ok: true,
			command: 'Call DataPool 1 Preset 4.1',
		})
		expect(buildObjectCommand('Flash On', 'Groups', '', ' 012 ')).toEqual({
			ok: true,
			command: 'Flash On DataPool 1 Group 12',
		})
	})

	it('uses the right keyword for every object type', () => {
		for (const k of OBJECT_KINDS) {
			const r = buildObjectCommand('Go+', k.kind, '1', '1')
			expect(r).toEqual({ ok: true, command: `Go+ DataPool 1 ${k.keyword} 1` })
		}
	})

	it('rejects input that cannot be expressed safely on the command line', () => {
		expect(buildObjectCommand('Go+', 'Sequences', '1', '')).toMatchObject({ ok: false })
		expect(buildObjectCommand('Go+', 'Sequences', '1', 'say "hi"')).toMatchObject({ ok: false })
		expect(buildObjectCommand('Go+', 'Sequences', '1', 'a\nb')).toMatchObject({ ok: false })
		expect(buildObjectCommand('Go+; Delete Sequence 1', 'Sequences', '1', '1')).toMatchObject({ ok: false })
		expect(buildObjectCommand('Off', 'Sequences', 'x"y', '1')).toMatchObject({ ok: false })
		expect(buildObjectCommand('', 'Sequences', '1', '1')).toMatchObject({ ok: false })
	})

	it('offers command keywords that match the typed-function rule', () => {
		for (const f of CALL_FUNCTIONS) expect(FUNCTION_PATTERN.test(f)).toBe(true)
	})

	it('normalises object ids', () => {
		expect(parseObjectId('4.1')).toBe('4.1')
		expect(parseObjectId('04.01')).toBe('4.1')
		expect(parseObjectId('0')).toBeUndefined()
		expect(parseObjectId('4.')).toBeUndefined()
		expect(parseObjectId('FR P1')).toBeUndefined()
	})
})

describe('DataPool → object type → object picker', () => {
	const P = OBJECT_PICKER

	it('orders the fields DataPool, object type, objects, fallback', () => {
		const fields = buildObjectPickerFields(catalog())
		expect(fields[0].id).toBe('datapool')
		expect(fields[1].id).toBe('objtype')
		expect(fields[1].choices.map((c) => c.id)).toEqual(OBJECT_KINDS.map((k) => k.kind))
		expect(fields.map((f) => f.id)).toEqual([
			'datapool',
			'objtype',
			'obj_dp1_Sequences',
			'obj_dp125_Sequences',
			'obj_dp1_Groups',
			'obj_dp1_PresetPools',
			'object',
		])
	})

	it('shows exactly one object dropdown per (DataPool, type) and the fallback otherwise', () => {
		const fields = buildObjectPickerFields(catalog())
		const byId = (i: string) => fields.find((f) => f.id === i) as CompanionInputFieldDropdown
		expect(byId('obj_dp125_Sequences').isVisibleExpression).toBe(
			"$(options:datapool) == '125' && $(options:objtype) == 'Sequences'",
		)
		expect(byId('obj_dp1_PresetPools').choices).toEqual([
			{ id: '4.1', label: '4.1: White' },
			{ id: '4.2', label: '4.2: Blue' },
			{ id: '4.10', label: '4.10: Red' },
		])
		const fallback = byId('object')
		expect(fallback.choices).toEqual([])
		expect(fallback.allowCustom).toBe(true)
		expect(fallback.isVisibleExpression).toContain("!(($(options:objtype) == 'Sequences' && (")
		// every dropdown accepts typed values
		for (const f of fields.slice(2)) expect(f.allowCustom).toBe(true)
	})

	it('works without a catalog: DataPool 1, all types, a typed object', () => {
		const fields = buildObjectPickerFields(undefined)
		expect(fields.map((f) => f.id)).toEqual(['datapool', 'objtype', 'object'])
		expect(fields[2].isVisibleExpression).toBeUndefined()
	})

	it('reads the dropdown of the selected pair, else the fallback', async () => {
		const c = catalog()
		const opts: CompanionOptionValues = {
			datapool: '125',
			objtype: 'Sequences',
			obj_dp125_Sequences: '212',
			obj_dp1_Sequences: '1',
			object: 'typed',
		}
		expect(await readObjectPicker(opts, c, id)).toEqual({ kind: 'Sequences', dataPoolRaw: '125', objectRaw: '212' })
		expect(await readObjectPicker({ ...opts, datapool: 'show' }, c, id)).toMatchObject({ objectRaw: '212' })
		expect(await readObjectPicker({ ...opts, objtype: 'Groups' }, c, id)).toMatchObject({
			kind: 'Groups',
			objectRaw: 'typed',
		})
		expect(await readObjectPicker({ ...opts, objtype: 'Nope' }, c, id)).toMatchObject({ kind: 'Sequences' })
		// no catalog at all: typed values only
		expect(
			await readObjectPicker({ datapool: 'Stadshuset', objtype: 'Macros', object: 'Reset All' }, undefined, id),
		).toEqual({
			kind: 'Macros',
			dataPoolRaw: 'Stadshuset',
			objectRaw: 'Reset All',
		})
	})

	it('Learn values select the object everywhere it can be read', () => {
		expect(objectPickerValues(125, 'Sequences', '212')).toEqual({
			[P.dataPoolId]: '125',
			[P.kindId]: 'Sequences',
			obj_dp125_Sequences: '212',
			[P.objectId]: '212',
		})
	})
})

describe('Lua catalog template', () => {
	it('lists every object kind by name, presets nested', () => {
		const sync = BOOTSTRAP_PARTS.find((p) => p.includes('function Q.sync'))!
		for (const k of OBJECT_KINDS) expect(sync).toContain(`'${k.kind}'`)
		expect(sync).toContain("p.no..'.'..x.no")
		expect(sync).not.toMatch(/["\\]/)
	})
})
