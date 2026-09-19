import * as Y from 'yjs'

const PERSISTENCE_URL = 'http://localhost:8081'
const COLLAB_URL = 'http://localhost:3000'
const RUN_ID = Date.now().toString(36)

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function save(docId, branch, ydoc, markdown, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ydoc: b64(Y.encodeStateAsUpdate(ydoc)), markdown, changelog: '', author }),
  })
  if (!res.ok) throw new Error(`save failed: ${res.status}`)
}

async function createBranch(newBranch, fromBranch) {
  const res = await fetch(`${PERSISTENCE_URL}/api/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newBranch, fromBranch }),
  })
  if (!res.ok) throw new Error(`createBranch failed: ${res.status}`)
}

async function branchTip(docId, branch) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`)
  return res.json()
}

async function mergeViaCollabServer(docId, sourceBranch, targetBranch, author) {
  const res = await fetch(`${COLLAB_URL}/api/documents/${docId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceBranch, targetBranch, author }),
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
  const branch = `feature-clean-${RUN_ID}`

  const base = makeDoc('Base sentence.')
  await save(docId, 'master', base, 'Base sentence.', 'User-1')
  await createBranch(branch, 'master')

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
  await save(docId, branch, onFeature, 'Base sentence.\n\nA whole new second paragraph.', 'User-Feature')

  const result = await mergeViaCollabServer(docId, branch, 'master', 'merge-bot')
  console.log('HTTP', result.status, JSON.stringify(result.body))
  console.log('merged === true:', result.body.merged === true)
  console.log('has commitId:', !!result.body.commitId)
  console.log('parentCount === 2:', result.body.parentCount === 2)

  const finalMaster = await branchTip(docId, 'master')
  console.log('final master markdown:', JSON.stringify(finalMaster.markdown))
}

async function testConflictingMerge() {
  console.log('\n=== CONFLICTING MERGE (both sides change the same attribute -- should NOT commit) ===')
  const docId = `merge-conflict-${RUN_ID}`
  const branch = `feature-conflict-${RUN_ID}`

  const base = makeDoc('Heading text.', { level: 1 })
  await save(docId, 'master', base, 'Heading text.', 'User-1')
  await createBranch(branch, 'master')

  const onMaster = new Y.Doc()
  Y.applyUpdate(onMaster, Y.encodeStateAsUpdate(base))
  onMaster.getXmlFragment('default').get(0).setAttribute('level', 2)
  await save(docId, 'master', onMaster, 'Heading text.', 'User-Master')

  const onFeature = new Y.Doc()
  Y.applyUpdate(onFeature, Y.encodeStateAsUpdate(base))
  onFeature.getXmlFragment('default').get(0).setAttribute('level', 3)
  await save(docId, branch, onFeature, 'Heading text.', 'User-Feature')

  const beforeMerge = await branchTip(docId, 'master')

  const result = await mergeViaCollabServer(docId, branch, 'master', 'merge-bot')
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
async function testMergePreservesUnrelatedDocs() {
  console.log('\n=== REGRESSION: merging one docId must not touch an UNRELATED docId on the same branch ===')
  const bystanderDocId = `bystander-${RUN_ID}`
  const mergeDocId = `merge-bystander-check-${RUN_ID}`
  const branch = `feature-bystander-${RUN_ID}`

  const bystander = makeDoc('This unrelated document must survive the merge untouched.')
  await save(bystanderDocId, 'master', bystander, 'This unrelated document must survive the merge untouched.', 'User-1')
  const bystanderBefore = await branchTip(bystanderDocId, 'master')

  const base = makeDoc('Merge target base.')
  await save(mergeDocId, 'master', base, 'Merge target base.', 'User-1')
  await createBranch(branch, 'master')

  const onFeature = new Y.Doc()
  Y.applyUpdate(onFeature, Y.encodeStateAsUpdate(base))
  onFeature.getXmlFragment('default').get(0).get(0).insert(18, ' Extended on feature.')
  await save(mergeDocId, branch, onFeature, 'Merge target base. Extended on feature.', 'User-Feature')

  const result = await mergeViaCollabServer(mergeDocId, branch, 'master', 'merge-bot')
  console.log('merge result:', JSON.stringify(result.body))
  console.log('merge succeeded:', result.body.merged === true)

  const bystanderAfter = await branchTip(bystanderDocId, 'master')
  console.log('bystander ydoc unchanged:', bystanderBefore.ydoc === bystanderAfter.ydoc)
  console.log('bystander markdown unchanged:', bystanderBefore.markdown === bystanderAfter.markdown)
  if (bystanderBefore.ydoc !== bystanderAfter.ydoc) {
    throw new Error('REGRESSION: merge dropped an unrelated docId\'s content -- this is the exact incident from STATE.md')
  }
}

await testCleanMerge()
await testConflictingMerge()
await testMergePreservesUnrelatedDocs()
