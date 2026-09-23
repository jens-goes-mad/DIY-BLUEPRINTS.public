import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'

globalThis.WebSocket = WebSocket

// Unique per run so re-running this test doesn't accumulate unbounded
// history under one customer/doc -- not strictly required for correctness
// (the N-1/N comparison works regardless of prior history), just tidier.
const RUN_ID = Date.now().toString(36)
const CUSTOMER_ID = `changelogtest-${RUN_ID}`
const DOC_ID = 'doc1'
const LANGUAGE = 'en'
const PERSISTENCE_URL = 'http://localhost:8081'

async function createCustomer() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: CUSTOMER_ID, displayName: 'Changelog Test Co' }),
  })
  if (!res.ok) throw new Error(`createCustomer failed: ${res.status}`)
}

async function createDocument() {
  const res = await fetch(`${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: DOC_ID, title: 'Changelog Test Doc' }),
  })
  if (!res.ok) throw new Error(`createDocument failed: ${res.status}`)
}

async function fetchContent() {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/content`,
  )
  return res.json()
}

async function fetchChangelog() {
  const res = await fetch(
    `${PERSISTENCE_URL}/api/mt/customers/${CUSTOMER_ID}/documents/${DOC_ID}/versions/master/languages/${LANGUAGE}/changelog`,
  )
  return res.text()
}

// Polls rather than sleeping a fixed duration tied to one specific
// GIT_CHECKPOINT_INTERVAL_MS value -- correct whether the running stack
// uses the 60s default or a shortened override for faster testing. Compares
// ydoc bytes (not markdown -- the content endpoint returns only ydoc, see
// DocumentController) since a new checkpoint always changes them.
async function waitForCheckpoint(previousYdoc, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const content = await fetchContent()
    if (content.ydoc && content.ydoc !== previousYdoc) return content
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('timed out waiting for a new git checkpoint')
}

async function main() {
  await createCustomer()
  await createDocument()

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: 'ws://localhost:1234',
    name: `${CUSTOMER_ID}~${DOC_ID}@master`,
    document: ydoc,
    parameters: { userId: 'User-Alpha' },
  })
  await new Promise((r) => provider.on('synced', r))

  const frag = ydoc.getXmlFragment('default')
  const el = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, 'Hello ')
  el.insert(0, [text])
  frag.insert(0, [el])

  console.log('edit 1 made, polling for the first git checkpoint...')
  const commitNMinus1 = await waitForCheckpoint(null)
  console.log('commit N-1 has ydoc:', !!commitNMinus1.ydoc)

  text.insert(text.length, 'World')
  console.log('edit 2 made, polling for the next git checkpoint...')
  const commitN = await waitForCheckpoint(commitNMinus1.ydoc)
  const changelogN = await fetchChangelog()
  console.log('commit N changelog:\n' + changelogN)

  // --- THE VERIFICATION: replay commit N's changelog on top of commit N-1's snapshot ---
  const replay = new Y.Doc()
  Y.applyUpdate(replay, Buffer.from(commitNMinus1.ydoc, 'base64'))

  const entries = changelogN.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  console.log(`\nreplaying ${entries.length} changelog entr${entries.length === 1 ? 'y' : 'ies'} onto commit N-1's snapshot:`)
  for (const entry of entries) {
    console.log(`  - author=${entry.author} at ${new Date(entry.timestamp).toISOString()}, delta=${entry.delta.length} base64 chars`)
    Y.applyUpdate(replay, Buffer.from(entry.delta, 'base64'))
  }

  const replayedText = replay.getXmlFragment('default').get(0).get(0).toString()
  const actualDoc = new Y.Doc()
  Y.applyUpdate(actualDoc, Buffer.from(commitN.ydoc, 'base64'))
  const actualText = actualDoc.getXmlFragment('default').get(0).get(0).toString()

  console.log('\n=== VERIFICATION ===')
  console.log('replayed text:      ', JSON.stringify(replayedText))
  console.log('actual commit N text:', JSON.stringify(actualText))
  console.log('TEXT MATCHES:', replayedText === actualText)

  const svReplay = Y.encodeStateVector(replay)
  const svActual = Y.encodeStateVector(actualDoc)
  console.log('STATE VECTOR MATCHES:', Buffer.from(svReplay).equals(Buffer.from(svActual)))

  provider.destroy()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
