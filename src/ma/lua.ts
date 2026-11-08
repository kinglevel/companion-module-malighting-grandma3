/**
 * Read-only Lua state queries for grandMA3, sent as `Lua "<code>"` over OSC `/cmd`.
 *
 * Nothing is installed or stored in the show. On connect the module defines a volatile, versioned
 * global table `CompanionQ` in MA's Lua state (it is gone after an MA restart and re-sent whenever
 * a call goes unanswered). Afterwards every query is a short call such as `CompanionQ.sync(8001,17)`,
 * which keeps the lines that appear in the operator's command line short.
 *
 * Rules for every template here (verified live on onPC 2.5.1.1):
 *  - one line, NO double quotes (the code sits inside `Lua "..."`), no backslashes;
 *  - tree navigation by NAME/CLASS (Root().ShowData.DataPools, d.Sequences), objects matched by `.no`,
 *    never by position, so future firmware re-ordering does not break it;
 *  - read only: HasActivePlayback, Get('CUENO'|'CUENAME'), GetFader, Addr, GetClass;
 *  - replies go out with LuaSocket UDP (binary-safe, unlike SendOSC which splits on commas) to the
 *    destination of the OSC entry whose Port equals the module's feedback port. SO_BROADCAST is set so
 *    subnet-broadcast destinations work on every OS; the limited broadcast 255.255.255.255 is refused
 *    by the console's socket ("permission denied", verified) and cannot be used for replies;
 *  - only validated integers are ever interpolated into calls (no user text → no injection).
 */

import { CATALOG_KINDS } from './catalog.js'

export const LUA_API_VERSION = 5

/** Parts are sent as separate `Lua` commands; globals persist between them. */
export const BOOTSTRAP_PARTS: readonly string[] = [
	// Part 1: table, OSC string padding, reply sender bound to the OSC entry that targets `port`
	`CompanionQ={v=${LUA_API_VERSION}} local Q=CompanionQ local Z=string.char(0) ` +
		`function Q.S(x) x=tostring(x)..Z return x..string.rep(Z,(4-#x%4)%4) end ` +
		`function Q.tx(port) local ip for _,e in ipairs(Root().ShowData.OSCBase:Children()) do ` +
		`if e.port==port and e.send then ip=e.destinationip Q.fr=e.faderrange end end ` +
		`if not ip then return nil end local u=require('socket').udp() pcall(function() u:setoption('broadcast',true) end) local o={} ` +
		`function o.m(a,t,...) local v={...} local b={Q.S('/companion/q/'..a),Q.S(','..t)} ` +
		`for i=1,#t do local c=t:sub(i,i) if c=='i' then b[#b+1]=string.pack('>i4',math.tointeger(v[i]) or 0) ` +
		`elseif c=='f' then b[#b+1]=string.pack('>f',tonumber(v[i]) or 0) else b[#b+1]=Q.S(v[i]) end end ` +
		`u:sendto(table.concat(b),ip,port) end function o.close() u:close() end return o end`,
	// Part 2: sequence lookup by DataPool number + sequence number, and one state record
	`local Q=CompanionQ function Q.find(dp,no) for _,d in ipairs(Root().ShowData.DataPools:Children()) do ` +
		`if d.no==dp then for _,s in ipairs(d.Sequences:Children()) do if s.no==no then return s end end end end end ` +
		`function Q.rec(o,req,dp,s,no) if not s then o.m('seq','iiiiisssfi',req,dp,no,0,0,'','','',-1,0) return end ` +
		`local r=s:HasActivePlayback() and 1 or 0 local ok,f=pcall(function() return s:GetFader({}) end) local cr=0 ` +
		`if r==1 then pcall(function() local c=s:CurrentChild() if c then cr=math.tointeger(c.no) or 0 end end) end ` +
		`o.m('seq','iiiiisssfi',req,dp,s.no,1,r,r==1 and tostring(s:Get('CUENO') or '') or '',` +
		`r==1 and tostring(s:Get('CUENAME') or '') or '',tostring(s.name or ''),(ok and tonumber(f)) or -1,cr) end`,
	// Part 3: boot (name→address map + FaderRange) and targeted check
	`local Q=CompanionQ function Q.boot(port,req) local o=Q.tx(port) if not o then return end local n=0 ` +
		`local P=Root().ShowData.DataPools o.m('map','iss',req,'DataPools',P:Addr()) n=n+1 ` +
		`for _,d in ipairs(P:Children()) do for _,c in ipairs(d:Children()) do o.m('map','iss',req,c:GetClass(),c:Addr()) n=n+1 end break end ` +
		`for _,m in ipairs(Root().ShowData.Masters:Children()) do o.m('map','iss',req,m:GetClass(),m:Addr()) n=n+1 end ` +
		`o.m('boot','iif',req,Q.v,tonumber(Q.fr) or 100) o.m('end','isi',req,'boot',n) o.close() end ` +
		`function Q.seqs(port,req,...) local o=Q.tx(port) if not o then return end local a={...} local n=0 ` +
		`for i=1,#a-1,2 do pcall(function() Q.rec(o,req,a[i],Q.find(a[i],a[i+1]),a[i+1]) end) n=n+1 end ` +
		`o.m('end','isi',req,'seqs',n) o.close() end`,
	// Part 4: full sync = name catalog plus a state record for every running sequence. Catalog
	// messages are `cat ,is(iis)*`: request id, kind, then (DataPool, number, name) triples, batched
	// 16 per datagram. Kind `DataPools` lists the pools themselves; the object kinds are the DataPool
	// collections in CATALOG_KINDS, reached by NAME (d[kind]).
	`local Q=CompanionQ function Q.sync(port,req) local o=Q.tx(port) if not o then return end local n,t,Bs=0,0,{} ` +
		`local function fl(k) local b=Bs[k] if b and b.c>0 then o.m('cat','is'..string.rep('iis',b.c),req,k,table.unpack(b.v)) end Bs[k]=nil end ` +
		`local function add(k,dp,no,nm) local b=Bs[k] or {c=0,v={}} Bs[k]=b local v=b.v v[#v+1]=dp v[#v+1]=no v[#v+1]=tostring(nm or '') b.c=b.c+1 if b.c>=16 then fl(k) end end ` +
		`for _,d in ipairs(Root().ShowData.DataPools:Children()) do pcall(function() add('DataPools',d.no,d.no,d.name) ` +
		`for _,k in ipairs({${CATALOG_KINDS.map((k) => `'${k}'`).join(',')}}) do pcall(function() for _,x in ipairs(d[k]:Children()) do add(k,d.no,x.no,x.name) end end) end ` +
		`for _,s in ipairs(d.Sequences:Children()) do t=t+1 ` +
		`local ok,r=pcall(function() return s:HasActivePlayback() end) if ok and r then pcall(Q.rec,o,req,d.no,s,s.no) n=n+1 end end end) end ` +
		`fl('DataPools') for k in pairs(Bs) do fl(k) end o.m('end','isii',req,'sync',n,t) o.close() end`,
	// Part 5: executor check. MA sends no feedback for direct OSC executor input (/PageX/KeyY), so after
	// such a press the module reads the state of the sequence assigned to that executor. Pages live in
	// the operator's selected DataPool (DataPool()); page 0 = the current executor page.
	`local Q=CompanionQ function Q.exec(port,req,pg,ex) local o=Q.tx(port) if not o then return end local n=0 ` +
		`pcall(function() local P if pg==0 then P=CurrentExecPage() else for _,p in ipairs(DataPool().Pages:Children()) do if p.no==pg then P=p end end end ` +
		`if not P then return end for _,e in ipairs(P:Children()) do if e.no==ex then local s=e:GetAssignedObj() ` +
		`if s and s:GetClass()=='Sequence' then Q.rec(o,req,s:Parent():Parent().no,s,s.no) n=1 end end end end) ` +
		`o.m('end','isi',req,'exec',n) o.close() end`,
]

function int(n: number, what: string): string {
	if (!Number.isSafeInteger(n) || n < 0 || n > 0x7fffffff) throw new Error(`invalid ${what}: ${n}`)
	return String(n)
}

/** Wrap Lua code as a command-line command. */
export function luaCommand(code: string): string {
	if (code.includes('"') || code.includes('\\') || /[\r\n]/.test(code)) {
		throw new Error('Lua template must not contain double quotes, backslashes or newlines')
	}
	return `Lua "${code}"`
}

export function bootCall(port: number, req: number): string {
	return luaCommand(`CompanionQ.boot(${int(port, 'port')},${int(req, 'request id')})`)
}

export function syncCall(port: number, req: number): string {
	return luaCommand(`CompanionQ.sync(${int(port, 'port')},${int(req, 'request id')})`)
}

export function execCall(port: number, req: number, page: number, executor: number): string {
	return luaCommand(
		`CompanionQ.exec(${int(port, 'port')},${int(req, 'request id')},${int(page, 'page')},${int(executor, 'executor')})`,
	)
}

export function seqsCall(
	port: number,
	req: number,
	seqs: ReadonlyArray<{ dataPool: number; sequence: number }>,
): string {
	const list = seqs.map((s) => `${int(s.dataPool, 'data pool')},${int(s.sequence, 'sequence')}`).join(',')
	return luaCommand(`CompanionQ.seqs(${int(port, 'port')},${int(req, 'request id')}${list ? ',' + list : ''})`)
}
