/**
 * Command-line commands built from picker values, for the "Call Object" action.
 *
 *   <Function> DataPool <dp> <Keyword> <object>      e.g.  Go+ DataPool 125 Sequence "FR P1"
 *
 * Verified live on onPC 2.4.2: `DataPool 2 Sequence 1`, `DataPool "Stadshuset" Sequence 1` and
 * `DataPool 1 Sequence "Sequence 1"` all resolve, as do the keywords in OBJECT_KINDS. Numbers (and
 * preset ids like `4.1`) are passed as they are; names are quoted and grandMA3 resolves them itself,
 * so the action works without the module's catalog (feedback off).
 */

import { kindInfo, parseObjectId, type CatalogKind } from './catalog.js'

/** Offered in the function dropdown; a typed function is allowed too (see FUNCTION_PATTERN). */
export const CALL_FUNCTIONS = [
	'Go+',
	'Go-',
	'Top',
	'On',
	'Off',
	'Toggle',
	'Pause',
	'Kill',
	'Flash On',
	'Flash Off',
	'Temp On',
	'Temp Off',
	'Call',
	'Select',
	'Load',
] as const

/** Typed functions: command keywords only (letters, `+`, `-`, spaces), so nothing else can be injected. */
export const FUNCTION_PATTERN = /^[A-Za-z][A-Za-z+\- ]{0,31}$/

export type BuildResult = { ok: true; command: string } | { ok: false; error: string }

/** A DataPool or object token: plain numbers as they are, everything else as a quoted name. */
function token(raw: string, what: string, numeric: (s: string) => string | undefined): BuildResult {
	const t = raw.trim()
	if (t === '') return { ok: false, error: `No ${what} given` }
	const n = numeric(t)
	if (n !== undefined) return { ok: true, command: n }
	if (t.includes('"'))
		return { ok: false, error: `The ${what} name ${t} contains " and cannot be quoted on the command line` }
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(t)) return { ok: false, error: `The ${what} name contains control characters` }
	return { ok: true, command: `"${t}"` }
}

export function buildObjectCommand(fn: string, kind: CatalogKind, dataPoolRaw: string, objectRaw: string): BuildResult {
	const f = fn.trim().replace(/\s+/g, ' ')
	if (!FUNCTION_PATTERN.test(f)) return { ok: false, error: `Invalid function "${fn}" (letters, + and - only)` }
	const dp = token(dataPoolRaw.trim() === '' ? '1' : dataPoolRaw, 'DataPool', (s) =>
		/^\d{1,9}$/.test(s) && Number(s) >= 1 ? String(Number(s)) : undefined,
	)
	if (!dp.ok) return dp
	const obj = token(objectRaw, kindInfo(kind).label.toLowerCase(), parseObjectId)
	if (!obj.ok) return obj
	return { ok: true, command: `${f} DataPool ${dp.command} ${kindInfo(kind).keyword} ${obj.command}` }
}
