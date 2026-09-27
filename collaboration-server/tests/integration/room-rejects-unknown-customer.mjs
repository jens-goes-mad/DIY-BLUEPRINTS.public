import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'

globalThis.WebSocket = WebSocket

// Regression test for the 2026-09-24 incident (see STATE.md): a live editing
// room whose customer doesn't exist used to be accepted, every git
// checkpoint for it failed forever, and the editors' work piled up in the
// fast tier unsaved. collab-server must refuse such a room up front (close
// code 4401 -- the one code the browser provider treats as permanent) and
// must keep accepting rooms whose customer does exist.

const PERSISTENCE_URL = 'http://localhost:8081'
const WS_URL = 'ws://localhost:1234'
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `roomtest-${RUN_ID}`

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(url, body) {
  const res = await fetch(`${PERSISTENCE_URL}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.ok(res.ok, `POST ${url} failed: ${res.status}`)
}

function open(name) {
  const events = { closes: [], synced: false }
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name,
    document: new Y.Doc(),
    parameters: { userId: 'User-RoomTest' },
    onSynced: () => { events.synced = true },
    onClose: ({ event }) => events.closes.push({ code: event.code, reason: event.reason }),
  })
  return { provider, events }
}

// The provider rejects its own connection attempt promise on a refused
// connection; that is expected here, not a failure.
process.on('unhandledRejection', () => {})

// 1. unknown customer -> refused with 4401 and a readable reason, and NOT retried
const bad = open('mt:nobody~doc1@master')
await wait(4000)
assert.ok(bad.events.closes.length >= 1, 'expected the connection to be closed by the server')
assert.equal(bad.events.closes[0].code, 4401)
assert.match(bad.events.closes[0].reason, /unknown customer "mt:nobody"/)
assert.equal(bad.events.synced, false)
assert.equal(bad.events.closes.length, 1, 'a refused room must not be retried in a loop')
bad.provider.destroy()
console.log('unknown customer refused with 4401, reason:', bad.events.closes[0].reason, '-- not retried: ok')

// 2. legacy-shaped name without any customer separator is refused too
const legacy = open('default@master')
await wait(3000)
assert.equal(legacy.events.closes[0]?.code, 4401)
legacy.provider.destroy()
console.log('legacy "default@master" room refused: ok')

// 3. a real customer's room still connects and syncs
await post('/api/mt/customers', { customerId: CUSTOMER_ID, displayName: 'Room Test Co' })
await post(`/api/mt/customers/${CUSTOMER_ID}/documents`, { docId: 'doc1', title: 'Doc' })
const good = open(`${CUSTOMER_ID}~doc1@master`)
const deadline = Date.now() + 8000
while (!good.events.synced && Date.now() < deadline) await wait(200)
assert.equal(good.events.synced, true, 'a room for an existing customer must sync')
assert.deepEqual(good.events.closes, [])
good.provider.destroy()
console.log('existing customer room syncs normally: ok')

console.log('\nall room-admission checks passed')
process.exit(0)
