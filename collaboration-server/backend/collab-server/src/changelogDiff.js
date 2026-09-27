import * as Y from 'yjs'
import { diffWords } from 'diff'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import { schema } from './schema.js'
import { createMarkdownSerializer } from './markdown.js'

const YJS_FIELD = 'default'
const markdownSerializer = createMarkdownSerializer()

function renderText(doc) {
  const docJSON = yDocToProsemirrorJSON(doc, YJS_FIELD)
  const node = schema.nodeFromJSON(docJSON)
  return markdownSerializer.serialize(node)
}

/**
 * Turns one checkpoint's changelog into a readable, per-entry diff: for each
 * entry, decode the Y.Doc immediately before and immediately after applying
 * that entry's delta, render both the same way a real checkpoint does (see
 * server.js's checkpointToGit), and word-diff the two. Nothing here is
 * stored -- it's reconstructed fresh on every call, replaying deltas onto
 * previousBytes exactly the way changelog-replay.mjs already proved
 * reproduces the checkpoint's own final state byte for byte (state-vector
 * identical); this just also looks at every state in between, not only the
 * last one.
 *
 * previousBytes is the checkpoint this changelog started from -- null/
 * undefined for a version/language's very first checkpoint, where there's
 * nothing to diff the first entry's "before" against (treated as empty).
 *
 * CAVEAT, not something this function can fix: `author` is whoever's action
 * triggered that particular debounced save (see onStoreDocument), not
 * necessarily everyone whose edits are IN the delta -- Hocuspocus shares one
 * Y.Doc across every connection, so if two people typed within the same
 * ~8s debounce window, one save can carry both edits under one name. Real
 * per-keystroke attribution isn't reconstructable from what's stored.
 */
export function diffChangelog(previousBytes, entries) {
  const doc = new Y.Doc()
  if (previousBytes) Y.applyUpdate(doc, previousBytes)

  const results = []
  for (const entry of entries) {
    const before = renderText(doc)
    Y.applyUpdate(doc, Buffer.from(entry.delta, 'base64'))
    const after = renderText(doc)
    results.push({
      author: entry.author,
      timestamp: entry.timestamp,
      diff: diffWords(before, after).map((part) => ({
        value: part.value,
        type: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
      })),
    })
  }
  return results
}

/** Parses the JSONL string GET .../changelog returns into entry objects. Empty string/no changelog yet -> []. */
export function parseChangelog(changelogJsonl) {
  return (changelogJsonl ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
