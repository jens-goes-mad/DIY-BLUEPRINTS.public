import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { createMarkdownSerializer, createMarkdownParser } from '../../backend/collab-server/src/markdown.js'

const schema = getSchema([StarterKit])

const docJSON = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title Here' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Plain, ' },
        { type: 'text', marks: [{ type: 'bold' }], text: 'bold' },
        { type: 'text', text: ', ' },
        { type: 'text', marks: [{ type: 'italic' }], text: 'italic' },
        { type: 'text', text: ', ' },
        { type: 'text', marks: [{ type: 'strike' }], text: 'struck' },
        { type: 'text', text: ', ' },
        { type: 'text', marks: [{ type: 'code' }], text: 'code()' },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quoted line.' }] }],
    },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'const x = 1;\nconsole.log(x);' }] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] },
      ],
    },
    {
      type: 'orderedList',
      attrs: { start: 3 },
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'beta' }] }] },
      ],
    },
    { type: 'horizontalRule' },
    { type: 'paragraph', content: [{ type: 'text', text: 'end' }] },
  ],
}

const doc = schema.nodeFromJSON(docJSON)
const serializer = createMarkdownSerializer()
const markdown = serializer.serialize(doc)

console.log('=== MARKDOWN OUTPUT ===')
console.log(markdown)

const parser = createMarkdownParser(schema)
const reparsedDoc = parser.parse(markdown)

console.log('=== ROUNDTRIP MATCH ===')
const originalJSON = JSON.stringify(doc.toJSON())
const reparsedJSON = JSON.stringify(reparsedDoc.toJSON())
console.log(originalJSON === reparsedJSON ? 'IDENTICAL' : 'DIFFERENT')

if (originalJSON !== reparsedJSON) {
  console.log('=== ORIGINAL JSON ===')
  console.log(JSON.stringify(doc.toJSON(), null, 2))
  console.log('=== REPARSED JSON ===')
  console.log(JSON.stringify(reparsedDoc.toJSON(), null, 2))
}
