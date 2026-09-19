import * as Y from 'yjs'

// Detects the two conflict categories proven to be silently-resolved by
// Yjs's CRDT merge (see STATE.md "Per-edit changelog" / the branching RFC):
//
//  1. Both branches concurrently set the same node attribute (heading
//     level, text-align, colspan, ...) to different values -- Yjs resolves
//     this via last-writer-wins with no trace of the loser.
//  2. One branch deletes something the other branch concurrently touched
//     (edited, formatted, or attached new content to).
//
// Attribute conflicts are detected by walking the fully-INTEGRATED base/A/B
// documents directly (matching nodes across them by their stable internal
// Yjs item id, which is identical across replicas for anything created
// before the fork) -- NOT by decoding raw update bytes in isolation. That
// approach was tried first and is unreliable here: a raw decoded Item's
// `parentSub`/`parent` fields are only populated when it's the *first-ever*
// write to that key (verified directly). Overwriting an existing value --
// the realistic conflict case -- encodes as an origin-chained item with
// parentSub/parent left null; Yjs only resolves the real target by walking
// that chain once the item is actually integrated into a document.
//
// Delete-vs-edit conflicts, by contrast, ARE reliably detectable from raw
// decoded update bytes: an inserted/formatted item's parent/origin/
// rightOrigin references are present in the encoding regardless.
//
// Deliberately NOT covered: two branches concurrently formatting the same
// inline mark (e.g. both toggling bold on overlapping text) without either
// side deleting anything. An inline mark's position is established via
// origin/rightOrigin chains within the surrounding text, not a stable
// parent+key pair, so robustly detecting "same range" needs more than this
// covers -- left as a known gap. See tests/unit/conflict-detection.mjs.

function collectElementsById(root, out = new Map()) {
  const len = root.length
  for (let i = 0; i < len; i++) {
    const child = root.get(i)
    if (child instanceof Y.XmlElement) {
      const id = child._item && child._item.id
      if (id) out.set(`${id.client}:${id.clock}`, child)
      collectElementsById(child, out)
    }
  }
  return out
}

function detectAttributeConflicts(baseDoc, docA, docB, field) {
  const baseElements = collectElementsById(baseDoc.getXmlFragment(field))
  const aElements = collectElementsById(docA.getXmlFragment(field))
  const bElements = collectElementsById(docB.getXmlFragment(field))

  const conflicts = []
  for (const [id, baseEl] of baseElements) {
    const aEl = aElements.get(id)
    const bEl = bElements.get(id)
    if (!aEl || !bEl) continue // deleted on at least one side -- see detectDeleteTouchConflicts instead

    const baseAttrs = baseEl.getAttributes()
    const aAttrs = aEl.getAttributes()
    const bAttrs = bEl.getAttributes()
    const keys = new Set([...Object.keys(baseAttrs), ...Object.keys(aAttrs), ...Object.keys(bAttrs)])

    for (const key of keys) {
      const baseVal = baseAttrs[key]
      const aVal = aAttrs[key]
      const bVal = bAttrs[key]
      if (aVal === bVal) continue // both sides agree (including both leaving it unchanged)
      if (aVal !== baseVal && bVal !== baseVal) {
        conflicts.push({ type: 'attribute', attribute: key, base: baseVal, valueA: aVal, valueB: bVal })
      }
    }
  }
  return conflicts
}

function deletedRanges(decoded) {
  const ranges = []
  for (const [client, items] of decoded.ds.clients) {
    for (const d of items) ranges.push({ client, start: d.clock, end: d.clock + d.len })
  }
  return ranges
}

// Overwriting an existing attribute (element.setAttribute(key, newValue) on
// a key that already had a value) tombstones the OLD value's item as an
// implementation detail of last-writer-wins -- verified directly. That
// shows up in the DeleteSet identically to a real user deletion, but it
// isn't one: it's the same LWW event detectAttributeConflicts already
// catches, and flagging it again here would be a duplicate, misleading
// "delete-vs-edit" conflict for something that was never actually deleted
// from the document.
function collectAttributeValueItemIds(decodedSources) {
  const ids = new Set()
  for (const decoded of decodedSources) {
    for (const item of decoded.structs) {
      if (item.content && item.content.constructor.name === 'ContentAny' && item.parentSub) {
        ids.add(`${item.id.client}:${item.id.clock}`)
      }
    }
  }
  return ids
}

function isInRanges(id, ranges, excludeIds) {
  if (!id || typeof id.client !== 'number') return false
  if (excludeIds.has(`${id.client}:${id.clock}`)) return false
  return ranges.some((r) => r.client === id.client && id.clock >= r.start && id.clock < r.end)
}

function detectDeleteTouchConflicts(baseDoc, docA, docB) {
  const baseVector = Y.encodeStateVector(baseDoc)
  const decodedBase = Y.decodeUpdate(Y.encodeStateAsUpdate(baseDoc))
  const decodedA = Y.decodeUpdate(Y.encodeStateAsUpdate(docA, baseVector))
  const decodedB = Y.decodeUpdate(Y.encodeStateAsUpdate(docB, baseVector))
  const deletedByA = deletedRanges(decodedA)
  const deletedByB = deletedRanges(decodedB)
  const attributeValueIds = collectAttributeValueItemIds([decodedBase, decodedA, decodedB])

  const seen = new Set()
  const conflicts = []
  const check = (structs, ranges, deletedBySide, editedBySide) => {
    for (const item of structs) {
      for (const ref of [item.parent, item.origin, item.rightOrigin]) {
        if (isInRanges(ref, ranges, attributeValueIds)) {
          const key = `${deletedBySide}:${ref.client}:${ref.clock}`
          if (seen.has(key)) continue
          seen.add(key)
          conflicts.push({ type: 'delete-vs-edit', deletedBySide, editedBySide, targetId: `${ref.client}:${ref.clock}` })
        }
      }
    }
  }
  check(decodedB.structs, deletedByA, 'A', 'B')
  check(decodedA.structs, deletedByB, 'B', 'A')
  return conflicts
}

/**
 * baseDoc must be the actual common ancestor of docA and docB (their git
 * merge-base). Returns [] if the merge is safe to commit outright.
 */
export function detectConflicts(baseDoc, docA, docB, field = 'default') {
  return [
    ...detectAttributeConflicts(baseDoc, docA, docB, field),
    ...detectDeleteTouchConflicts(baseDoc, docA, docB),
  ]
}
