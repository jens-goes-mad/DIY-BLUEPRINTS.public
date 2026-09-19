import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'

globalThis.WebSocket = WebSocket

// Unique per run so re-running this test doesn't accumulate unbounded
// history under one docId -- not strictly required for correctness (the
// N-1/N comparison works regardless of prior history), just tidier.
const DOC_ID = `changelog-test-${Date.now().toString(36)}`
const PERSISTENCE_URL = 'http://localhost:8081'

async function fetchDoc() {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${DOC_ID}?branch=master`)
  return res.json()
}

// Polls rather than sleeping a fixed duration tied to one specific
// GIT_CHECKPOINT_INTERVAL_MS value -- correct whether the running stack
// uses the 60s default or a shortened override for faster testing.
async function waitForCheckpoint(previousMarkdown, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const doc = await fetchDoc()
    if (doc.markdown && doc.markdown !== previousMarkdown) return doc
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`timed out waiting for a new git checkpoint (still "${previousMarkdown}")`)
}

async function main() {
  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: 'ws://localhost:1234',
    name: DOC_ID,
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
  const commitNMinus1 = await waitForCheckpoint('')
  console.log('commit N-1 markdown:', JSON.stringify(commitNMinus1.markdown), '| has ydoc:', !!commitNMinus1.ydoc)

  text.insert(text.length, 'World')
  console.log('edit 2 made, polling for the next git checkpoint...')
  const commitN = await waitForCheckpoint(commitNMinus1.markdown)
  console.log('commit N markdown:', JSON.stringify(commitN.markdown))
  console.log('commit N changelog:\n' + commitN.changelog)

  // --- THE VERIFICATION: replay commit N's changelog on top of commit N-1's snapshot ---
  const replay = new Y.Doc()
  Y.applyUpdate(replay, Buffer.from(commitNMinus1.ydoc, 'base64'))

  const entries = commitN.changelog.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
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
