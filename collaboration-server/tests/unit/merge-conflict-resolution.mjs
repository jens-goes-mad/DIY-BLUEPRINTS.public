import * as Y from 'yjs'

function makeBase() {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('default')
  const el = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, 'Base.')
  el.insert(0, [text])
  frag.insert(0, [el])
  return doc
}

console.log('=== TEST 1: two branches concurrently insert a WHOLE STRING at the SAME position ===')
{
  const base = makeBase()
  const baseUpdate = Y.encodeStateAsUpdate(base)

  const branchA = new Y.Doc()
  Y.applyUpdate(branchA, baseUpdate)
  const textA = branchA.getXmlFragment('default').get(0).get(0)
  textA.insert(5, ' AAAAA')

  const branchB = new Y.Doc()
  Y.applyUpdate(branchB, baseUpdate)
  const textB = branchB.getXmlFragment('default').get(0).get(0)
  textB.insert(5, ' BBBBB')

  // merge A<-B
  const mergedAB = new Y.Doc()
  Y.applyUpdate(mergedAB, Y.encodeStateAsUpdate(branchA))
  Y.applyUpdate(mergedAB, Y.encodeStateAsUpdate(branchB))
  const resultAB = mergedAB.getXmlFragment('default').get(0).get(0).toString()

  // merge B<-A (opposite order, to check convergence)
  const mergedBA = new Y.Doc()
  Y.applyUpdate(mergedBA, Y.encodeStateAsUpdate(branchB))
  Y.applyUpdate(mergedBA, Y.encodeStateAsUpdate(branchA))
  const resultBA = mergedBA.getXmlFragment('default').get(0).get(0).toString()

  console.log('bulk single-op insert, merged A-then-B:', JSON.stringify(resultAB))
  console.log('bulk single-op insert, merged B-then-A:', JSON.stringify(resultBA))
  console.log('CONVERGED (order-independent):', resultAB === resultBA)
  console.log('interleaved?', !resultAB.includes('AAAAA') || !resultAB.includes('BBBBB') ? 'n/a' : (resultAB.includes(' AAAAA') && resultAB.includes(' BBBBB') ? 'NO, both chunks stayed contiguous' : 'YES, interleaved'))
}

console.log('\n=== TEST 2: two branches concurrently TYPE character-by-character at the SAME position ===')
{
  const base = makeBase()
  const baseUpdate = Y.encodeStateAsUpdate(base)

  const branchA = new Y.Doc()
  Y.applyUpdate(branchA, baseUpdate)
  const textA = branchA.getXmlFragment('default').get(0).get(0)
  for (const ch of 'AAAAA') textA.insert(5, ch) // simulate typing: repeated single-char inserts at the same cursor position

  const branchB = new Y.Doc()
  Y.applyUpdate(branchB, baseUpdate)
  const textB = branchB.getXmlFragment('default').get(0).get(0)
  for (const ch of 'BBBBB') textB.insert(5, ch)

  const merged = new Y.Doc()
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(branchA))
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(branchB))
  const result = merged.getXmlFragment('default').get(0).get(0).toString()
  console.log('character-by-character typing merge result:', JSON.stringify(result))
}

console.log('\n=== TEST 3: two branches concurrently set the SAME attribute to DIFFERENT values (LWW) ===')
{
  const base = makeBase()
  base.getXmlFragment('default').get(0).setAttribute('level', 1)
  const baseUpdate = Y.encodeStateAsUpdate(base)

  const branchA = new Y.Doc()
  Y.applyUpdate(branchA, baseUpdate)
  branchA.getXmlFragment('default').get(0).setAttribute('level', 2)

  const branchB = new Y.Doc()
  Y.applyUpdate(branchB, baseUpdate)
  branchB.getXmlFragment('default').get(0).setAttribute('level', 3)

  const mergedAB = new Y.Doc()
  Y.applyUpdate(mergedAB, Y.encodeStateAsUpdate(branchA))
  Y.applyUpdate(mergedAB, Y.encodeStateAsUpdate(branchB))
  console.log('merged A-then-B level:', mergedAB.getXmlFragment('default').get(0).getAttribute('level'))

  const mergedBA = new Y.Doc()
  Y.applyUpdate(mergedBA, Y.encodeStateAsUpdate(branchB))
  Y.applyUpdate(mergedBA, Y.encodeStateAsUpdate(branchA))
  console.log('merged B-then-A level:', mergedBA.getXmlFragment('default').get(0).getAttribute('level'))
  console.log('(is it order-independent, and is either user ever told their change was silently dropped? -- no notification mechanism exists)')
}

console.log('\n=== TEST 4: one branch deletes a node while the other formats text inside it ===')
{
  const base = makeBase()
  const baseUpdate = Y.encodeStateAsUpdate(base)

  const branchA = new Y.Doc()
  Y.applyUpdate(branchA, baseUpdate)
  branchA.getXmlFragment('default').delete(0, 1) // delete the whole paragraph

  const branchB = new Y.Doc()
  Y.applyUpdate(branchB, baseUpdate)
  branchB.getXmlFragment('default').get(0).get(0).format(0, 4, { bold: true }) // format text inside that same paragraph

  const merged = new Y.Doc()
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(branchA))
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(branchB))
  console.log('merge did not throw. Resulting fragment length:', merged.getXmlFragment('default').length)
  console.log('(the paragraph is gone; the formatting op silently became a no-op on deleted content)')
}
