import { Server } from '@hocuspocus/server'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'
import express from 'express'
import cors from 'cors'
import { schema } from './schema.js'
import { createMarkdownSerializer } from './markdown.js'
import { loadSnapshot, saveSnapshot } from './persistenceClient.js'
import { loadLocal, saveLocal } from './localStore.js'

const WS_PORT = process.env.WS_PORT || 1234
const HTTP_PORT = process.env.HTTP_PORT || 3000
const YJS_FIELD = 'default'

// Git commits are an audit trail, not a live backup -- every commit stores the
// *full* document (see STATE.md), so committing on every ~8s debounce would
// flood history with near-duplicate snapshots. The fast tier (local volume,
// written on every debounce) is what actually protects against data loss;
// git only needs to catch up periodically.
const GIT_CHECKPOINT_INTERVAL_MS = Number(process.env.GIT_CHECKPOINT_INTERVAL_MS || 60_000)

const markdownSerializer = createMarkdownSerializer()

let userCounter = 0

// documentName -> { document: Y.Doc, dirty: boolean, contributors: Set<string> }
const liveDocuments = new Map()

const httpApp = express()
httpApp.use(cors())

httpApp.get('/api/whoami', (req, res) => {
  userCounter += 1
  res.json({ userId: `User-${userCounter}` })
})

httpApp.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

httpApp.listen(HTTP_PORT, () => {
  console.log(`collab-server HTTP API listening on :${HTTP_PORT}`)
})

async function checkpointToGit(documentName, entry) {
  const ydocBytes = Y.encodeStateAsUpdate(entry.document)
  const docJSON = yDocToProsemirrorJSON(entry.document, YJS_FIELD)
  const node = schema.nodeFromJSON(docJSON)
  const markdown = markdownSerializer.serialize(node)
  const contributors = [...entry.contributors].join(', ') || 'unknown'

  await saveSnapshot(documentName, ydocBytes, markdown, contributors)
  entry.dirty = false
  entry.contributors.clear()
  console.log(`git-checkpoint -> "${documentName}" (edited by ${contributors})`)
}

setInterval(() => {
  for (const [documentName, entry] of liveDocuments) {
    if (!entry.dirty) continue
    checkpointToGit(documentName, entry).catch((err) => {
      console.error(`[git-checkpoint] failed for "${documentName}":`, err.message)
    })
  }
}, GIT_CHECKPOINT_INTERVAL_MS)

const hocuspocus = Server.configure({
  port: WS_PORT,
  debounce: 8000,
  maxDebounce: 30000,

  onConnect: async ({ documentName, requestParameters }) => {
    const userId = requestParameters.get('userId') || 'unknown'
    console.log(`connect -> document "${documentName}" as ${userId}`)
    return { userId }
  },

  onLoadDocument: async ({ documentName, document }) => {
    const entry = { document, dirty: false, contributors: new Set(['restored']) }
    liveDocuments.set(documentName, entry)

    // Fast tier first: it's always at least as fresh as git, since every
    // debounced edit lands there immediately while git only catches up
    // periodically. Loading from the fast tier means, by definition, that
    // git might be behind -- mark it dirty right away so the checkpoint
    // sweep picks it up even if nobody edits anything further before the
    // next interval. Without this, a crash that left git behind the local
    // tier would never get reconciled until someone happened to type again.
    try {
      const localBytes = await loadLocal(documentName)
      if (localBytes) {
        const doc = new Y.Doc()
        Y.applyUpdate(doc, localBytes)
        entry.dirty = true
        return doc
      }
    } catch (err) {
      console.error(`[onLoadDocument] local store read failed for "${documentName}":`, err.message)
    }

    try {
      const gitBytes = await loadSnapshot(documentName)
      if (!gitBytes) return
      const doc = new Y.Doc()
      Y.applyUpdate(doc, gitBytes)
      return doc
    } catch (err) {
      console.error(`[onLoadDocument] git load failed for "${documentName}":`, err.message)
    }
  },

  // The fast tier: every debounced change is written straight to the local
  // volume. This alone is what makes a collab-server crash/restart safe --
  // git catching up is a separate, much slower concern (see checkpointToGit).
  onStoreDocument: async ({ documentName, document, context }) => {
    const author = context?.userId || 'unknown'
    try {
      await saveLocal(documentName, Y.encodeStateAsUpdate(document))
      const entry = liveDocuments.get(documentName)
      if (entry) {
        entry.dirty = true
        entry.contributors.add(author)
      }
    } catch (err) {
      console.error(`[onStoreDocument] local save failed for "${documentName}":`, err.message)
    }
  },

  afterUnloadDocument: async ({ documentName }) => {
    const entry = liveDocuments.get(documentName)
    if (entry?.dirty) {
      await checkpointToGit(documentName, entry).catch((err) => {
        console.error(`[afterUnloadDocument] final git checkpoint failed for "${documentName}":`, err.message)
      })
    }
    liveDocuments.delete(documentName)
  },
})

hocuspocus.listen()

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] swallowed to keep collab-server alive:', err)
})
