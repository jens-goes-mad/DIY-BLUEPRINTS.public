const PERSISTENCE_URL = process.env.PERSISTENCE_URL || 'http://persistence-service:8080'
const DEFAULT_BRANCH = process.env.BRANCH || 'master'

export async function loadSnapshot(docId, branch = DEFAULT_BRANCH) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`)
  if (!res.ok) throw new Error(`persistence-service load failed: ${res.status}`)
  const body = await res.json()
  if (!body.ydoc) return null
  return Buffer.from(body.ydoc, 'base64')
}

export async function saveSnapshot(docId, branch, ydocBytes, markdown, changelog, author) {
  const res = await fetch(`${PERSISTENCE_URL}/api/documents/${docId}?branch=${branch}`, {
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

// Multi-tenant counterparts of loadSnapshot/saveSnapshot above, targeting
// GitDocumentStorageService via MultiTenantAdminController's content
// endpoints (customer/document/version/language) instead of the
// single-tenant docId@branch repo. Kept as separate functions rather than
// branching inside loadSnapshot/saveSnapshot so the long-working
// single-tenant path stays untouched.
export async function loadTenantSnapshot(customerId, docId, versionName, language) {
  const url =
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionName)}/languages/` +
    `${encodeURIComponent(language)}/content`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`persistence-service tenant load failed: ${res.status}`)
  const body = await res.json()
  if (!body.ydoc) return null
  return Buffer.from(body.ydoc, 'base64')
}

export async function saveTenantSnapshot(customerId, docId, versionName, language, ydocBytes, markdown, changelog, author) {
  const url =
    `${PERSISTENCE_URL}/api/mt/customers/${encodeURIComponent(customerId)}/documents/` +
    `${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionName)}/languages/` +
    `${encodeURIComponent(language)}/content`
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ydoc: Buffer.from(ydocBytes).toString('base64'),
      markdown,
      changelog,
      author,
    }),
  })
  if (!res.ok) throw new Error(`persistence-service tenant save failed: ${res.status}`)
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
