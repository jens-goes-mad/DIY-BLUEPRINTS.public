import fs from 'node:fs/promises'
import path from 'node:path'

const LIVE_STORE_PATH = process.env.LIVE_STORE_PATH || '/data/live'

// Safety-net compaction trigger for a long-running session that never fully
// empties out (so afterUnloadDocument never fires): if the delta log grows
// past this many bytes, compact immediately regardless of connections.
export const COMPACT_LOG_BYTES = Number(process.env.COMPACT_LOG_BYTES || 5 * 1024 * 1024)

function basePath(docId) {
  return path.join(LIVE_STORE_PATH, `${docId}.base.ydoc`)
}

function logPath(docId) {
  return path.join(LIVE_STORE_PATH, `${docId}.updates.log`)
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function frameChunk(bytes) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([len, Buffer.from(bytes)])
}

function splitChunks(buf) {
  const chunks = []
  let offset = 0
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    offset += 4
    chunks.push(buf.subarray(offset, offset + len))
    offset += len
  }
  return chunks
}

/**
 * Returns the sequence of update chunks needed to reconstruct the document
 * (a compacted base, if one exists, followed by every delta appended since),
 * or null if nothing is stored yet for this docId. Applying each chunk in
 * order onto a fresh Y.Doc reconstructs the full current state.
 */
export async function loadLocal(docId) {
  const base = await readIfExists(basePath(docId))
  const log = await readIfExists(logPath(docId))

  if (!base && !log) return null

  const chunks = base ? [base] : []
  if (log && log.length > 0) chunks.push(...splitChunks(log))
  return chunks
}

/**
 * Appends a single delta update (NOT the full document -- see server.js,
 * which computes this relative to the last-saved state vector) to this
 * doc's log. Returns the log's size after appending, so the caller can
 * decide whether to trigger compaction.
 */
export async function appendDelta(docId, deltaBytes) {
  await fs.mkdir(LIVE_STORE_PATH, { recursive: true })
  await fs.appendFile(logPath(docId), frameChunk(deltaBytes))
  const stat = await fs.stat(logPath(docId))
  return stat.size
}

/**
 * Collapses the base + all logged deltas into one new full-state base
 * snapshot, and truncates the log back to empty. Cheap to call once nobody
 * is actively editing (afterUnloadDocument) or the log has grown past
 * COMPACT_LOG_BYTES.
 */
export async function compact(docId, fullStateBytes) {
  await fs.mkdir(LIVE_STORE_PATH, { recursive: true })
  await fs.writeFile(basePath(docId), fullStateBytes)
  await fs.writeFile(logPath(docId), Buffer.alloc(0))
}

/**
 * Every documentName that has anything on disk in the fast tier, regardless
 * of whether collab-server currently has it loaded in memory. Used at
 * startup to find documents that were mid-checkpoint-retry (or simply
 * edited) when the process was last stopped -- their in-memory dirty
 * tracking doesn't survive a restart, but their bytes on disk do, and
 * without this scan nothing would resume retrying them until someone
 * happens to reconnect to that exact document again.
 */
export async function listLocalDocuments() {
  await fs.mkdir(LIVE_STORE_PATH, { recursive: true })
  const files = await fs.readdir(LIVE_STORE_PATH)
  const names = new Set()
  for (const file of files) {
    if (file.endsWith('.base.ydoc')) names.add(file.slice(0, -'.base.ydoc'.length))
    else if (file.endsWith('.updates.log')) names.add(file.slice(0, -'.updates.log'.length))
  }
  return [...names]
}
