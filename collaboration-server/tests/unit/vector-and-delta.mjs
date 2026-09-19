import * as Y from 'yjs'

const doc = new Y.Doc()
const frag = doc.getXmlFragment('default')
const el = new Y.XmlElement('paragraph')
const text = new Y.XmlText()
text.insert(0, 'Hello')
el.insert(0, [text])
frag.insert(0, [el])

// snapshot the state vector at this point
const svAfterHello = Y.encodeStateVector(doc)
console.log('state vector after "Hello":', svAfterHello)

const fullUpdate1 = Y.encodeStateAsUpdate(doc)
console.log('full update size after "Hello":', fullUpdate1.length, 'bytes')

// more edits
text.insert(5, ' World')
text.insert(11, '!')

const fullUpdate2 = Y.encodeStateAsUpdate(doc)
console.log('full update size after "Hello World!":', fullUpdate2.length, 'bytes')

// the DELTA since the earlier state vector -- only what changed
const deltaSinceHello = Y.encodeStateAsUpdate(doc, svAfterHello)
console.log('delta-only update size (since "Hello"):', deltaSinceHello.length, 'bytes')

// prove the delta is independently useful: replay it onto a doc that only had "Hello"
const replica = new Y.Doc()
Y.applyUpdate(replica, fullUpdate1) // replica now has just "Hello"
Y.applyUpdate(replica, deltaSinceHello) // catch it up using ONLY the delta
console.log('replica after applying full1 + delta:', replica.getXmlFragment('default').get(0).get(0).toString())

// mergeUpdates: does merging [full1, delta] equal full2, purely at the byte/update level (no live doc needed)?
const merged = Y.mergeUpdates([fullUpdate1, deltaSinceHello])
const mergedDoc = new Y.Doc()
Y.applyUpdate(mergedDoc, merged)
console.log('merged-updates result:', mergedDoc.getXmlFragment('default').get(0).get(0).toString())
console.log('merged update size:', merged.length, 'bytes (vs full2:', fullUpdate2.length, 'bytes)')
