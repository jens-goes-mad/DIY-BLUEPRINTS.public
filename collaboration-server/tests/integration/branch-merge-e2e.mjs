import * as Y from 'yjs'

const PERSISTENCE_URL = 'http://localhost:8081'
const LANGUAGE = 'en'

// customerId and the feature version name must both be unique per run:
// customers/versions are permanent once created (no cleanup mechanism), so
// fixed names would only pass on the first-ever run.
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `mergetest-${RUN_ID}`
const DOC_ID = 'doc1'
const FEATURE_VERSION = `feature-x-${RUN_ID}`

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

function textOf(ydocBase64) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Buffer.from(ydocBase64, 'base64'))
  return doc.getXmlFragment('default').get(0).get(0).toString()
}

async function createCustomer() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: CUSTOMER_ID, displayName: 'Merge Test Co' }),
  })
  console.log(`createCustomer ${CUSTOMER_ID}: HTTP ${res.status}`)
}

async function createDocument() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: DOC_ID, title: 'Merge Test Doc' }),
  })
  console.log(`createDocument ${DOC_ID}: HTTP ${res.status}`)
}

async function save(versionName, ydoc, markdown, author) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/${versionName}/languages/${LANGUAGE}/content`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ydoc: b64(Y.encodeStateAsUpdate(ydoc)), markdown, changelog: '', author }),
    },
  )
  console.log(`save ${DOC_ID}@${versionName} by ${author}: HTTP ${res.status}`)
}

async function load(versionName) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/${versionName}/languages/${LANGUAGE}/content`,
  )
  return res.json()
}

async function createVersion(versionName, fromVersionName) {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionName, fromVersionName }),
  })
  console.log(`createVersion ${versionName} from ${fromVersionName}: HTTP ${res.status}`)
}

async function merge(targetVersionName, sourceVersionName, mergedYdoc, mergedMarkdown, author) {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/${targetVersionName}/merge`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceVersionName,
        language: LANGUAGE,
        author,
        ydoc: b64(Y.encodeStateAsUpdate(mergedYdoc)),
        markdown: mergedMarkdown,
      }),
    },
  )
  console.log(`merge ${sourceVersionName} -> ${targetVersionName}: HTTP ${res.status}`)
  console.log(await res.json())
}

await createCustomer()
await createDocument()

// 1. base content on master
const base = ydocWithText('base sentence.')
await save('master', base, 'base sentence.', 'User-1')

// 2. branch off
await createVersion(FEATURE_VERSION, 'master')

// 3. diverge: master gets an edit
const masterDoc = new Y.Doc()
Y.applyUpdate(masterDoc, Y.encodeStateAsUpdate(base))
const masterFrag = masterDoc.getXmlFragment('default')
masterFrag.get(0).get(0).insert(14, ' Edited on master.')
await save('master', masterDoc, 'base sentence. Edited on master.', 'User-Master')

// 4. diverge: feature-x gets a different edit, from the SAME base
const featureDoc = new Y.Doc()
Y.applyUpdate(featureDoc, Y.encodeStateAsUpdate(base))
const featureFrag = featureDoc.getXmlFragment('default')
featureFrag.get(0).get(0).insert(14, ' Edited on feature-x.')
await save(FEATURE_VERSION, featureDoc, 'base sentence. Edited on feature-x.', 'User-Feature')

// 5. compute the actual CRDT merge (this is what collab-server will do)
const merged = new Y.Doc()
Y.applyUpdate(merged, Y.encodeStateAsUpdate(masterDoc))
Y.applyUpdate(merged, Y.encodeStateAsUpdate(featureDoc))
const mergedText = merged.getXmlFragment('default').get(0).get(0).toString()
console.log('=== CRDT-MERGED TEXT ===')
console.log(mergedText)

// 6. record the merge in git: master + feature-x -> master, with the CRDT-resolved content
await merge('master', FEATURE_VERSION, merged, mergedText, 'merge-bot')

// 7. verify -- decode the stored ydoc directly (the content endpoint returns
// only ydoc, no markdown -- see DocumentController)
const finalState = await load('master')
console.log('=== FINAL MASTER YDOC TEXT (decoded from stored binary) ===')
console.log(textOf(finalState.ydoc))
