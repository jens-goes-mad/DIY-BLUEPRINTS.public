import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import Image from '@tiptap/extension-image'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const HTTP_URL = import.meta.env.VITE_COLLAB_HTTP_URL || 'http://localhost:3000'
const WS_URL = import.meta.env.VITE_COLLAB_WS_URL || 'ws://localhost:1234'
const PERSISTENCE_URL = import.meta.env.VITE_PERSISTENCE_URL || 'http://localhost:8081'
const DOC_ID = 'default'

const CURSOR_COLORS = ['#f44336', '#2196f3', '#4caf50', '#ff9800', '#9c27b0', '#009688']

function currentBranch() {
  return new URLSearchParams(window.location.search).get('branch') || 'master'
}

async function populateBranchDropdown(branch) {
  const select = document.getElementById('branch-select')
  try {
    const res = await fetch(`${PERSISTENCE_URL}/api/branches`)
    const branches = await res.json()
    if (!branches.includes(branch)) branches.push(branch)
    select.innerHTML = ''
    for (const b of branches.sort()) {
      const option = document.createElement('option')
      option.value = b
      option.textContent = b
      option.selected = b === branch
      select.appendChild(option)
    }
  } catch (err) {
    console.error('failed to load branch list:', err.message)
    select.innerHTML = `<option value="${branch}" selected>${branch}</option>`
  }

  // A branch is a different live-editing "room" (see collab-server's
  // parseDocumentName) -- switching means reconnecting from scratch, which
  // a full navigation gives us for free, no manual teardown of the
  // editor/provider needed.
  select.addEventListener('change', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('branch', select.value)
    window.location.href = url.toString()
  })
}

// Uploads to collab-server, which proxies to Artifact Keeper server-side
// (the admin credential never reaches the browser) and hands back a public,
// anonymously-downloadable URL -- that URL string is the only thing that
// ends up in the document. The image itself never touches Yjs or git.
async function uploadImage(file) {
  const res = await fetch(`${HTTP_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  })
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`)
  const body = await res.json()
  return body.url
}

async function main() {
  const branch = currentBranch()
  await populateBranchDropdown(branch)

  const res = await fetch(`${HTTP_URL}/api/whoami`)
  const { userId } = await res.json()
  document.getElementById('user-badge').textContent = `You are: ${userId} — editing branch "${branch}"`

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name: `${DOC_ID}@${branch}`,
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
      // allowBase64 stays at its default (false): dropped images must go
      // through uploadImage and become a URL reference, never inline binary
      // in the document -- see STATE.md.
      Image,
    ],
    onTransaction: () => updateToolbarState(editor),
    onSelectionUpdate: () => updateToolbarState(editor),
    editorProps: {
      // Drag-and-drop is the intuitive path for inserting images (vs. a
      // toolbar button/URL prompt) -- intercept it here, before TipTap's
      // default drop handling, upload the file, then insert an image node
      // referencing the uploaded URL once the upload resolves.
      handleDrop(view, event, _slice, moved) {
        if (moved) return false // internal drag-reorder within the doc, not a file drop
        const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
        if (files.length === 0) return false

        event.preventDefault()
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        const pos = coords ? coords.pos : view.state.selection.from

        // Move the cursor to the drop position synchronously, before the
        // upload's async gap. Uploading takes real time (server round trip
        // to Artifact Keeper); inserting at a position captured before that
        // gap risks it having drifted from further edits/doc growth in the
        // meantime (verified directly -- a stale position landed the image
        // inside an unrelated existing node instead of at the drop point).
        // Inserting at the *current* selection when the upload resolves,
        // via TipTap's own setImage command, sidesteps that entirely.
        editor.chain().focus().setTextSelection(pos).run()

        for (const file of files) {
          uploadImage(file)
            .then((url) => {
              editor.chain().focus().setImage({ src: url, alt: file.name }).run()
            })
            .catch((err) => console.error('image upload failed:', err.message))
        }
        return true
      },
    },
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
