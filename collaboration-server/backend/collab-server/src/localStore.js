import fs from 'node:fs/promises'
import path from 'node:path'

const LIVE_STORE_PATH = process.env.LIVE_STORE_PATH || '/data/live'

export async function saveLocal(docId, bytes) {
  await fs.mkdir(LIVE_STORE_PATH, { recursive: true })
  await fs.writeFile(path.join(LIVE_STORE_PATH, `${docId}.ydoc`), bytes)
}

export async function loadLocal(docId) {
  try {
    return await fs.readFile(path.join(LIVE_STORE_PATH, `${docId}.ydoc`))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
