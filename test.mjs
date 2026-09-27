// The one runnable check: node test.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, MARKER, SKILLS, TRIGGER, apply } from './index.js'

// Load the browser half the way DSH does: a classic script registering one factory.
let registered
globalThis.window = { __ModuleLoader__: { load: m => { registered = m } } }
await import('./client.js')
assert.equal(registered.id, 'dsh-genoffice-captain')
const { NOTICE, activeSessions, isCaptain, label, inject } = registered.factory(() => ({}))
assert.deepEqual(inject, ['sessions'])

for (const t of ['GenOffice_XLSX_Tasklist', '/GenOfficeXLSXTasklistOrchestration', '/genoffice-xlsx-tasklist', 'genoffice-xlsx-tasklist-orchestration']) assert.ok(TRIGGER.test(t), t)
assert.ok(!TRIGGER.test('open the genoffice app'))
assert.ok(NOTICE.includes(MARKER) && NOTICE.startsWith('/genoffice-xlsx-tasklist-orchestration '))

// Host half against a fake cordis context.
const on = {}, routes = {}, events = []
const ctx = { on: (e, f) => { on[e] = f }, effect: f => f(), logger: console, webServer: { register: r => { routes[r.path] = r.handler; return () => {} } } }
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-gc-'))
apply(ctx, { dshHome })
for (const s of SKILLS) assert.ok(existsSync(join(dshHome, 'skills', s, 'SKILL.md')), s)

const local = { socket: { remoteAddress: '127.0.0.1' }, on() {}, headers: {} }
routes[`${API}/events`](local, { writeHead() {}, write: d => events.push(JSON.parse(d.slice(6))), end() {} })
const agent = { session: { id: 's1', header: { cwd: '/p' } } }
const user = text => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const step = messages => on['agent/pre-step']({ agent, messages }, async () => ({ kind: 'enter', messages }))
await step([user('use /GenOfficeXLSXTasklistOrchestration for this')])
await step([user('hello')])
await step([user(NOTICE)]) // the Captain notice must not reopen the pane
await step([{ source: { kind: 'tool' }, content: [{ type: 'text', text: 'GenOffice_XLSX_Tasklist' }] }])
on['tools/result']({ name: 'skill', arguments: { name: 'genoffice-xlsx-tasklist' }, agent })
on['tools/result']({ name: 'bash', arguments: { command: 'ls GenOffice_XLSX_Tasklist' }, agent })
assert.deepEqual(events.map(e => [e.by, e.sessionId]), [['user', 's1'], ['model', 's1']])

let code
const reply = { writeHead: c => { code = c }, end() {} }
routes[`${API}/launch`]({ ...local, socket: { remoteAddress: '192.0.2.7' }, method: 'POST', headers: { 'x-genoffice-captain': '1' } }, reply)
assert.equal(code, 403)
routes[`${API}/launch`]({ ...local, method: 'POST' }, reply)
assert.equal(code, 400)

// Solo detection: sub-agents, blank and stale sessions do not count.
const now = Date.now()
const row = (id, extra) => ({ id, title: id, displayTitle: id, running: false, blank: false, updatedAt: now - 1000, ...extra })
const byId = { a: row('a', { running: true, updatedAt: now - 9e6 }), b: row('b'), c: row('c', { parentId: 'a' }), d: row('d', { updatedAt: now - 7 * 3600e3 }), e: row('e', { blank: true }) }
assert.deepEqual(activeSessions({ ids: Object.keys(byId), byId }, now).map(s => s.id), ['a', 'b'])
assert.deepEqual(activeSessions({ ids: Object.keys(byId), byId }, now, 'e').map(s => s.id), ['a', 'b', 'e']) // a brand-new session still counts
assert.ok(isCaptain({ title: '\u2B50 Astra' }) && !isCaptain({ title: 'Astra' }))
// The dropdown names sessions, never the working folder DSH puts in displayTitle for untitled sessions.
assert.equal(label({ id: 'session-912f3408-11c2', displayTitle: 'PROJECT(S)', cwd: '/w/PROJECT(S)', running: true, updatedAt: now }, now), '\u25CF Untitled session 912f3408 \u00B7 now')
assert.equal(label({ id: 'x', title: 'continue', displayTitle: 'continue', running: false, updatedAt: now - 2 * 3600e3 }, now), '\u25CB continue \u00B7 2h')
console.log('ok')
