import assert from 'node:assert/strict'
import * as Y from 'yjs'

const PERSISTENCE_URL = 'http://localhost:8081'
const COLLAB_URL = 'http://localhost:3000'
const LANGUAGE = 'en'
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `changesreadable-${RUN_ID}`
const DOC_ID = 'doc1'

// Regression test for a real bug caught by testing (see STATE.md, 2026-09-27):
// the first version of "recent changes" fetched the previous checkpoint's
// content and the current changelog as two SEPARATE persistence-service
// calls. A checkpoint landing on the ref between those two round trips
// silently mixed states from two different commits -- every change showed
// as "unchanged" because both calls ended up resolving the same tip. The
// fix bundles both into one persistence-service read
// (DocumentStorageService.loadRecentChanges), resolved off one tip. This
// drives persistence-service's content endpoint directly (not a live
// Hocuspocus session) so the two checkpoints it creates are fully
// deterministic, with no debounce/timing dependency.

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function docWith(text) {
  const doc = new Y.Doc()
  const el = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  el.insert(0, [t])
  doc.getXmlFragment('default').insert(0, [el])
  return doc
}

async function saveContent(versionName, ydocBytes, markdown, changelog, author) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/${versionName}/languages/${LANGUAGE}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ydoc: b64(ydocBytes), markdown, changelog, author }),
    },
  )
  assert.ok(res.ok, `save failed: ${res.status}`)
}

// 1. provision, then a first checkpoint with no changelog (nothing "before" it yet)
await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customerId: CUSTOMER_ID, displayName: 'Changes Readable Test' }),
}).then((r) => assert.ok(r.ok))
await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ docId: DOC_ID, title: 'Doc' }),
}).then((r) => assert.ok(r.ok))

const checkpoint1 = docWith('Hello reviewer.')
await saveContent('master', Y.encodeStateAsUpdate(checkpoint1), 'Hello reviewer.', '', 'User-1')

// 2. a second checkpoint: an edit on top of checkpoint1, with exactly one
// changelog entry (a real per-save delta, same shape onStoreDocument writes)
const checkpoint2 = new Y.Doc()
Y.applyUpdate(checkpoint2, Y.encodeStateAsUpdate(checkpoint1))
const sv1 = Y.encodeStateVector(checkpoint2)
checkpoint2.getXmlFragment('default').get(0).get(0).insert(15, ' Please take a look soon.')
const delta = Y.encodeStateAsUpdate(checkpoint2, sv1)
const changelogLine = JSON.stringify({ author: 'User-2', timestamp: Date.now(), delta: b64(delta) })
await saveContent('master', Y.encodeStateAsUpdate(checkpoint2), 'Hello reviewer. Please take a look soon.', changelogLine, 'User-2')

// 3. the readable, decoded diff must show exactly one change, correctly
// attributed and correctly split into unchanged/added text
const res = await fetch(`${COLLAB_URL}/api/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changes`)
assert.ok(res.ok, `changes endpoint failed: ${res.status}`)
const { changes } = await res.json()

assert.equal(changes.length, 1, `expected exactly one change, got ${JSON.stringify(changes)}`)
assert.equal(changes[0].author, 'User-2')
const added = changes[0].diff.filter((p) => p.type === 'added').map((p) => p.value).join('')
const removed = changes[0].diff.filter((p) => p.type === 'removed').map((p) => p.value).join('')
const unchanged = changes[0].diff.filter((p) => p.type === 'unchanged').map((p) => p.value).join('')
assert.match(unchanged, /Hello reviewer\./)
assert.match(added, /Please take a look soon\./)
assert.equal(removed, '', 'nothing was deleted in this edit')
console.log('readable diff correctly attributes and splits the change:', JSON.stringify(changes[0].diff))

console.log('\nall readable-changes checks passed')
process.exit(0)
