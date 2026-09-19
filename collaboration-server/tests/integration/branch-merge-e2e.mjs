import * as Y from 'yjs'

const PERSISTENCE_URL = 'http://localhost:8081'

// Both the docId and the branch name must be unique per run: "master" is a
// real, permanent, shared git branch across the whole repo (creating
// "feature-x" once means it exists forever), so a fixed name would only
// pass on the first-ever run.
const RUN_ID = Date.now().toString(36)
const DOC_ID = `mergetest-${RUN_ID}`
const FEATURE_BRANCH = `feature-x-${RUN_ID}`

function ydocWithText(text) {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const el = new Y.XmlElement('paragraph')
  const xmlText = new Y.XmlText()
  xmlText.insert(0, text)
  el.insert(0, [xmlText])
  frag.insert(0, [el])
  return doc
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

async function save(docId, branch, ydoc, markdown, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ydoc: b64(Y.encodeStateAsUpdate(ydoc)), markdown, author }),
  })
  console.log(`save ${docId}@${branch} by ${author}: HTTP ${res.status}`)
}

async function load(docId, branch) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`)
  return res.json()
}

async function createBranch(newBranch, fromBranch) {
  const res = await fetch(`${PERSISTENCE_URL}/api/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newBranch, fromBranch }),
  })
  console.log(`createBranch ${newBranch} from ${fromBranch}: HTTP ${res.status}`)
}

async function merge(docId, targetBranch, sourceBranch, mergedYdoc, mergedMarkdown, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetBranch, sourceBranch, author,
      ydoc: b64(Y.encodeStateAsUpdate(mergedYdoc)),
      markdown: mergedMarkdown,
    }),
  })
  console.log(`merge ${sourceBranch} -> ${targetBranch}: HTTP ${res.status}`)
  console.log(await res.json())
}

// 1. base content on master
const base = ydocWithText('base sentence.')
await save(DOC_ID, 'master', base, 'base sentence.', 'User-1')

// 2. branch off
await createBranch(FEATURE_BRANCH, 'master')

// 3. diverge: master gets an edit
const masterDoc = new Y.Doc()
Y.applyUpdate(masterDoc, Y.encodeStateAsUpdate(base))
const masterFrag = masterDoc.getXmlFragment('default')
masterFrag.get(0).get(0).insert(14, ' Edited on master.')
await save(DOC_ID, 'master', masterDoc, 'base sentence. Edited on master.', 'User-Master')

// 4. diverge: feature-x gets a different edit, from the SAME base
const featureDoc = new Y.Doc()
Y.applyUpdate(featureDoc, Y.encodeStateAsUpdate(base))
const featureFrag = featureDoc.getXmlFragment('default')
featureFrag.get(0).get(0).insert(14, ' Edited on feature-x.')
await save(DOC_ID, FEATURE_BRANCH, featureDoc, 'base sentence. Edited on feature-x.', 'User-Feature')

// 5. compute the actual CRDT merge (this is what collab-server will do)
const merged = new Y.Doc()
Y.applyUpdate(merged, Y.encodeStateAsUpdate(masterDoc))
Y.applyUpdate(merged, Y.encodeStateAsUpdate(featureDoc))
const mergedText = merged.getXmlFragment('default').get(0).get(0).toString()
console.log('=== CRDT-MERGED TEXT ===')
console.log(mergedText)

// 6. record the merge in git: master + feature-x -> master, with the CRDT-resolved content
await merge(DOC_ID, 'master', FEATURE_BRANCH, merged, mergedText, 'merge-bot')

// 7. verify
const finalState = await load(DOC_ID, 'master')
console.log('=== FINAL MASTER MARKDOWN ===')
console.log(finalState.markdown)

const finalDoc = new Y.Doc()
Y.applyUpdate(finalDoc, Buffer.from(finalState.ydoc, 'base64'))
console.log('=== FINAL MASTER YDOC TEXT (decoded from stored binary) ===')
console.log(finalDoc.getXmlFragment('default').get(0).get(0).toString())
