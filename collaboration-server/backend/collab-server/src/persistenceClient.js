const PERSISTENCE_URL = process.env.PERSISTENCE_URL || 'http://persistence-service:8080'
const BRANCH = process.env.BRANCH || 'master'

export async function loadSnapshot(docId) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${BRANCH}`)
  if (!res.ok) throw new Error(`persistence-service load failed: ${res.status}`)
  const body = await res.json()
  if (!body.ydoc) return null
  return Buffer.from(body.ydoc, 'base64')
}

export async function saveSnapshot(docId, ydocBytes, markdown, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${BRANCH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ydoc: Buffer.from(ydocBytes).toString('base64'),
      markdown,
      author,
    }),
  })
  if (!res.ok) throw new Error(`persistence-service save failed: ${res.status}`)
}
