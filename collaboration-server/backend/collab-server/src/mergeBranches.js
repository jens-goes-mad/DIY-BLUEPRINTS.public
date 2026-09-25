import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import { schema } from './schema.js'
import { createMarkdownSerializer } from './markdown.js'
import { loadSnapshot, findMergeBase, commitMerge } from './persistenceClient.js'
import { mergeDocs } from './mergeDocs.js'

const YJS_FIELD = 'default'
const markdownSerializer = createMarkdownSerializer()

function docFromBytes(bytes) {
  const doc = new Y.Doc()
  if (bytes) Y.applyUpdate(doc, bytes)
  return doc
}

/**
 * Either returns { merged: false, conflicts: [...] } without touching git
 * at all, or performs the actual Yjs CRDT merge and commits it via
 * persistence-service, returning { merged: true, commitId, parentCount }.
 *
 * The merge itself (Y.applyUpdate) would never fail or produce an
 * ambiguous result even when detectConflicts finds something -- CRDT
 * merges always converge deterministically (verified in
 * tests/unit/merge-conflict-resolution.mjs). What conflicts here means is
 * "this merge would silently resolve something in a way neither side
 * would necessarily want" (last-writer-wins on a concurrently-changed
 * attribute, or an edit landing on content the other branch deleted) --
 * see conflicts.js for exactly what is and isn't detected.
 */
export async function mergeBranches(customerId, docId, sourceVersionName, targetVersionName, language, author) {
  const mergeBaseCommit = await findMergeBase(customerId, docId, sourceVersionName, targetVersionName)
  if (!mergeBaseCommit) {
    throw new Error(`versions share no common history: ${sourceVersionName}, ${targetVersionName}`)
  }

  const [baseBytes, targetBytes, sourceBytes] = await Promise.all([
    loadSnapshot(customerId, docId, mergeBaseCommit, language),
    loadSnapshot(customerId, docId, targetVersionName, language),
    loadSnapshot(customerId, docId, sourceVersionName, language),
  ])

  const baseDoc = docFromBytes(baseBytes)
  const targetDoc = docFromBytes(targetBytes)
  const sourceDoc = docFromBytes(sourceBytes)

  const result = mergeDocs(baseDoc, targetDoc, sourceDoc, { field: YJS_FIELD })
  if (!result.merged) {
    return { merged: false, conflicts: result.conflicts }
  }

  const mergedBytes = result.mergedBytes
  const docJSON = yDocToProsemirrorJSON(targetDoc, YJS_FIELD)
  const node = schema.nodeFromJSON(docJSON)
  const markdown = markdownSerializer.serialize(node)

  const commitResult = await commitMerge(customerId, docId, sourceVersionName, targetVersionName, language, mergedBytes, markdown, author)
  return { merged: true, ...commitResult }
}
