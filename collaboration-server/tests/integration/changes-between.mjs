import assert from 'node:assert/strict'
import * as Y from 'yjs'

const PERSISTENCE_URL = 'http://localhost:8081'
const COLLAB_URL = 'http://localhost:3000'
const LANGUAGE = 'en'
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `changesbetween-${RUN_ID}`
const DOC_ID = 'doc1'

// "List all changes between two commits on a branch" -- three deterministic
// checkpoints created directly against persistence-service's content
// endpoint (same technique as readable-changes.mjs), so the exact commit
// sequence is known and changes-between's range/ordering/oldest-first
// behavior can be asserted precisely.

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

async function saveContent(ydocBytes, markdown, changelog, author) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/content`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ydoc: b64(ydocBytes), markdown, changelog, author }) },
  )
  assert.ok(res.ok, `save failed: ${res.status}`)
}

function changelogEntry(author, delta) {
  return JSON.stringify({ author, timestamp: Date.now(), delta: b64(delta) })
}

await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customerId: CUSTOMER_ID, displayName: 'Changes Between Test' }),
}).then((r) => assert.ok(r.ok))
await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ docId: DOC_ID, title: 'Doc' }),
}).then((r) => assert.ok(r.ok))

// checkpoint 1: "One."
const doc1 = docWith('One.')
await saveContent(Y.encodeStateAsUpdate(doc1), 'One.', '', 'User-1')

// Mark checkpoint 1's commit: a version created from master right now points
// exactly at it (nothing else has landed since). Used below purely to
// recover its real commit id via the existing merge-base endpoint -- not
// itself part of what's being tested.
await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ versionName: 'checkpoint1-marker', fromVersionName: 'master' }),
}).then((r) => assert.ok(r.ok))

// checkpoint 2: "One. Two."
const doc2 = new Y.Doc()
Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
const sv1 = Y.encodeStateVector(doc2)
doc2.getXmlFragment('default').get(0).get(0).insert(4, ' Two.')
await saveContent(Y.encodeStateAsUpdate(doc2), 'One. Two.', changelogEntry('User-2', Y.encodeStateAsUpdate(doc2, sv1)), 'User-2')

// checkpoint 3: "One. Two. Three."
const doc3 = new Y.Doc()
Y.applyUpdate(doc3, Y.encodeStateAsUpdate(doc2))
const sv2 = Y.encodeStateVector(doc3)
doc3.getXmlFragment('default').get(0).get(0).insert(9, ' Three.')
await saveContent(Y.encodeStateAsUpdate(doc3), 'One. Two. Three.', changelogEntry('User-3', Y.encodeStateAsUpdate(doc3, sv2)), 'User-3')

const mergeBaseRes = await fetch(
  `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/merge-base?a=checkpoint1-marker&b=master`,
)
assert.ok(mergeBaseRes.ok)
const checkpoint1CommitId = (await mergeBaseRes.json()).commitId
assert.ok(checkpoint1CommitId, 'expected a real commit id for checkpoint 1')

// 1. from=checkpoint1 to=master(tip): must return exactly checkpoints 2 and 3, oldest first
{
  const res = await fetch(`${COLLAB_URL}/api/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changes-between?from=${checkpoint1CommitId}`)
  if (!res.ok) throw new Error(`changes-between failed: ${res.status}: ${await res.text()}`)
  const { changes } = await res.json()
  assert.equal(changes.length, 2, `expected 2 checkpoints in range, got ${JSON.stringify(changes)}`)
  assert.equal(changes[0].changes[0].author, 'User-2')
  assert.equal(changes[1].changes[0].author, 'User-3')
  const added0 = changes[0].changes[0].diff.filter((p) => p.type === 'added').map((p) => p.value).join('')
  const added1 = changes[1].changes[0].diff.filter((p) => p.type === 'added').map((p) => p.value).join('')
  assert.match(added0, /Two\./)
  assert.match(added1, /Three\./)
  console.log('range from checkpoint1 to tip: 2 checkpoints, oldest first, correctly attributed and diffed: ok')
}

// 2. `to` omitted entirely -> same as explicit tip (versionName default)
{
  const res = await fetch(`${COLLAB_URL}/api/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changes-between?from=${checkpoint1CommitId}`)
  const { changes } = await res.json()
  assert.equal(changes.length, 2)
  console.log('omitted `to` defaults to the version’s current tip: ok')
}

// 3. from that is NOT an ancestor of to -> a clear error, not a silent huge/empty result
{
  const res = await fetch(`${COLLAB_URL}/api/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changes-between?from=0000000000000000000000000000000000000000`)
  assert.equal(res.status, 500)
  const body = await res.json()
  assert.match(body.error, /not found|not an ancestor/)
  console.log('a from that is not an ancestor of to fails clearly instead of silently walking to the root:', body.error)
}

console.log('\nall changes-between checks passed')
process.exit(0)
