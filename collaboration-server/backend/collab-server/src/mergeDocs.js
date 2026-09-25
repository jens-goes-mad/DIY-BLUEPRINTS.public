import * as Y from 'yjs'
import { detectConflicts } from './conflicts.js'

/**
 * The pure core of a version merge: no I/O, no git, nothing but Y.Docs in
 * and a result out -- so mergeBranches.js (which loads the three docs from
 * persistence-service and commits the result) and the scenario test runner
 * (tests/scenarios) exercise the exact same logic instead of two copies.
 *
 * baseDoc is the merge-base state, targetDoc the version being merged INTO,
 * sourceDoc the version being merged in. Returns either
 *   { merged: false, conflicts }                      -- refused, nothing touched
 *   { merged: true, conflicts, mergedBytes }          -- targetDoc now holds the result
 * where conflicts is empty on a clean merge. With force, conflicts are still
 * reported but no longer block the merge: Yjs then resolves them the only way
 * it can (deterministically, e.g. last-writer-wins on a concurrently changed
 * attribute), which is what makes force useful as a preview of what a merge
 * WOULD do -- the real pipeline never passes it, so behavior there is
 * unchanged: any conflict refuses the merge.
 *
 * Mutates targetDoc (applies sourceDoc's state onto it) exactly as the
 * inline code in mergeBranches.js used to.
 */
export function mergeDocs(baseDoc, targetDoc, sourceDoc, { field = 'default', force = false } = {}) {
  const conflicts = detectConflicts(baseDoc, targetDoc, sourceDoc, field)
  if (conflicts.length > 0 && !force) {
    return { merged: false, conflicts }
  }

  Y.applyUpdate(targetDoc, Y.encodeStateAsUpdate(sourceDoc))
  return { merged: true, conflicts, mergedBytes: Y.encodeStateAsUpdate(targetDoc) }
}
