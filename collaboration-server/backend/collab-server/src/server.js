import { Server } from '@hocuspocus/server'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'
import express from 'express'
import cors from 'cors'
import { schema } from './schema.js'
import { createMarkdownSerializer } from './markdown.js'
import { loadSnapshot, saveSnapshot } from './persistenceClient.js'
import { loadLocal, appendDelta, compact, COMPACT_LOG_BYTES } from './localStore.js'

const WS_PORT = process.env.WS_PORT || 1234
const HTTP_PORT = process.env.HTTP_PORT || 3000
const YJS_FIELD = 'default'

// Git commits are an audit trail, not a live backup -- every commit stores the
// *full* document (see STATE.md), so committing on every ~8s debounce would
// flood history with near-duplicate snapshots. The fast tier (local volume)
// is what actually protects against data loss; git only needs to catch up
// periodically.
const GIT_CHECKPOINT_INTERVAL_MS = Number(process.env.GIT_CHECKPOINT_INTERVAL_MS || 60_000)

const markdownSerializer = createMarkdownSerializer()

let userCounter = 0

// documentName -> { document, dirty, contributors, lastSavedStateVector }
// lastSavedStateVector tracks what's already on disk (base+log), so each
// fast-tier save only has to write what changed since then, not the whole
// document -- essential once a document is hundreds of pages, where
// re-encoding the full state on every ~8s debounce would mean rewriting the
// entire thing repeatedly during any active editing session.
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

  // One JSON line per save since the previous commit, each carrying that
  // save's own delta -- not the merged/compacted result. This is what makes
  // "decode any past chunk" and per-user attribution survive a checkpoint:
  // once these are committed, compacting the fast tier's log afterwards is
  // safe, because the individual chunks are now durable elsewhere.
  const changelog = entry.changelog.map((e) => JSON.stringify(e)).join('\n')

  await saveSnapshot(documentName, ydocBytes, markdown, changelog, contributors)
  entry.dirty = false
  entry.contributors.clear()
  entry.changelog = []
  console.log(`git-checkpoint -> "${documentName}" (edited by ${contributors})`)
}

// Collapses the fast tier's base+log into one fresh base and truncates the
// log. Cheap to call whenever nobody is actively mid-edit (all connections
// closed) or as a safety net once the log has grown past COMPACT_LOG_BYTES
// for a session that never fully empties out.
async function compactNow(documentName, entry) {
  const fullState = Y.encodeStateAsUpdate(entry.document)
  await compact(documentName, fullState)
  entry.lastSavedStateVector = Y.encodeStateVector(entry.document)
  console.log(`compact -> "${documentName}" (${fullState.length} bytes)`)
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
    const entry = {
      document,
      dirty: false,
      contributors: new Set(['restored']),
      lastSavedStateVector: null,
      changelog: [], // {author, timestamp, delta} since the last git checkpoint
    }
    liveDocuments.set(documentName, entry)

    // Fast tier first: it's always at least as fresh as git, since every
    // debounced edit lands there immediately while git only catches up
    // periodically. Loading from the fast tier means, by definition, that
    // git might be behind -- mark it dirty right away so the checkpoint
    // sweep picks it up even if nobody edits anything further before the
    // next interval.
    try {
      const chunks = await loadLocal(documentName)
      if (chunks && chunks.length > 0) {
        const doc = new Y.Doc()
        for (const chunk of chunks) {
          Y.applyUpdate(doc, chunk)
        }
        entry.lastSavedStateVector = Y.encodeStateVector(doc)
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
      entry.lastSavedStateVector = Y.encodeStateVector(doc)
      return doc
    } catch (err) {
      console.error(`[onLoadDocument] git load failed for "${documentName}":`, err.message)
    }
  },

  // The fast tier: every debounced change appends only what's new since the
  // last save (a delta, not the whole document) to the local volume. This is
  // what makes a collab-server crash/restart safe; git catching up is a
  // separate, much slower concern (see checkpointToGit).
  onStoreDocument: async ({ documentName, document, context }) => {
    const author = context?.userId || 'unknown'
    const entry = liveDocuments.get(documentName)
    try {
      const delta = entry?.lastSavedStateVector
        ? Y.encodeStateAsUpdate(document, entry.lastSavedStateVector)
        : Y.encodeStateAsUpdate(document)

      const logSize = await appendDelta(documentName, delta)

      if (entry) {
        entry.lastSavedStateVector = Y.encodeStateVector(document)
        entry.dirty = true
        entry.contributors.add(author)
        entry.changelog.push({
          author,
          timestamp: Date.now(),
          delta: Buffer.from(delta).toString('base64'),
        })
      }

      if (logSize > COMPACT_LOG_BYTES && entry) {
        await compactNow(documentName, entry)
      }
    } catch (err) {
      console.error(`[onStoreDocument] local save failed for "${documentName}":`, err.message)
    }
  },

  // "All users logged out" -- the natural, cheap point to flatten the fast
  // tier's base+log into one fresh base, since nobody is actively editing
  // and the document is about to leave memory anyway.
  afterUnloadDocument: async ({ documentName }) => {
    const entry = liveDocuments.get(documentName)
    if (entry) {
      try {
        await compactNow(documentName, entry)
      } catch (err) {
        console.error(`[afterUnloadDocument] compaction failed for "${documentName}":`, err.message)
      }
      if (entry.dirty) {
        await checkpointToGit(documentName, entry).catch((err) => {
          console.error(`[afterUnloadDocument] final git checkpoint failed for "${documentName}":`, err.message)
        })
      }
    }
    liveDocuments.delete(documentName)
  },
})

hocuspocus.listen()

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] swallowed to keep collab-server alive:', err)
})
