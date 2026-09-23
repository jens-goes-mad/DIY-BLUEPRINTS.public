import { Server } from '@hocuspocus/server'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import * as Y from 'yjs'
import express from 'express'
import cors from 'cors'
import { schema } from './schema.js'
import { createMarkdownSerializer } from './markdown.js'
import { loadSnapshot, saveSnapshot, loadTenantSnapshot, saveTenantSnapshot } from './persistenceClient.js'
import { loadLocal, appendDelta, compact, COMPACT_LOG_BYTES, listLocalDocuments } from './localStore.js'
import { mergeBranches } from './mergeBranches.js'
import { uploadAsset } from './artifactKeeperClient.js'

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

// documentName -> { document, docId, branch, dirty, contributors, lastSavedStateVector }
// lastSavedStateVector tracks what's already on disk (base+log), so each
// fast-tier save only has to write what changed since then, not the whole
// document -- essential once a document is hundreds of pages, where
// re-encoding the full state on every ~8s debounce would mean rewriting the
// entire thing repeatedly during any active editing session.
const liveDocuments = new Map()

// Hocuspocus's documentName is the identity of a live collaboration "room" --
// everyone connected to the same name shares one Y.Doc. A branch is encoded
// directly into that identity ("default@feature-x") rather than treated as a
// per-connection parameter, because it has to be: two users can't
// collaboratively co-edit two diverged branches as if they were the same
// live document. Old-style plain docIds (no "@") default to "master", so
// nothing that connected before this existed breaks.
//
// Multi-tenant rooms are distinguished by an "mt:" prefix ("mt:acme-corp~
// onboarding-guide@review-q3") rather than overloading the single-tenant
// shape, so the long-working single-tenant path below is untouched by this.
// "~" (not "/") separates customerId/docId deliberately -- documentName is
// used directly as a fast-tier filename in localStore.js's path.join calls,
// so a literal "/" here would silently turn into an unintended nested
// directory that doesn't exist (found via real testing: onStoreDocument
// failed with ENOENT until this was changed). customerId/docId are git-
// URL-friendly slugs and never contain "~" in practice.
// Language isn't part of the room name -- fixed to LANGUAGE for now (no
// multi-language editing UI yet, see STATE.md); revisit if/when that's built.
const LANGUAGE = 'en'

function parseDocumentName(documentName) {
  if (documentName.startsWith('mt:')) {
    const rest = documentName.slice('mt:'.length) // customerId~docId@versionName
    const at = rest.indexOf('@')
    const path = at === -1 ? rest : rest.slice(0, at)
    const versionName = at === -1 ? 'master' : rest.slice(at + 1)
    const sep = path.indexOf('~')
    const customerId = sep === -1 ? path : path.slice(0, sep)
    const docId = sep === -1 ? '' : path.slice(sep + 1)
    return { tenant: true, customerId, docId, branch: versionName, language: LANGUAGE }
  }
  const at = documentName.indexOf('@')
  if (at === -1) return { tenant: false, docId: documentName, branch: 'master' }
  return { tenant: false, docId: documentName.slice(0, at), branch: documentName.slice(at + 1) }
}

const httpApp = express()
httpApp.use(cors())
httpApp.use(express.json())

httpApp.get('/api/whoami', (req, res) => {
  userCounter += 1
  res.json({ userId: `User-${userCounter}` })
})

httpApp.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// The image/binary itself never touches Yjs or git (see STATE.md) -- the
// browser posts raw bytes here, this proxies the upload to Artifact Keeper
// (keeping its admin credential server-side, never exposed to the browser),
// and returns a public, anonymously-downloadable URL. Only that URL string
// ends up in the document, via TipTap's Image node (src/alt/title only).
httpApp.post('/api/upload', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const filename = req.header('X-Filename') || 'upload.bin'
  const contentType = req.header('Content-Type') || 'application/octet-stream'
  try {
    const url = await uploadAsset(filename, req.body, contentType)
    res.json({ url })
  } catch (err) {
    console.error(`[upload] failed for "${filename}":`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// Returns { merged: false, conflicts: [...] } without touching git if
// detectConflicts finds anything (see conflicts.js for exactly what
// counts); otherwise performs the CRDT merge and commits it, returning
// { merged: true, commitId, parentCount }.
httpApp.post('/api/documents/:docId/merge', async (req, res) => {
  const { docId } = req.params
  const { sourceBranch, targetBranch, author } = req.body
  if (!sourceBranch || !targetBranch) {
    return res.status(400).json({ error: 'sourceBranch and targetBranch are required' })
  }
  try {
    const result = await mergeBranches(docId, sourceBranch, targetBranch, author || 'unknown')
    res.json(result)
  } catch (err) {
    console.error(`[merge] failed for "${docId}" (${sourceBranch} -> ${targetBranch}):`, err.message)
    res.status(500).json({ error: err.message })
  }
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

  if (entry.tenant) {
    await saveTenantSnapshot(entry.customerId, entry.docId, entry.branch, entry.language, ydocBytes, markdown, changelog, contributors)
  } else {
    await saveSnapshot(entry.docId, entry.branch, ydocBytes, markdown, changelog, contributors)
  }
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
      ...parseDocumentName(documentName),
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
      const gitBytes = entry.tenant
        ? await loadTenantSnapshot(entry.customerId, entry.docId, entry.branch, entry.language)
        : await loadSnapshot(entry.docId, entry.branch)
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
    // Only drop the entry once git has actually caught up (checkpointToGit
    // clears entry.dirty itself, only on success). A still-dirty entry
    // here means the final checkpoint attempt above just failed (or
    // persistence-service was already down) -- the unsynced edits are
    // safe in the fast tier's disk log, but git is behind, and previously
    // nothing would ever retry once the last viewer left: the entry got
    // deleted unconditionally, so the periodic sweep (which only walks
    // liveDocuments) had nothing left to find. Keeping the entry alive
    // means that same 60s sweep keeps retrying it with zero viewers
    // connected -- logged every attempt -- until it lands or a reconnect
    // replaces this entry via a fresh onLoadDocument. Documents that
    // never catch up (a sustained persistence-service outage) do stay
    // resident in memory holding their Y.Doc until they do; an acceptable
    // trade for not silently abandoning a pending git write.
    if (!entry || !entry.dirty) {
      liveDocuments.delete(documentName)
    }
  },
})

hocuspocus.listen()

// The periodic checkpoint sweep only ever looks at liveDocuments, and that
// map is entirely in-memory -- a collab-server restart loses it completely,
// dirty-tracking included, even though the fast tier's files on disk are
// untouched. Without this, a document that was mid-retry (persistence-service
// down, say) when the process stopped would just sit there un-checkpointed
// indefinitely: nothing resumes retrying it until someone happens to
// reconnect to that exact document again. Scanning the fast tier at startup
// and seeding liveDocuments from whatever's already on disk closes that gap
// -- the very next periodic tick picks these up exactly like any other
// dirty document, no reconnect required. Mirrors onLoadDocument's own
// fast-tier-recovery path (same dirty=true, contributors=['restored']
// convention used for crash recovery there).
async function reconcileFastTierOnStartup() {
  let documentNames
  try {
    documentNames = await listLocalDocuments()
  } catch (err) {
    console.error('[startup-reconcile] failed to list fast-tier documents:', err.message)
    return
  }

  for (const documentName of documentNames) {
    if (liveDocuments.has(documentName)) continue // a connection already beat this scan to it
    try {
      const chunks = await loadLocal(documentName)
      if (!chunks || chunks.length === 0) continue
      const doc = new Y.Doc()
      for (const chunk of chunks) Y.applyUpdate(doc, chunk)
      liveDocuments.set(documentName, {
        document: doc,
        ...parseDocumentName(documentName),
        dirty: true,
        contributors: new Set(['restored']),
        lastSavedStateVector: Y.encodeStateVector(doc),
        changelog: [],
      })
      console.log(`[startup-reconcile] found pending fast-tier data for "${documentName}", queued for checkpoint`)
    } catch (err) {
      console.error(`[startup-reconcile] failed to load "${documentName}":`, err.message)
    }
  }
}

reconcileFastTierOnStartup()

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] swallowed to keep collab-server alive:', err)
})
