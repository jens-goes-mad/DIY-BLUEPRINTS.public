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

// One flattened dropdown covering both the legacy single-tenant branches
// ("legacy:<branch>") and every multi-tenant customer/document/version
// combo ("mt:<customerId>/<docId>@<versionName>") -- a cascading
// customer->document->version picker (like admin-mt.js's) would be more
// complete, but for testing this app against the new multi-tenant model
// a single flat list is enough, and keeps the legacy path exercisable too.
function currentDocKey() {
  return new URLSearchParams(window.location.search).get('doc') || 'legacy:master'
}

// Translates a dropdown key into the actual Hocuspocus room name. The
// legacy branch is folded back into the historical "default@branch" shape
// so collab-server's existing single-tenant parseDocumentName path is
// completely untouched; "mt:..." keys are passed straight through, since
// that's exactly the room-name shape collab-server's new tenant branch
// of parseDocumentName expects. Note the "~" (not "/") between
// customerId and docId -- documentName doubles as a fast-tier filename in
// collab-server's localStore.js, where a literal "/" would turn into an
// unintended (and nonexistent) nested directory.
function roomNameFor(docKey) {
  if (docKey.startsWith('legacy:')) return `${DOC_ID}@${docKey.slice('legacy:'.length)}`
  return docKey
}

async function fetchFlattenedDocEntries() {
  const entries = []

  try {
    const branches = await (await fetch(`${PERSISTENCE_URL}/api/branches`)).json()
    for (const b of branches.sort()) entries.push({ key: `legacy:${b}`, label: `(legacy single-tenant) ${b}` })
  } catch (err) {
    console.error('failed to load legacy branch list:', err.message)
  }

  try {
    const customers = await (await fetch(`${PERSISTENCE_URL}/api/mt/customers`)).json()
    for (const c of customers) {
      const docIds = await (
        await fetch(`${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(c.customerId)}/documents`)
      ).json()
      for (const docId of docIds) {
        const versions = await (
          await fetch(
            `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(c.customerId)}/documents/` +
              `${encodeURIComponent(docId)}/versions`,
          )
        ).json()
        for (const v of versions) {
          entries.push({
            key: `mt:${c.customerId}~${docId}@${v}`,
            label: `${c.displayName} / ${docId} / ${v}`,
          })
        }
      }
    }
  } catch (err) {
    console.error('failed to load multi-tenant document list:', err.message)
  }

  return entries
}

async function populateBranchDropdown(docKey) {
  const select = document.getElementById('branch-select')
  const entries = await fetchFlattenedDocEntries()
  if (!entries.some((e) => e.key === docKey)) entries.push({ key: docKey, label: docKey })

  select.innerHTML = ''
  for (const e of entries) {
    const option = document.createElement('option')
    option.value = e.key
    option.textContent = e.label
    option.selected = e.key === docKey
    select.appendChild(option)
  }

  // A branch/version is a different live-editing "room" (see
  // collab-server's parseDocumentName) -- switching means reconnecting
  // from scratch, which a full navigation gives us for free, no manual
  // teardown of the editor/provider needed.
  select.addEventListener('change', () => {
    const url = new URL(window.location.href)
    url.searchParams.set('doc', select.value)
    url.searchParams.delete('branch')
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
  const docKey = currentDocKey()
  await populateBranchDropdown(docKey)
  const roomName = roomNameFor(docKey)

  const res = await fetch(`${HTTP_URL}/api/whoami`)
  const { userId } = await res.json()
  document.getElementById('user-badge').textContent = `You are: ${userId} — editing "${roomName}"`

  const ydoc = new Y.Doc()
  const provider = new HocuspocusProvider({
    url: WS_URL,
    name: roomName,
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
