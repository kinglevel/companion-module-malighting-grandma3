/**
 * Minimal OSC 1.0 decoder (and a small encoder used by tests and the query engine).
 *
 * Kept dependency-free and side-effect free so it can be unit tested against captured
 * grandMA3 traffic. Never throws on malformed input: bad packets decode to `[]`.
 */

export type OscArg = number | string | boolean | null | Buffer | bigint

export interface OscMessage {
	address: string
	/** Type tag string without the leading comma, e.g. `sis` */
	types: string
	args: OscArg[]
}

const MAX_BUNDLE_DEPTH = 8

function pad4(n: number): number {
	return (n + 3) & ~3
}

/** Read a NUL-terminated, 4-byte padded OSC string. Returns undefined if malformed. */
function readString(buf: Buffer, offset: number): { value: string; next: number } | undefined {
	const end = buf.indexOf(0, offset)
	if (end < 0) return undefined
	const value = buf.toString('utf8', offset, end)
	const next = pad4(end + 1)
	if (next > buf.length) return undefined
	return { value, next }
}

function decodeMessage(buf: Buffer): OscMessage | undefined {
	const addr = readString(buf, 0)
	if (!addr || !addr.value.startsWith('/')) return undefined
	let offset = addr.next
	// A message without a type tag string is legal in OSC 1.0 (no arguments)
	if (offset >= buf.length) return { address: addr.value, types: '', args: [] }
	const tags = readString(buf, offset)
	if (!tags || !tags.value.startsWith(',')) return undefined
	offset = tags.next
	const types = tags.value.slice(1)
	const args: OscArg[] = []
	for (const t of types) {
		switch (t) {
			case 'i':
				if (offset + 4 > buf.length) return undefined
				args.push(buf.readInt32BE(offset))
				offset += 4
				break
			case 'f':
				if (offset + 4 > buf.length) return undefined
				args.push(buf.readFloatBE(offset))
				offset += 4
				break
			case 'h':
			case 't':
				if (offset + 8 > buf.length) return undefined
				args.push(buf.readBigInt64BE(offset))
				offset += 8
				break
			case 'd':
				if (offset + 8 > buf.length) return undefined
				args.push(buf.readDoubleBE(offset))
				offset += 8
				break
			case 's':
			case 'S': {
				const s = readString(buf, offset)
				if (!s) return undefined
				args.push(s.value)
				offset = s.next
				break
			}
			case 'b': {
				if (offset + 4 > buf.length) return undefined
				const len = buf.readInt32BE(offset)
				offset += 4
				if (len < 0 || offset + len > buf.length) return undefined
				args.push(Buffer.from(buf.subarray(offset, offset + len)))
				offset = pad4(offset + len)
				break
			}
			case 'c':
			case 'r':
			case 'm':
				if (offset + 4 > buf.length) return undefined
				args.push(buf.readUInt32BE(offset))
				offset += 4
				break
			case 'T':
				args.push(true)
				break
			case 'F':
				args.push(false)
				break
			case 'N':
			case 'I':
				args.push(null)
				break
			default:
				// Unknown type tag: we cannot know its size, so the rest is unreadable
				return undefined
		}
	}
	return { address: addr.value, types, args }
}

function decodeAny(buf: Buffer, depth: number, out: OscMessage[]): void {
	if (buf.length < 4) return
	if (buf[0] === 0x23 /* # */) {
		if (depth >= MAX_BUNDLE_DEPTH) return
		const head = readString(buf, 0)
		if (!head || head.value !== '#bundle') return
		let offset = head.next + 8 // skip timetag
		while (offset + 4 <= buf.length) {
			const size = buf.readInt32BE(offset)
			offset += 4
			if (size <= 0 || offset + size > buf.length) return
			decodeAny(buf.subarray(offset, offset + size), depth + 1, out)
			offset += size
		}
		return
	}
	const msg = decodeMessage(buf)
	if (msg) out.push(msg)
}

/**
 * Normalise received bytes to a Buffer. Companion's shared UDP socket delivers datagrams over its
 * EJSON IPC channel, which turns the Buffer into a plain Uint8Array (whose toString ignores the
 * encoding/offset arguments the decoder relies on).
 */
export function toBuffer(data: unknown): Buffer | undefined {
	if (Buffer.isBuffer(data)) return data
	if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
	if (data instanceof ArrayBuffer) return Buffer.from(data)
	if (data && typeof data === 'object') {
		const o = data as { type?: unknown; data?: unknown }
		if (o.type === 'Buffer' && Array.isArray(o.data)) return Buffer.from(o.data as number[])
	}
	return undefined
}

/** Decode one UDP datagram (message or bundle). Malformed input yields `[]`. */
export function decodePacket(data: Buffer | Uint8Array): OscMessage[] {
	const out: OscMessage[] = []
	const buf = toBuffer(data)
	if (!buf) return out
	try {
		decodeAny(buf, 0, out)
	} catch {
		return []
	}
	return out
}

function encodeString(s: string): Buffer {
	const raw = Buffer.from(s + '\0', 'utf8')
	const out = Buffer.alloc(pad4(raw.length))
	raw.copy(out)
	return out
}

/** Encode a message. Supported types: i f s T F N. */
export function encodeMessage(address: string, types: string, args: OscArg[]): Buffer {
	const parts: Buffer[] = [encodeString(address), encodeString(',' + types)]
	let ai = 0
	for (const t of types) {
		if (t === 'T' || t === 'F' || t === 'N') continue
		const v = args[ai++]
		if (t === 'i') {
			const b = Buffer.alloc(4)
			b.writeInt32BE(Number(v))
			parts.push(b)
		} else if (t === 'f') {
			const b = Buffer.alloc(4)
			b.writeFloatBE(Number(v))
			parts.push(b)
		} else if (t === 's') {
			parts.push(encodeString(String(v)))
		} else {
			throw new Error(`encodeMessage: unsupported type ${t}`)
		}
	}
	return Buffer.concat(parts)
}
