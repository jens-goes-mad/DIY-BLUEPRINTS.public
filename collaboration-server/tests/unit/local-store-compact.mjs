import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'

// Crash safety of localStore.compact(). Regression test for a real loss
// (2026-09-24, see STATE.md): compact() used fs.writeFile, which truncates
// the base file BEFORE writing, so a process kill mid-write left an empty
// base and the document's unsaved edits were gone.

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-store-'))
process.env.LIVE_STORE_PATH = dir // read once at import time, so set it first
const { compact, loadLocal, listLocalDocuments } = await import('../../backend/collab-server/src/localStore.js')

function stateWith(text) {
  const doc = new Y.Doc()
  const el = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  el.insert(0, [t])
  doc.getXmlFragment('default').insert(0, [el])
  return Y.encodeStateAsUpdate(doc)
}

const textOf = (chunks) => {
  const doc = new Y.Doc()
  for (const c of chunks) Y.applyUpdate(doc, c)
  return doc.getXmlFragment('default').get(0).toString()
}

// 1. plain round trip
await compact('doc-a', stateWith('first'))
assert.equal(textOf(await loadLocal('doc-a')), '<paragraph>first</paragraph>')
console.log('compact then load round-trips: ok')

// 2. a failure at ANY point of the swap must leave the previous base intact.
// Simulates a kill mid-write: writeFile truncates its target then dies (what
// the old implementation did to the real base), and rename dies before the
// swap (what would interrupt the new one).
const realWriteFile = fs.writeFile
const realRename = fs.rename
fs.writeFile = async (file) => {
  await fs.truncate(file, 0)
  throw new Error('simulated kill mid-write')
}
fs.rename = async () => {
  throw new Error('simulated kill before rename')
}
try {
  await assert.rejects(compact('doc-a', stateWith('second')), /simulated kill/)
} finally {
  fs.writeFile = realWriteFile
  fs.rename = realRename
}
assert.equal(textOf(await loadLocal('doc-a')), '<paragraph>first</paragraph>', 'previous base must survive a failed compaction')
console.log('failed compaction leaves the previous base intact: ok')

// 3. and leaves nothing behind that could be mistaken for a document
const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))
assert.deepEqual(leftovers, [], 'temp files must be cleaned up after a failure')
assert.deepEqual(await listLocalDocuments(), ['doc-a'])
console.log('no leftover temp files, document listing unaffected: ok')

// 4. overlapping compactions of the same doc (afterUnloadDocument racing a
// size-triggered one really happens) must not corrupt each other
await Promise.all([compact('doc-a', stateWith('racer-one')), compact('doc-a', stateWith('racer-two'))])
assert.match(textOf(await loadLocal('doc-a')), /^<paragraph>racer-(one|two)<\/paragraph>$/)
assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), [])
console.log('overlapping compactions end in one intact state: ok')

await fs.rm(dir, { recursive: true, force: true })
console.log('\nall local-store compaction checks passed')
