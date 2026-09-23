import * as Y from 'yjs'

const PERSISTENCE_URL = 'http://localhost:8081'
const COLLAB_URL = 'http://localhost:3000'
const LANGUAGE = 'en'
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `mergeconflict-${RUN_ID}`

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function createCustomer() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: CUSTOMER_ID, displayName: 'Merge Conflict Test Co' }),
  })
  if (!res.ok) throw new Error(`createCustomer failed: ${res.status}`)
}

async function createDocument(docId) {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId, title: docId }),
  })
  if (!res.ok) throw new Error(`createDocument failed: ${res.status}`)
}

async function save(docId, versionName, ydoc, markdown, author) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${docId}/versions/${versionName}/languages/${LANGUAGE}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ydoc: b64(Y.encodeStateAsUpdate(ydoc)), markdown, changelog: '', author }),
    },
  )
  if (!res.ok) throw new Error(`save failed: ${res.status}`)
}

async function createVersion(docId, versionName, fromVersionName) {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${docId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionName, fromVersionName }),
  })
  if (!res.ok) throw new Error(`createVersion failed: ${res.status}`)
}

async function branchTip(docId, versionName) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${docId}/versions/${versionName}/languages/${LANGUAGE}/content`,
  )
  return res.json()
}

async function mergeViaCollabServer(docId, sourceVersionName, targetVersionName, author) {
  const res = await fetch(`${COLLAB_URL}/api/customers/${CUSTOMER_ID}/documents/${docId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceVersionName, targetVersionName, language: LANGUAGE, author }),
  })
  return { status: res.status, body: await res.json() }
}

function makeDoc(text, attrs = {}) {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const el = new Y.XmlElement('paragraph')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  const t = new Y.XmlText()
  t.insert(0, text)
  el.insert(0, [t])
  frag.insert(0, [el])
  return doc
}

async function testCleanMerge() {
  console.log('=== CLEAN MERGE (no conflicts -- should commit) ===')
  const docId = `merge-clean-${RUN_ID}`
  const versionName = `feature-clean-${RUN_ID}`
  await createDocument(docId)

  const base = makeDoc('Base sentence.')
  await save(docId, 'master', base, 'Base sentence.', 'User-1')
  await createVersion(docId, versionName, 'master')

  const onMaster = new Y.Doc()
  Y.applyUpdate(onMaster, Y.encodeStateAsUpdate(base))
  onMaster.getXmlFragment('default').get(0).get(0).insert(14, ' Master addition.')
  await save(docId, 'master', onMaster, 'Base sentence. Master addition.', 'User-Master')

  const onFeature = new Y.Doc()
  Y.applyUpdate(onFeature, Y.encodeStateAsUpdate(base))
  onFeature.getXmlFragment('default').insert(1, [(() => {
    const el = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    t.insert(0, 'A whole new second paragraph.')
    el.insert(0, [t])
    return el
  })()])
  await save(docId, versionName, onFeature, 'Base sentence.\n\nA whole new second paragraph.', 'User-Feature')

  const result = await mergeViaCollabServer(docId, versionName, 'master', 'merge-bot')
  console.log('HTTP', result.status, JSON.stringify(result.body))
  console.log('merged === true:', result.body.merged === true)
  console.log('has commitId:', !!result.body.commitId)
  console.log('parentCount === 2:', result.body.parentCount === 2)

  const finalMaster = await branchTip(docId, 'master')
  const finalDoc = new Y.Doc()
  Y.applyUpdate(finalDoc, Buffer.from(finalMaster.ydoc, 'base64'))
  console.log('final master text (decoded):', JSON.stringify(finalDoc.getXmlFragment('default').get(0).get(0).toString()))
}

async function testConflictingMerge() {
  console.log('\n=== CONFLICTING MERGE (both sides change the same attribute -- should NOT commit) ===')
  const docId = `merge-conflict-${RUN_ID}`
  const versionName = `feature-conflict-${RUN_ID}`
  await createDocument(docId)

  const base = makeDoc('Heading text.', { level: 1 })
  await save(docId, 'master', base, 'Heading text.', 'User-1')
  await createVersion(docId, versionName, 'master')

  const onMaster = new Y.Doc()
  Y.applyUpdate(onMaster, Y.encodeStateAsUpdate(base))
  onMaster.getXmlFragment('default').get(0).setAttribute('level', 2)
  await save(docId, 'master', onMaster, 'Heading text.', 'User-Master')

  const onFeature = new Y.Doc()
  Y.applyUpdate(onFeature, Y.encodeStateAsUpdate(base))
  onFeature.getXmlFragment('default').get(0).setAttribute('level', 3)
  await save(docId, versionName, onFeature, 'Heading text.', 'User-Feature')

  const beforeMerge = await branchTip(docId, 'master')

  const result = await mergeViaCollabServer(docId, versionName, 'master', 'merge-bot')
  console.log('HTTP', result.status, JSON.stringify(result.body, null, 2))
  console.log('merged === false:', result.body.merged === false)
  console.log('conflicts.length >= 1:', (result.body.conflicts || []).length >= 1)
  console.log('conflict type is attribute:', (result.body.conflicts || []).some((c) => c.type === 'attribute'))

  const afterMerge = await branchTip(docId, 'master')
  console.log('master unchanged by the rejected merge:', beforeMerge.ydoc === afterMerge.ydoc)
}

// Regression test for a real incident (see STATE.md): the first merge()
// implementation used JGit's checkout+working-tree-add+amend flow, which
// silently DROPPED unrelated files from the resulting commit's tree --
// because save() never touches the working tree/index by design, so it's
// permanently stale, and a checkout-based commit builds its tree from that
// stale index rather than the branch's actual HEAD tree. This directly
// deleted real production content on "default" the first time a merge ran
// on a branch that had unrelated save()s interleaved on it. The fix moved
// merge() to the same pure object-database plumbing save() already used.
// In the multi-tenant model this maps directly onto: merging one docId's
// version must not touch a different docId's content in the same
// customer's repo.
async function testMergePreservesUnrelatedDocs() {
  console.log('\n=== REGRESSION: merging one docId must not touch an UNRELATED docId in the same customer repo ===')
  const bystanderDocId = `bystander-${RUN_ID}`
  const mergeDocId = `merge-bystander-check-${RUN_ID}`
  const versionName = `feature-bystander-${RUN_ID}`
  await createDocument(bystanderDocId)
  await createDocument(mergeDocId)

  const bystander = makeDoc('This unrelated document must survive the merge untouched.')
  await save(bystanderDocId, 'master', bystander, 'This unrelated document must survive the merge untouched.', 'User-1')
  const bystanderBefore = await branchTip(bystanderDocId, 'master')

  const base = makeDoc('Merge target base.')
  await save(mergeDocId, 'master', base, 'Merge target base.', 'User-1')
  await createVersion(mergeDocId, versionName, 'master')

  const onFeature = new Y.Doc()
  Y.applyUpdate(onFeature, Y.encodeStateAsUpdate(base))
  onFeature.getXmlFragment('default').get(0).get(0).insert(18, ' Extended on feature.')
  await save(mergeDocId, versionName, onFeature, 'Merge target base. Extended on feature.', 'User-Feature')

  const result = await mergeViaCollabServer(mergeDocId, versionName, 'master', 'merge-bot')
  console.log('merge result:', JSON.stringify(result.body))
  console.log('merge succeeded:', result.body.merged === true)

  const bystanderAfter = await branchTip(bystanderDocId, 'master')
  console.log('bystander ydoc unchanged:', bystanderBefore.ydoc === bystanderAfter.ydoc)
  if (bystanderBefore.ydoc !== bystanderAfter.ydoc) {
    throw new Error('REGRESSION: merge dropped an unrelated docId\'s content -- this is the exact incident from STATE.md')
  }
}

await createCustomer()
await testCleanMerge()
await testConflictingMerge()
await testMergePreservesUnrelatedDocs()
