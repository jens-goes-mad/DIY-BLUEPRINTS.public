import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const HTTP_URL = import.meta.env.VITE_COLLAB_HTTP_URL || 'http://localhost:3000'
const WS_URL = import.meta.env.VITE_COLLAB_WS_URL || 'ws://localhost:1234'
const DOC_ID = 'default'

const CURSOR_COLORS = ['#f44336', '#2196f3', '#4caf50', '#ff9800', '#9c27b0', '#009688']

async function main() {
  const res = await fetch(`${HTTP_URL}/api/whoami`)
  const { userId } = await res.json()
  document.getElementById('user-badge').textContent = `You are: ${userId}`

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name: DOC_ID,
    document: ydoc,
    parameters: { userId },
  })

  const userNumber = parseInt(userId.split('-')[1], 10)
  const color = CURSOR_COLORS[userNumber % CURSOR_COLORS.length]

  const editor = new Editor({
    element: document.getElementById('editor'),
    extensions: [
      // Yjs is the single source of undo history here, so StarterKit's
      // own history extension has to be disabled or the two fight each other.
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCursor.configure({
        provider,
        user: { name: userId, color },
      }),
    ],
    onTransaction: () => updateToolbarState(editor),
    onSelectionUpdate: () => updateToolbarState(editor),
  })

  buildToolbar(editor)
  updateToolbarState(editor)
}

const TOOLBAR_BUTTONS = [
  { action: 'bold', label: 'B' },
  { action: 'italic', label: 'I' },
  { action: 'strike', label: 'S' },
  { action: 'code', label: '</>' },
  { action: 'divider' },
  { action: 'heading1', label: 'H1' },
  { action: 'heading2', label: 'H2' },
  { action: 'heading3', label: 'H3' },
  { action: 'paragraph', label: 'P' },
  { action: 'divider' },
  { action: 'bulletList', label: '• List' },
  { action: 'orderedList', label: '1. List' },
  { action: 'blockquote', label: '“ Quote' },
  { action: 'codeBlock', label: '{ }' },
  { action: 'horizontalRule', label: '—' },
]

function runAction(editor, action) {
  const chain = editor.chain().focus()
  switch (action) {
    case 'bold': return chain.toggleBold().run()
    case 'italic': return chain.toggleItalic().run()
    case 'strike': return chain.toggleStrike().run()
    case 'code': return chain.toggleCode().run()
    case 'heading1': return chain.toggleHeading({ level: 1 }).run()
    case 'heading2': return chain.toggleHeading({ level: 2 }).run()
    case 'heading3': return chain.toggleHeading({ level: 3 }).run()
    case 'paragraph': return chain.setParagraph().run()
    case 'bulletList': return chain.toggleBulletList().run()
    case 'orderedList': return chain.toggleOrderedList().run()
    case 'blockquote': return chain.toggleBlockquote().run()
    case 'codeBlock': return chain.toggleCodeBlock().run()
    case 'horizontalRule': return chain.setHorizontalRule().run()
  }
}

function isActive(editor, action) {
  switch (action) {
    case 'heading1': return editor.isActive('heading', { level: 1 })
    case 'heading2': return editor.isActive('heading', { level: 2 })
    case 'heading3': return editor.isActive('heading', { level: 3 })
    default: return editor.isActive(action)
  }
}

function buildToolbar(editor) {
  const toolbar = document.getElementById('toolbar')
  toolbar.innerHTML = ''

  for (const button of TOOLBAR_BUTTONS) {
    if (button.action === 'divider') {
      const divider = document.createElement('span')
      divider.className = 'toolbar-divider'
      toolbar.appendChild(divider)
      continue
    }

    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = button.label
    el.dataset.action = button.action
    el.addEventListener('click', () => runAction(editor, button.action))
    toolbar.appendChild(el)
  }
}

function updateToolbarState(editor) {
  const toolbar = document.getElementById('toolbar')
  for (const el of toolbar.querySelectorAll('button')) {
    el.classList.toggle('is-active', isActive(editor, el.dataset.action))
  }
}

main()
