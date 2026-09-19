import * as Y from 'yjs'
import util from 'node:util'

const doc = new Y.Doc()
const frag = doc.getXmlFragment('default')
const el = new Y.XmlElement('paragraph')
const text = new Y.XmlText()
text.insert(0, 'Hello')
el.insert(0, [text])
frag.insert(0, [el])

const svAfterHello = Y.encodeStateVector(doc)

// Simulate a second user's save: insert " World", then delete "Hello" partially (replace 'H' with 'J')
text.insert(5, ' World')
text.delete(0, 1) // delete 'H'
text.insert(0, 'J') // insert 'J' -> "Jello World"

const deltaChunk = Y.encodeStateAsUpdate(doc, svAfterHello)
console.log('=== raw decodeUpdate() of the isolated delta chunk ===')
const decoded = Y.decodeUpdate(deltaChunk)
console.log(util.inspect(decoded, { depth: 6, maxArrayLength: 50 }))

console.log('\n=== logUpdate() human-ish dump ===')
Y.logUpdate(deltaChunk)
