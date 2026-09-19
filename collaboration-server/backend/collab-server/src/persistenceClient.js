const PERSISTENCE_URL = process.env.PERSISTENCE_URL || 'http://persistence-service:8080'
const BRANCH = process.env.BRANCH || 'master'

export async function loadSnapshot(docId, branch = BRANCH) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`)
  if (!res.ok) throw new Error(`persistence-service load failed: ${res.status}`)
  const body = await res.json()
  if (!body.ydoc) return null
  return Buffer.from(body.ydoc, 'base64')
}

export async function saveSnapshot(docId, ydocBytes, markdown, changelog, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${BRANCH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ydoc: Buffer.from(ydocBytes).toString('base64'),
      markdown,
      changelog,
      author,
    }),
  })
  if (!res.ok) throw new Error(`persistence-service save failed: ${res.status}`)
}

export async function findMergeBase(branchA, branchB) {
  const res = await fetch(`${PERSISTENCE_URL}/api/branches/merge-base?a=${branchA}&b=${branchB}`)
  if (!res.ok) throw new Error(`persistence-service merge-base lookup failed: ${res.status}`)
  const body = await res.json()
  return body.commitId
}

export async function commitMerge(docId, targetBranch, sourceBranch, ydocBytes, markdown, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      targetBranch,
      sourceBranch,
      ydoc: Buffer.from(ydocBytes).toString('base64'),
      markdown,
      author,
    }),
  })
  if (!res.ok) throw new Error(`persistence-service merge commit failed: ${res.status}`)
  return res.json()
}
