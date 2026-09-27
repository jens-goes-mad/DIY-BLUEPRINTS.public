import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { diffChangelog, parseChangelog } from '../../backend/collab-server/src/changelogDiff.js'

// Imports changelogDiff.js from its real location, so (same as
// markdown-roundtrip.mjs) Node resolves ITS imports (schema.js -> tiptap/
// prosemirror, markdown.js) relative to backend/collab-server, not tests/ --
// run this with that package's own dependencies installed:
//   (cd ../backend/collab-server && npm install)
//   node changelog-diff.mjs

function docWith(text) {
  const doc = new Y.Doc()
  const el = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  t.insert(0, text)
  el.insert(0, [t])
  doc.getXmlFragment('default').insert(0, [el])
  return doc
}

// Mirrors what server.js's onStoreDocument actually does: edits land on the
// SAME lineage the previous checkpoint came from (seeded via applyUpdate,
// not rebuilt from scratch -- a fresh doc would create unrelated Yjs item
// IDs, so applying its "delta" onto previousDoc would duplicate content
// instead of editing it), and each delta is relative to what was already
// saved, base64-encoded into a changelog entry.
function makeEntries(previousDoc, edits) {
  const doc = new Y.Doc()
  if (previousDoc) Y.applyUpdate(doc, Y.encodeStateAsUpdate(previousDoc))
  const entries = []
  let sv = Y.encodeStateVector(doc)
  for (const [author, apply] of edits) {
    apply(doc)
    const delta = Y.encodeStateAsUpdate(doc, sv)
    sv = Y.encodeStateVector(doc)
    entries.push({ author, timestamp: entries.length, delta: Buffer.from(delta).toString('base64') })
  }
  return { doc, entries }
}

function textOfDiff(diff, type) {
  return diff.filter((p) => p.type === type).map((p) => p.value).join('')
}

// 1. a single insertion, diffed against a real previous checkpoint
{
  const previous = docWith('Hello')
  const { entries } = makeEntries(previous, [
    ['alice', (doc) => doc.getXmlFragment('default').get(0).get(0).insert(5, ' World')],
  ])
  const [change] = diffChangelog(Y.encodeStateAsUpdate(previous), entries)
  assert.equal(change.author, 'alice')
  assert.equal(textOfDiff(change.diff, 'added').trim(), 'World')
  assert.equal(textOfDiff(change.diff, 'removed'), '')
  console.log('single insertion attributed and diffed correctly: ok')
}

// 2. a deletion is recovered as real removed CONTENT, not just a length --
// exactly the gap raw delta decoding can't close on its own (a delta only
// ever carries a tombstone for a deletion -- see unit/decode-chunk-*.mjs)
// and decode-then-diff exists to close.
{
  const previous = docWith('Hello World')
  const { entries } = makeEntries(previous, [
    ['bob', (doc) => doc.getXmlFragment('default').get(0).get(0).delete(5, 6)], // " World"
  ])
  const [change] = diffChangelog(Y.encodeStateAsUpdate(previous), entries)
  assert.equal(textOfDiff(change.diff, 'removed').trim(), 'World')
  console.log('deletion recovers the actual removed text: ok')
}

// 3. sequential entries chain correctly, and replaying all of them
// reproduces the live document's real final state exactly (same guarantee
// changelog-replay.mjs already proves end to end against the live stack)
{
  const previous = docWith('One')
  const { doc, entries } = makeEntries(previous, [
    ['bob', (d) => d.getXmlFragment('default').get(0).get(0).insert(3, ' Two')],
    ['alice', (d) => d.getXmlFragment('default').get(0).get(0).insert(7, ' Three')],
  ])
  const changes = diffChangelog(Y.encodeStateAsUpdate(previous), entries)
  assert.deepEqual(changes.map((c) => c.author), ['bob', 'alice'])
  assert.equal(textOfDiff(changes[0].diff, 'added').trim(), 'Two')
  assert.equal(textOfDiff(changes[1].diff, 'added').trim(), 'Three')

  const replay = new Y.Doc()
  Y.applyUpdate(replay, Y.encodeStateAsUpdate(previous))
  for (const e of entries) Y.applyUpdate(replay, Buffer.from(e.delta, 'base64'))
  assert.deepEqual(
    Buffer.from(Y.encodeStateVector(replay)),
    Buffer.from(Y.encodeStateVector(doc)),
    'replaying every entry must reproduce the real document’s exact state',
  )
  console.log('sequential entries chain correctly and reproduce the real final state: ok')
}

// 4. no previous checkpoint at all (this version/language's very first
// save) -- "before" is empty, not an error.
{
  const { entries } = makeEntries(null, [
    ['alice', (d) => {
      const el = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, 'First ever content.')
      el.insert(0, [t])
      d.getXmlFragment('default').insert(0, [el])
    }],
  ])
  const [change] = diffChangelog(null, entries)
  assert.equal(textOfDiff(change.diff, 'added').trim(), 'First ever content.')
  assert.equal(textOfDiff(change.diff, 'unchanged'), '')
  console.log('null previous (first-ever checkpoint) treated as empty, not an error: ok')
}

// 5. parseChangelog: real JSONL shape, and the empty/no-changelog-yet case
{
  const jsonl = '{"author":"a","timestamp":1,"delta":"AA=="}\n{"author":"b","timestamp":2,"delta":"AQ=="}'
  const parsed = parseChangelog(jsonl)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].author, 'b')
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog(undefined), [])
  console.log('parseChangelog handles real JSONL and the empty case: ok')
}

console.log('\nall changelog-diff checks passed')
