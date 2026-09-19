import * as Y from 'yjs'
import { detectConflicts } from '../../backend/collab-server/src/conflicts.js'

function makeBase() {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const el = new Y.XmlElement('paragraph')
  el.setAttribute('level', 1)
  const text = new Y.XmlText()
  text.insert(0, 'Base.')
  el.insert(0, [text])
  frag.insert(0, [el])
  return doc
}

function forkFrom(base) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base))
  return doc
}

console.log('=== CASE 1: clean merge -- both sides insert text at different, non-overlapping spots ===')
{
  const base = makeBase()
  const a = forkFrom(base)
  a.getXmlFragment('default').get(0).get(0).insert(5, ' Edited on A.')
  const b = forkFrom(base)
  b.getXmlFragment('default').get(0).insert(1, [(() => { const t = new Y.XmlText(); t.insert(0, 'second para'); return t })()])

  const conflicts = detectConflicts(base, a, b)
  console.log('conflicts found:', conflicts.length, '(expected 0)')
  console.log(JSON.stringify(conflicts))
}

console.log('\n=== CASE 2: attribute conflict -- both sides set the SAME node attribute to DIFFERENT values ===')
{
  const base = makeBase()
  const a = forkFrom(base)
  a.getXmlFragment('default').get(0).setAttribute('level', 2)
  const b = forkFrom(base)
  b.getXmlFragment('default').get(0).setAttribute('level', 3)

  const conflicts = detectConflicts(base, a, b)
  console.log('conflicts found:', conflicts.length, '(expected 1, type=attribute)')
  console.log(JSON.stringify(conflicts, null, 2))
}

console.log('\n=== CASE 3: attribute NON-conflict -- both sides set the SAME attribute to the SAME value ===')
{
  const base = makeBase()
  const a = forkFrom(base)
  a.getXmlFragment('default').get(0).setAttribute('level', 2)
  const b = forkFrom(base)
  b.getXmlFragment('default').get(0).setAttribute('level', 2)

  const conflicts = detectConflicts(base, a, b)
  console.log('conflicts found:', conflicts.length, '(expected 0 -- agreeing writes are not a conflict)')
}

console.log('\n=== CASE 4: delete-vs-edit -- one side deletes the paragraph, other formats text inside it ===')
{
  const base = makeBase()
  const a = forkFrom(base)
  a.getXmlFragment('default').delete(0, 1)
  const b = forkFrom(base)
  b.getXmlFragment('default').get(0).get(0).format(0, 4, { bold: true })

  const conflicts = detectConflicts(base, a, b)
  console.log('conflicts found:', conflicts.length, '(expected >=1, type=delete-vs-edit)')
  console.log(JSON.stringify(conflicts, null, 2))
}
