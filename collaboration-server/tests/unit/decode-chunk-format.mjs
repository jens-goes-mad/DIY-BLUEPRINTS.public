import * as Y from 'yjs'
import util from 'node:util'

const doc = new Y.Doc()
const frag = doc.getXmlFragment('default')
const el = new Y.XmlElement('paragraph')
const text = new Y.XmlText()
text.insert(0, 'Hello World')
el.insert(0, [text])
frag.insert(0, [el])

const svBeforeFormat = Y.encodeStateVector(doc)

// simulate a "make World bold" edit, plus a node-attribute change (heading level)
text.format(6, 5, { bold: true })
el.setAttribute('level', 2) // pretend this were a heading node with a level attr

const deltaChunk = Y.encodeStateAsUpdate(doc, svBeforeFormat)
const decoded = Y.decodeUpdate(deltaChunk)
console.log(util.inspect(decoded, { depth: 6, maxArrayLength: 50 }))
