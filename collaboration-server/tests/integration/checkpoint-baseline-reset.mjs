import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'

globalThis.WebSocket = WebSocket

// Regression test for a real bug caught by testing (2026-09-30, see
// STATE.md): entry.lastSavedStateVector only tracked the fast tier, never
// reconciled against what git actually just committed, so a changelog
// entry could end up computed relative to a stale baseline -- replaying it
// onto "the previous commit" then produced something that didn't match
// what was actually stored (proven directly against a real historical
// commit before this fix). checkpointToGit now resets it right after every
// successful save. This drives the REAL live-editing path (a genuine
// Hocuspocus session, not a direct content-PUT bypass like
// readable-changes.mjs uses) across two real, separate checkpoints on one
// stable connection, and proves the second checkpoint's changelog replays
// correctly onto the first's content -- exactly the property that was
// broken.

const PERSISTENCE_URL = 'http://localhost:8081'
const WS_URL = 'ws://localhost:1234'
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `baselinereset-${RUN_ID}`
const DOC_ID = 'doc1'
const LANGUAGE = 'en'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(url, body) {
  const res = await fetch(`${PERSISTENCE_URL}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.ok(res.ok, `POST ${url} failed: ${res.status}`)
}

async function fetchContent() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/content`)
  return res.json()
}

async function waitForCheckpoint(previousYdoc, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const content = await fetchContent()
    if (content.ydoc && content.ydoc !== previousYdoc) return content
    await wait(2000)
  }
  throw new Error('timed out waiting for a new git checkpoint')
}

await post('/api/mt/customers', { customerId: CUSTOMER_ID, displayName: 'Baseline Reset Test' })
await post(`/api/mt/customers/${CUSTOMER_ID}/documents`, { docId: DOC_ID, title: 'Doc' })

const ydoc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: WS_URL,
  name: `${CUSTOMER_ID}~${DOC_ID}@master`,
  document: ydoc,
  parameters: { userId: 'User-Alpha' },
})
await new Promise((r) => provider.on('synced', r))

const frag = ydoc.getXmlFragment('default')
const el = new Y.XmlElement('paragraph')
const text = new Y.XmlText()
text.insert(0, 'Alpha')
el.insert(0, [text])
frag.insert(0, [el])

console.log('edit 1 made, waiting for the first real checkpoint...')
const checkpoint1 = await waitForCheckpoint(null)

text.insert(text.length, ' Beta')
console.log('edit 2 made, waiting for the second real checkpoint...')
const checkpoint2 = await waitForCheckpoint(checkpoint1.ydoc)

provider.destroy()

// The actual regression check: replay checkpoint 2's OWN changelog onto
// checkpoint 1's content and confirm it reproduces checkpoint 2's real
// stored state exactly -- byte-for-byte state vector, not just matching
// text. Before the fix, this could fail for exactly the reason found:
// checkpoint 2's delta computed relative to a baseline that wasn't
// actually checkpoint 1.
const changelogRes = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changelog`)
const changelogText = await changelogRes.text()
const entries = changelogText.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
assert.ok(entries.length >= 1, 'expected at least one changelog entry for the second checkpoint')

const replay = new Y.Doc()
Y.applyUpdate(replay, Buffer.from(checkpoint1.ydoc, 'base64'))
for (const entry of entries) Y.applyUpdate(replay, Buffer.from(entry.delta, 'base64'))

const actual = new Y.Doc()
Y.applyUpdate(actual, Buffer.from(checkpoint2.ydoc, 'base64'))

const svReplay = Buffer.from(Y.encodeStateVector(replay))
const svActual = Buffer.from(Y.encodeStateVector(actual))
console.log('replaying checkpoint 2’s changelog onto checkpoint 1 reproduces the real stored state:', svReplay.equals(svActual))
assert.ok(svReplay.equals(svActual), 'checkpoint 2’s changelog must replay onto checkpoint 1 to reproduce the actual stored state exactly')

// Also confirm the readable diff shows only the SECOND edit, not both --
// the actual user-visible symptom of the bug.
const changesRes = await fetch(`http://localhost:3000/api/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changes`)
const { changes } = await changesRes.json()
const added = changes.flatMap((c) => c.diff.filter((p) => p.type === 'added').map((p) => p.value)).join('')
console.log('readable diff for the second checkpoint shows only the new part:', JSON.stringify(added))
assert.match(added, /Beta/)
assert.doesNotMatch(added, /Alpha/, 'the first edit must not reappear as "added" in the second checkpoint’s diff')

console.log('\nall checkpoint-baseline-reset checks passed')
process.exit(0)
